import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
	AtomicApprovalLedger,
	InMemoryApprovalLedger,
	SetupEngineError,
	SETUP_ENGINE_SCHEMA_VERSION,
	applyMutationPlan,
	createAtomicSetupStateStore,
	createMutationPlan,
	createSetupEngine,
	fingerprint,
	inspectSetup,
	rollbackMutationPlan,
	verifyMutationPlan,
	verifyMutationReadback
} from './setup-engine.mjs';

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

class FakeBase {
	constructor(state) {
		this.state = clone(state);
		this.inspectCalls = 0;
		this.applyCalls = 0;
		this.rollbackCalls = 0;
		this.failInspect = false;
		this.failApply = false;
		this.failReadback = false;
		this.failReadbackAfterApplyCalls = Number.POSITIVE_INFINITY;
	}

	async inspect() {
		this.inspectCalls += 1;
		if (
			this.failInspect ||
			(this.failReadback && this.applyCalls >= this.failReadbackAfterApplyCalls)
		) {
			throw new Error('fake provider read failure');
		}
		return { state: clone(this.state), list_complete: true };
	}

	async applyStep({ plan }) {
		this.applyCalls += 1;
		if (this.failApply) throw new Error('fake provider apply failure');
		this.state = clone(plan.after);
		return { resource_id: plan.target.resource_id ?? 'created-resource', status: 'accepted' };
	}

	async rollbackStep({ plan }) {
		this.rollbackCalls += 1;
		this.state = clone(plan.before);
		return { status: 'restored' };
	}
}

class FakeCloudflare extends FakeBase {
	constructor(state) {
		super(state);
		this.kind = 'cloudflare';
	}
}

class BlockingFakeCloudflare extends FakeCloudflare {
	constructor(state) {
		super(state);
		this.providerEntered = new Promise((resolve) => {
			this.resolveProviderEntered = resolve;
		});
		this.releaseProvider = new Promise((resolve) => {
			this.resolveReleaseProvider = resolve;
		});
	}

	async applyStep({ plan }) {
		this.applyCalls += 1;
		this.resolveProviderEntered();
		await this.releaseProvider;
		this.state = clone(plan.after);
		return { resource_id: plan.target.resource_id ?? 'created-resource', status: 'accepted' };
	}
}

class FakeResend extends FakeBase {
	constructor(state) {
		super(state);
		this.kind = 'resend';
	}
}

class FakeBrowser extends FakeBase {
	constructor(state) {
		super(state);
		this.kind = 'browser';
	}
}

class FakeDNS extends FakeBase {
	constructor(state) {
		super(state);
		this.kind = 'dns';
	}

	async inspect() {
		this.inspectCalls += 1;
		if (this.failInspect || this.failReadback)
			throw new Error('fake authoritative DNS read failure');
		return { state: clone(this.state), authoritative: true, list_complete: true };
	}

	async rollbackStep({ plan, owned_resource_ids }) {
		this.rollbackCalls += 1;
		const beforeRecords = clone(plan.before.records);
		const beforeIds = new Set(beforeRecords.map((record) => String(record.id)));
		const preserved = (this.state.records ?? []).filter(
			(record) =>
				!owned_resource_ids.includes(String(record.id)) && !beforeIds.has(String(record.id))
		);
		this.state = { ...clone(plan.before), records: [...beforeRecords, ...preserved] };
		return { status: 'restored_owned_records' };
	}
}

const fixedNow = Date.parse('2026-08-29T12:00:00.000Z');

function expiresAt(minutes = 15) {
	return new Date(fixedNow + minutes * 60_000).toISOString();
}

function cloudflareTarget(overrides = {}) {
	return {
		provider: 'cloudflare',
		adapter_kind: 'cloudflare',
		resource_type: 'cloudflare_worker',
		account_id: 'cf-account-test',
		zone_id: 'cf-zone-test',
		resource_id: 'worker-test',
		resource_name: 'quickmail-test-worker',
		...overrides
	};
}

function resendTarget(overrides = {}) {
	return {
		provider: 'resend',
		adapter_kind: 'resend',
		resource_type: 'resend_webhook',
		team_id: 'resend-team-test',
		resource_id: 'webhook-test',
		resource_name: 'quickmail-test-webhook',
		...overrides
	};
}

function basePlanInput({
	inspection,
	target = inspection.target,
	step = {},
	desiredState,
	rollback,
	approvalId = 'approval-test-1',
	now = fixedNow
}) {
	return {
		inspection,
		target,
		step: {
			kind: 'deployment',
			capability_id: 'cloudflare.deploy_worker',
			operation: 'deploy_worker_version',
			cost_class: 'none',
			...step
		},
		desiredState,
		rollback: rollback ?? {
			mode: 'restore_snapshot',
			description: 'restore the approved worker snapshot',
			owned_resource_ids: ['worker-test']
		},
		approvalId,
		expiresAt: expiresAt(),
		now
	};
}

function recomputePlanHash(plan) {
	const recomputed = clone(plan);
	delete recomputed.plan_hash;
	recomputed.plan_hash = fingerprint(recomputed);
	return recomputed;
}

describe('QMJ-10 provider-neutral setup engine', () => {
	test('inspect is read-only and provider list failure is not treated as empty', async () => {
		const fake = new FakeCloudflare({ status: 'ready', resources: [] });
		const inspection = await inspectSetup({
			adapter: fake,
			target: cloudflareTarget(),
			now: fixedNow
		});
		assert.equal(inspection.schema_version, SETUP_ENGINE_SCHEMA_VERSION);
		assert.equal(inspection.current_state_fingerprint, fingerprint(inspection.state));
		assert.equal(fake.applyCalls, 0);

		fake.failInspect = true;
		await assert.rejects(
			() => inspectSetup({ adapter: fake, target: cloudflareTarget(), now: fixedNow }),
			(error) => error instanceof SetupEngineError && error.code === 'provider_read_failed'
		);
		assert.equal(fake.applyCalls, 0);
	});

	test('emits one canonical step with exact diff, immutable target, cost, rollback, hash, and expiry', async () => {
		const fake = new FakeCloudflare({ version: 1, status: 'ready' });
		const target = cloudflareTarget();
		const inspection = await inspectSetup({ adapter: fake, target, now: fixedNow });
		const plan = createMutationPlan(
			basePlanInput({
				inspection,
				desiredState: { version: 2, status: 'ready' }
			})
		);
		assert.equal(plan.schema_version, SETUP_ENGINE_SCHEMA_VERSION);
		assert.equal(plan.step.kind, 'deployment');
		assert.equal(Array.isArray(plan.step), false);
		assert.deepEqual(plan.target, target);
		assert.equal(plan.current_state_fingerprint, fingerprint(plan.before));
		assert.equal(plan.desired_state_fingerprint, fingerprint(plan.after));
		assert.deepEqual(plan.diff, [{ path: '$.version', before: 1, after: 2 }]);
		assert.match(plan.plan_hash, /^[a-f0-9]{64}$/u);
		assert.doesNotThrow(() => verifyMutationPlan(plan, { now: fixedNow }));
	});

	test('rejects unsafe secret or mailbox data and rejects multi-step apply', async () => {
		const target = cloudflareTarget();
		const inspection = await inspectSetup({
			adapter: new FakeCloudflare({ status: 'ready' }),
			target,
			now: fixedNow
		});
		assert.throws(
			() =>
				createMutationPlan(
					basePlanInput({ inspection, desiredState: { status: 'ready', api_key: 'secret' } })
				),
			(error) => error instanceof SetupEngineError && error.code === 'unsafe_plan_data'
		);
		assert.throws(
			() =>
				createMutationPlan(
					basePlanInput({ inspection, desiredState: { status: 'ready' }, step: { steps: [] } })
				),
			(error) => error instanceof SetupEngineError && error.code === 'multiple_steps'
		);
		for (const unsafeKey of [
			'resend_api_key',
			'clientSecret',
			'signing_secret',
			'accessToken',
			'messageBody',
			'attachmentContent',
			'custom_password',
			'tokens',
			'cookies',
			'passwords',
			'api_keys',
			'custom_tokens',
			'secrets',
			'apikey',
			'apikeys',
			'credentials',
			'custom_credentials'
		]) {
			assert.throws(
				() =>
					createMutationPlan(
						basePlanInput({
							inspection,
							desiredState: { status: 'ready', [unsafeKey]: 'redact-me' }
						})
					),
				(error) => error instanceof SetupEngineError && error.code === 'unsafe_plan_data'
			);
		}
		assert.doesNotThrow(() =>
			createMutationPlan(
				basePlanInput({
					inspection,
					desiredState: { status: 'ready', secret_broker_reference: 'broker://qmj10/test' }
				})
			)
		);
	});

	test('step capability and operation must match the repository-owned exact contract', async () => {
		const target = cloudflareTarget();
		const inspection = await inspectSetup({
			adapter: new FakeCloudflare({ status: 'ready' }),
			target,
			now: fixedNow
		});
		for (const step of [
			{ kind: 'deployment', capability_id: 'cloudflare.deploy_worker', operation: 'deploy_worker' },
			{ kind: 'deployment', capability_id: 'cloudflare.create_worker', operation: 'create_worker' },
			{ kind: 'deployment', capability_id: 'resend.create_webhook', operation: 'create_webhook' }
		]) {
			assert.throws(
				() => createMutationPlan(basePlanInput({ inspection, step, desiredState: { version: 2 } })),
				(error) =>
					error instanceof SetupEngineError &&
					(error.code === 'invalid_step_contract' || error.code === 'step_target_mismatch')
			);
		}
	});

	test('same-name resources fail closed even with an ownership manifest', async () => {
		const target = cloudflareTarget({ resource_id: undefined });
		const inspection = await inspectSetup({
			adapter: new FakeCloudflare({
				resources: [
					{
						id: 'existing-worker',
						name: 'quickmail-test-worker',
						resource_type: 'cloudflare_worker',
						manifest_fingerprint: 'manifest-v1'
					}
				]
			}),
			target,
			now: fixedNow
		});
		assert.throws(
			() =>
				createMutationPlan(
					basePlanInput({
						inspection,
						step: {
							kind: 'resource_creation',
							capability_id: 'cloudflare.create_worker',
							operation: 'create_worker'
						},
						desiredState: {
							resources: [],
							resource_name: 'quickmail-test-worker',
							ownership_manifest: {
								resource_id: 'existing-worker',
								resource_type: 'cloudflare_worker',
								manifest_fingerprint: 'manifest-v1'
							}
						}
					})
				),
			(error) => error instanceof SetupEngineError && error.code === 'resource_collision'
		);
	});

	test('duplicate webhook endpoint and event set fail closed', async () => {
		const target = resendTarget({ resource_type: 'resend_webhook' });
		const inspection = await inspectSetup({
			adapter: new FakeResend({
				webhooks: [
					{
						id: 'existing-webhook',
						endpoint: 'https://quickmail.test/hooks/resend',
						event_types: ['email.sent', 'email.bounced']
					}
				]
			}),
			target,
			now: fixedNow
		});
		assert.throws(
			() =>
				createMutationPlan(
					basePlanInput({
						inspection,
						target,
						step: {
							kind: 'webhook_creation',
							capability_id: 'resend.create_webhook',
							operation: 'create_webhook'
						},
						desiredState: {
							endpoint: 'https://quickmail.test/hooks/resend',
							event_types: ['email.bounced', 'email.sent']
						}
					})
				),
			(error) => error instanceof SetupEngineError && error.code === 'resource_collision'
		);
	});

	test('target, current fingerprint, hash, expiry, and approval mismatches make zero writes', async () => {
		const fake = new FakeCloudflare({ version: 1 });
		const target = cloudflareTarget();
		const inspection = await inspectSetup({ adapter: fake, target, now: fixedNow });
		const ledger = new InMemoryApprovalLedger();
		const plan = createMutationPlan(basePlanInput({ inspection, desiredState: { version: 2 } }));
		ledger.approve(plan, { now: fixedNow });

		await assert.rejects(
			() =>
				applyMutationPlan({
					plan,
					adapter: fake,
					approvalLedger: ledger,
					target: { ...target, account_id: 'other-account' },
					approvalId: plan.approval_id,
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'target_mismatch'
		);
		assert.equal(fake.applyCalls, 0);

		fake.state.version = 9;
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan,
					adapter: fake,
					approvalLedger: ledger,
					approvalId: plan.approval_id,
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'current_state_mismatch'
		);
		assert.equal(fake.applyCalls, 0);

		const tampered = { ...plan, after: { version: 99 } };
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan: tampered,
					adapter: fake,
					approvalLedger: ledger,
					approvalId: plan.approval_id,
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'plan_hash_mismatch'
		);
		assert.equal(fake.applyCalls, 0);

		const expired = createMutationPlan(
			basePlanInput({
				inspection: await inspectSetup({ adapter: fake, target, now: fixedNow }),
				desiredState: { version: 2 },
				approvalId: 'approval-expired'
			})
		);
		const expiredPlan = { ...expired, expires_at: new Date(fixedNow - 1).toISOString() };
		expiredPlan.plan_hash = fingerprint(
			Object.fromEntries(Object.entries(expiredPlan).filter(([key]) => key !== 'plan_hash'))
		);
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan: expiredPlan,
					adapter: fake,
					approvalLedger: ledger,
					approvalId: expiredPlan.approval_id,
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'plan_expired'
		);
		assert.equal(fake.applyCalls, 0);

		const fresh = createMutationPlan(
			basePlanInput({
				inspection: await inspectSetup({ adapter: fake, target, now: fixedNow }),
				desiredState: { version: 3 },
				approvalId: 'approval-fresh'
			})
		);
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan: fresh,
					adapter: fake,
					approvalLedger: ledger,
					approvalId: 'wrong-approval',
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'approval_mismatch'
		);
		assert.equal(fake.applyCalls, 0);
	});

	test('invalid expiry or non-canonical plan fields make zero writes after hash recomputation', async () => {
		const fake = new FakeCloudflare({ version: 1 });
		const target = cloudflareTarget();
		const inspection = await inspectSetup({ adapter: fake, target, now: fixedNow });
		const plan = createMutationPlan(basePlanInput({ inspection, desiredState: { version: 2 } }));
		const invalidExpiry = { ...plan, expires_at: 'not-a-date' };
		invalidExpiry.plan_hash = fingerprint(
			Object.fromEntries(Object.entries(invalidExpiry).filter(([key]) => key !== 'plan_hash'))
		);
		await assert.rejects(
			() => applyMutationPlan({ plan: invalidExpiry, adapter: fake, now: fixedNow }),
			(error) => error instanceof SetupEngineError && error.code === 'plan_expired'
		);
		assert.equal(fake.applyCalls, 0);

		const invalidPlanId = { ...plan, plan_id: 42 };
		invalidPlanId.plan_hash = fingerprint(
			Object.fromEntries(Object.entries(invalidPlanId).filter(([key]) => key !== 'plan_hash'))
		);
		await assert.rejects(
			() => applyMutationPlan({ plan: invalidPlanId, adapter: fake, now: fixedNow }),
			(error) => error instanceof SetupEngineError && error.code === 'invalid_plan'
		);
		assert.equal(fake.applyCalls, 0);

		const invalidRollback = {
			...plan,
			rollback: { ...plan.rollback, unexpected: 'field' }
		};
		invalidRollback.plan_hash = fingerprint(
			Object.fromEntries(Object.entries(invalidRollback).filter(([key]) => key !== 'plan_hash'))
		);
		await assert.rejects(
			() => applyMutationPlan({ plan: invalidRollback, adapter: fake, now: fixedNow }),
			(error) => error instanceof SetupEngineError && error.code === 'invalid_rollback'
		);
		assert.equal(fake.applyCalls, 0);
	});

	test('recomputed handcrafted plans recheck safety invariants before provider writes', async () => {
		const topologyAdapter = new FakeCloudflare({ version: 1 });
		const topologyTarget = cloudflareTarget();
		const topologyInspection = await inspectSetup({
			adapter: topologyAdapter,
			target: topologyTarget,
			now: fixedNow
		});
		const topologyPlan = createMutationPlan(
			basePlanInput({
				inspection: topologyInspection,
				desiredState: { version: 2, resend_receiving: false }
			})
		);
		const forbiddenTopology = clone(topologyPlan);
		forbiddenTopology.after.resend_receiving = true;
		const topologyDiff = forbiddenTopology.diff.find(
			(entry) => entry.path === '$.resend_receiving'
		);
		assert.ok(topologyDiff);
		topologyDiff.after = true;
		forbiddenTopology.desired_state_fingerprint = fingerprint(forbiddenTopology.after);
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan: recomputePlanHash(forbiddenTopology),
					adapter: topologyAdapter,
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'forbidden_topology'
		);
		assert.equal(topologyAdapter.applyCalls, 0);

		const collisionAdapter = new FakeCloudflare({
			version: 1,
			resources: [{ id: 'existing-worker', name: 'quickmail-test-worker' }]
		});
		const collisionTarget = cloudflareTarget();
		const collisionInspection = await inspectSetup({
			adapter: collisionAdapter,
			target: collisionTarget,
			now: fixedNow
		});
		const collisionPlan = createMutationPlan(
			basePlanInput({ inspection: collisionInspection, desiredState: { version: 2 } })
		);
		const forbiddenCollision = clone(collisionPlan);
		forbiddenCollision.step = {
			kind: 'resource_creation',
			capability_id: 'cloudflare.create_worker',
			operation: 'create_worker',
			cost_class: 'none'
		};
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan: recomputePlanHash(forbiddenCollision),
					adapter: collisionAdapter,
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'resource_collision'
		);
		assert.equal(collisionAdapter.applyCalls, 0);

		const dnsTarget = {
			provider: 'cloudflare',
			adapter_kind: 'dns',
			resource_type: 'cloudflare_dns_record',
			account_id: 'cf-account-test',
			zone_id: 'cf-zone-test',
			domain: 'example.test',
			resource_id: 'dns-record-test'
		};
		const nonAuthoritativeBefore = { authoritative: false, records: [], routing_rules: [] };
		const nonAuthoritativeInspection = {
			schema_version: SETUP_ENGINE_SCHEMA_VERSION,
			target: dnsTarget,
			state: nonAuthoritativeBefore,
			current_state_fingerprint: fingerprint(nonAuthoritativeBefore)
		};
		const nonAuthoritativePlan = createMutationPlan(
			basePlanInput({
				inspection: nonAuthoritativeInspection,
				target: dnsTarget,
				desiredState: nonAuthoritativeBefore
			})
		);
		const forbiddenSnapshot = clone(nonAuthoritativePlan);
		forbiddenSnapshot.step = {
			kind: 'dns_change',
			capability_id: 'cloudflare.change_dns',
			operation: 'create_dns_record',
			cost_class: 'none'
		};
		const dnsAdapter = new FakeDNS(nonAuthoritativeBefore);
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan: recomputePlanHash(forbiddenSnapshot),
					adapter: dnsAdapter,
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'non_authoritative_snapshot'
		);
		assert.equal(dnsAdapter.applyCalls, 0);

		const authoritativeBefore = { authoritative: true, records: [], routing_rules: [] };
		const authoritativeAfter = {
			authoritative: true,
			records: [{ id: 'dns-record-test', type: 'TXT', name: '@', content: 'qmj-owned' }],
			routing_rules: []
		};
		const authoritativeInspection = {
			schema_version: SETUP_ENGINE_SCHEMA_VERSION,
			target: dnsTarget,
			state: authoritativeBefore,
			current_state_fingerprint: fingerprint(authoritativeBefore)
		};
		const validDnsPlan = createMutationPlan(
			basePlanInput({
				inspection: authoritativeInspection,
				target: dnsTarget,
				step: {
					kind: 'dns_change',
					capability_id: 'cloudflare.change_dns',
					operation: 'create_dns_record'
				},
				desiredState: authoritativeAfter,
				rollback: {
					mode: 'restore_owned_records',
					owned_resource_ids: ['dns-record-test'],
					description: 'restore only owned DNS records'
				}
			})
		);
		const forbiddenRollback = clone(validDnsPlan);
		forbiddenRollback.rollback.preserve_unowned = false;
		const invalidRollbackAdapter = new FakeDNS(authoritativeBefore);
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan: recomputePlanHash(forbiddenRollback),
					adapter: invalidRollbackAdapter,
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'invalid_rollback'
		);
		assert.equal(invalidRollbackAdapter.applyCalls, 0);
	});

	test('inspection rejects unsupported fixed collection shapes instead of treating them as empty', async () => {
		for (const key of ['resources', 'items', 'webhooks', 'domains', 'records', 'routing_rules']) {
			const fake = new FakeCloudflare({ [key]: { id: 'not-a-list' } });
			await assert.rejects(
				() => inspectSetup({ adapter: fake, target: cloudflareTarget(), now: fixedNow }),
				(error) => error instanceof SetupEngineError && error.code === 'provider_read_failed'
			);
			assert.equal(fake.applyCalls, 0);
		}
	});

	test('approval is one-use and apply performs one provider write followed by readback', async () => {
		const fake = new FakeResend({ version: 1 });
		const target = resendTarget();
		const inspection = await inspectSetup({ adapter: fake, target, now: fixedNow });
		const plan = createMutationPlan(
			basePlanInput({
				inspection,
				target,
				step: {
					kind: 'webhook_creation',
					capability_id: 'resend.create_webhook',
					operation: 'create_webhook'
				},
				desiredState: { version: 2 }
			})
		);
		const ledger = new InMemoryApprovalLedger();
		ledger.approve(plan, { now: fixedNow });
		const result = await applyMutationPlan({
			plan,
			adapter: fake,
			approvalLedger: ledger,
			approvalId: plan.approval_id,
			now: fixedNow
		});
		assert.equal(result.status, 'applied');
		assert.equal(result.verified, true);
		assert.equal(fake.applyCalls, 1);
		assert.equal(fake.inspectCalls, 3);
		const resumed = await applyMutationPlan({
			plan,
			adapter: fake,
			approvalLedger: ledger,
			approvalId: plan.approval_id,
			now: fixedNow
		});
		assert.equal(resumed.status, 'already_verified');
		assert.equal(resumed.writes, 0);
		assert.equal(fake.applyCalls, 1);
	});

	test('provider apply and readback failures stop without an automatic retry', async () => {
		const fake = new FakeCloudflare({ version: 1 });
		const target = cloudflareTarget();
		const inspection = await inspectSetup({ adapter: fake, target, now: fixedNow });
		const plan = createMutationPlan(basePlanInput({ inspection, desiredState: { version: 2 } }));
		const ledger = new InMemoryApprovalLedger();
		ledger.approve(plan, { now: fixedNow });
		fake.failApply = true;
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan,
					adapter: fake,
					approvalLedger: ledger,
					approvalId: plan.approval_id,
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'provider_apply_failed'
		);
		assert.equal(fake.applyCalls, 1);

		const secondInspection = await inspectSetup({ adapter: fake, target, now: fixedNow });
		const secondPlan = createMutationPlan(
			basePlanInput({
				inspection: secondInspection,
				desiredState: { version: 3 },
				approvalId: 'approval-readback'
			})
		);
		const secondLedger = new InMemoryApprovalLedger();
		secondLedger.approve(secondPlan, { now: fixedNow });
		fake.failApply = false;
		fake.failReadback = true;
		fake.failReadbackAfterApplyCalls = 2;
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan: secondPlan,
					adapter: fake,
					approvalLedger: secondLedger,
					approvalId: secondPlan.approval_id,
					now: fixedNow
				}),
			(error) =>
				error instanceof SetupEngineError &&
				error.code === 'readback_failed' &&
				error.details.applied === true
		);
		assert.equal(fake.applyCalls, 2);
	});

	test('DNS plans require authoritative records/routing snapshot and never enable Resend apex inbound MX', async () => {
		const target = {
			provider: 'cloudflare',
			adapter_kind: 'dns',
			resource_type: 'cloudflare_dns_record',
			account_id: 'cf-account-test',
			zone_id: 'cf-zone-test',
			domain: 'example.test',
			resource_id: 'dns-record-test'
		};
		const before = {
			authoritative: true,
			records: [
				{ id: 'm365-mx', type: 'MX', name: '@', content: 'mail.protection.outlook.com' },
				{ id: 'gmail-mx', type: 'MX', name: '@', content: 'aspmx.l.google.com' }
			],
			routing_rules: []
		};
		const fake = new FakeDNS(before);
		const inspection = await inspectSetup({
			adapter: fake,
			target,
			step: {
				kind: 'dns_change',
				capability_id: 'cloudflare.change_dns',
				operation: 'create_dns_record'
			},
			now: fixedNow
		});
		const rollback = {
			mode: 'restore_owned_records',
			owned_resource_ids: ['dns-record-test'],
			description: 'restore only owned DNS records'
		};
		const nonAuthoritativeInspection = {
			...inspection,
			state: { ...before, authoritative: false },
			current_state_fingerprint: fingerprint({ ...before, authoritative: false })
		};
		assert.throws(
			() =>
				createMutationPlan(
					basePlanInput({
						inspection: nonAuthoritativeInspection,
						target,
						step: {
							kind: 'dns_change',
							capability_id: 'cloudflare.change_dns',
							operation: 'create_dns_record'
						},
						desiredState: { authoritative: true, records: [], routing_rules: [] },
						rollback
					})
				),
			(error) => error instanceof SetupEngineError && error.code === 'non_authoritative_snapshot'
		);
		assert.throws(
			() =>
				createMutationPlan(
					basePlanInput({
						inspection,
						target,
						step: {
							kind: 'dns_change',
							capability_id: 'cloudflare.change_dns',
							operation: 'create_dns_record'
						},
						desiredState: {
							authoritative: true,
							records: [{ id: 'resend-mx', type: 'MX', name: '@', content: 'inbound.resend.com' }],
							routing_rules: []
						},
						rollback
					})
				),
			(error) => error instanceof SetupEngineError && error.code === 'forbidden_topology'
		);
		const plan = createMutationPlan(
			basePlanInput({
				inspection,
				target,
				step: {
					kind: 'dns_change',
					capability_id: 'cloudflare.change_dns',
					operation: 'create_dns_record'
				},
				desiredState: {
					authoritative: true,
					records: [
						...before.records,
						{ id: 'dns-record-test', type: 'TXT', name: '@', content: 'qmj-owned' }
					],
					routing_rules: []
				},
				rollback
			})
		);
		assert.equal(plan.rollback.mode, 'restore_owned_records');
	});

	test('DNS rollback preserves concurrent/unowned records and is idempotent', async () => {
		const before = {
			authoritative: true,
			records: [
				{ id: 'm365-mx', type: 'MX', name: '@', content: 'mail.protection.outlook.com' },
				{ id: 'gmail-mx', type: 'MX', name: '@', content: 'aspmx.l.google.com' }
			],
			routing_rules: []
		};
		const after = {
			authoritative: true,
			records: [
				...before.records,
				{ id: 'dns-record-test', type: 'TXT', name: '@', content: 'qmj-owned' }
			],
			routing_rules: []
		};
		const target = {
			provider: 'cloudflare',
			adapter_kind: 'dns',
			resource_type: 'cloudflare_dns_record',
			account_id: 'cf-account-test',
			zone_id: 'cf-zone-test',
			domain: 'example.test',
			resource_id: 'dns-record-test'
		};
		const fake = new FakeDNS(before);
		const inspection = await inspectSetup({
			adapter: fake,
			target,
			step: {
				kind: 'dns_change',
				capability_id: 'cloudflare.change_dns',
				operation: 'create_dns_record'
			},
			now: fixedNow
		});
		const plan = createMutationPlan(
			basePlanInput({
				inspection,
				target,
				step: {
					kind: 'dns_change',
					capability_id: 'cloudflare.change_dns',
					operation: 'create_dns_record'
				},
				desiredState: after,
				rollback: {
					mode: 'restore_owned_records',
					owned_resource_ids: ['dns-record-test'],
					description: 'restore only owned DNS records'
				}
			})
		);
		const ledger = new InMemoryApprovalLedger();
		ledger.approve(plan, { now: fixedNow });
		await applyMutationPlan({
			plan,
			adapter: fake,
			approvalLedger: ledger,
			approvalId: plan.approval_id,
			now: fixedNow
		});
		fake.state.records.push({
			id: 'concurrent-unowned',
			type: 'TXT',
			name: 'mail',
			content: 'external-change'
		});
		ledger.approveRollback(plan, { now: fixedNow });
		const rollbackResult = await rollbackMutationPlan({
			plan,
			adapter: fake,
			approvalLedger: ledger,
			rollbackApprovalId: plan.rollback.approval_id,
			now: fixedNow
		});
		assert.equal(rollbackResult.status, 'rolled_back');
		assert.deepEqual(
			fake.state.records.map((record) => record.id),
			['m365-mx', 'gmail-mx', 'concurrent-unowned']
		);
		const second = await rollbackMutationPlan({
			plan,
			adapter: fake,
			approvalLedger: ledger,
			rollbackApprovalId: plan.rollback.approval_id,
			now: fixedNow
		});
		assert.equal(second.status, 'noop');
		assert.equal(fake.rollbackCalls, 1);
	});

	test('protected zones, D1, non-empty R2, and Resend domains never receive automatic rollback writes', async () => {
		for (const [provider, adapterKind, resourceType, target] of [
			[
				'cloudflare',
				'cloudflare',
				'cloudflare_zone',
				cloudflareTarget({ resource_type: 'cloudflare_zone' })
			],
			[
				'cloudflare',
				'cloudflare',
				'cloudflare_d1_database',
				cloudflareTarget({ resource_type: 'cloudflare_d1_database' })
			],
			[
				'cloudflare',
				'cloudflare',
				'cloudflare_r2_bucket',
				cloudflareTarget({ resource_type: 'cloudflare_r2_bucket' })
			],
			['resend', 'resend', 'resend_domain', resendTarget({ resource_type: 'resend_domain' })]
		]) {
			const fake =
				provider === 'resend' ? new FakeResend({ version: 1 }) : new FakeCloudflare({ version: 1 });
			const actualTarget = {
				...target,
				provider,
				adapter_kind: adapterKind,
				resource_type: resourceType
			};
			const inspection = await inspectSetup({ adapter: fake, target: actualTarget, now: fixedNow });
			const plan = createMutationPlan(
				basePlanInput({
					inspection,
					target: actualTarget,
					step:
						provider === 'resend'
							? {
									kind: 'resource_creation',
									capability_id: 'resend.create_domain',
									operation: 'create_domain'
								}
							: undefined,
					desiredState: { version: 2 },
					rollback: {
						mode: 'restore_snapshot',
						owned_resource_ids: [actualTarget.resource_id],
						description: 'manual review'
					}
				})
			);
			fake.state.version = 2;
			const result = await rollbackMutationPlan({ plan, adapter: fake, now: fixedNow });
			assert.equal(result.status, 'manual_review_required');
			assert.equal(fake.rollbackCalls, 0);
		}
	});

	test('browser adapter remains a fixed-origin seam and setup engine never opens a browser', async () => {
		const fake = new FakeBrowser({ page: 'official-settings' });
		const target = {
			provider: 'cloudflare',
			adapter_kind: 'browser',
			resource_type: 'browser_page',
			account_id: 'cf-account-test',
			origin: 'https://dash.cloudflare.com/settings'
		};
		const inspection = await inspectSetup({ adapter: fake, target, now: fixedNow });
		assert.equal(inspection.state.page, 'official-settings');
		assert.equal(fake.applyCalls, 0);
		const plan = createMutationPlan(
			basePlanInput({
				inspection,
				target,
				desiredState: { page: 'configured' },
				rollback: {
					mode: 'restore_snapshot',
					owned_resource_ids: [],
					description: 'manual review'
				}
			})
		);
		const ledger = new InMemoryApprovalLedger();
		ledger.approve(plan, { now: fixedNow });
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan,
					adapter: fake,
					approvalLedger: ledger,
					approvalId: plan.approval_id,
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'browser_read_only'
		);
		await assert.rejects(
			() => rollbackMutationPlan({ plan, adapter: fake, now: fixedNow }),
			(error) => error instanceof SetupEngineError && error.code === 'browser_read_only'
		);
		assert.equal(fake.applyCalls, 0);
		assert.equal(fake.rollbackCalls, 0);
	});

	test('engine registry resolves each narrow fake seam without a generic provider framework', async () => {
		const cloudflare = new FakeCloudflare({ ready: true });
		const resend = new FakeResend({ ready: true });
		const dns = new FakeDNS({ authoritative: true, records: [], routing_rules: [] });
		const browser = new FakeBrowser({ page: 'official' });
		const engine = createSetupEngine({
			adapters: { cloudflare, resend, dns, browser },
			clock: () => fixedNow
		});
		const inspection = await engine.inspect({ target: cloudflareTarget() });
		assert.equal(inspection.state.ready, true);
		assert.equal((await engine.inspect({ target: resendTarget() })).state.ready, true);
		assert.equal(
			(
				await engine.inspect({
					target: {
						provider: 'cloudflare',
						adapter_kind: 'dns',
						resource_type: 'cloudflare_dns_record',
						account_id: 'cf-account-test',
						zone_id: 'cf-zone-test',
						domain: 'example.test'
					}
				})
			).state.authoritative,
			true
		);
		assert.equal(
			(
				await engine.inspect({
					target: {
						provider: 'cloudflare',
						adapter_kind: 'browser',
						resource_type: 'browser_page',
						account_id: 'cf-account-test',
						origin: 'https://dash.cloudflare.com/settings'
					}
				})
			).state.page,
			'official'
		);
	});

	test('fake seams remain offline when global fetch is a tripwire', async () => {
		const previousFetch = globalThis.fetch;
		globalThis.fetch = () => {
			throw new Error('network access is forbidden in QMJ-10 tests');
		};
		try {
			const fake = new FakeCloudflare({ version: 1 });
			const target = cloudflareTarget();
			const inspection = await inspectSetup({ adapter: fake, target, now: fixedNow });
			const plan = createMutationPlan(basePlanInput({ inspection, desiredState: { version: 2 } }));
			const ledger = new InMemoryApprovalLedger();
			ledger.approve(plan, { now: fixedNow });
			const result = await applyMutationPlan({
				plan,
				adapter: fake,
				approvalLedger: ledger,
				approvalId: plan.approval_id,
				now: fixedNow
			});
			assert.equal(result.status, 'applied');
			assert.equal(fake.applyCalls, 1);
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	test('atomic resumable state accepts only safe evidence and writes through same-directory rename', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'quickmail-ja-qmj10-'));
		const file = join(directory, 'state.json');
		const store = createAtomicSetupStateStore(file);
		const state = {
			schema_version: SETUP_ENGINE_SCHEMA_VERSION,
			plan_id: 'plan-1',
			status: 'planned',
			plan_hash: 'a'.repeat(64)
		};
		await store.save(state);
		assert.deepEqual(await store.load(), state);
		assert.equal((await readFile(file, 'utf8')).endsWith('\n'), true);
		await assert.rejects(
			() => store.save({ api_key: 'must-not-persist' }),
			(error) => error instanceof SetupEngineError && error.code === 'unsafe_plan_data'
		);
		await rm(directory, { recursive: true, force: true });
	});

	test('atomic state lock fails closed on an existing or stale lock', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'quickmail-ja-qmj10-lock-'));
		const file = join(directory, 'apply-state.json');
		const store = createAtomicSetupStateStore(file);
		await writeFile(`${file}.lock`, 'stale lock marker', 'utf8');
		await assert.rejects(
			() => store.withLock(() => undefined),
			(error) => error instanceof SetupEngineError && error.code === 'state_lock_unavailable'
		);
		assert.equal(await readFile(`${file}.lock`, 'utf8'), 'stale lock marker');
		await rm(directory, { recursive: true, force: true });
	});

	test('atomic approval state resumes by readback after a write/readback crash without a duplicate write', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'quickmail-ja-qmj10-ledger-'));
		const store = createAtomicSetupStateStore(join(directory, 'apply-state.json'));
		const firstLedger = new AtomicApprovalLedger({ stateStore: store });
		const fake = new FakeCloudflare({ version: 1 });
		const target = cloudflareTarget();
		const inspection = await inspectSetup({ adapter: fake, target, now: fixedNow });
		const plan = createMutationPlan(basePlanInput({ inspection, desiredState: { version: 2 } }));
		await firstLedger.approve(plan, { now: fixedNow });
		fake.failReadback = true;
		fake.failReadbackAfterApplyCalls = 1;
		await assert.rejects(
			() =>
				applyMutationPlan({
					plan,
					adapter: fake,
					approvalLedger: firstLedger,
					approvalId: plan.approval_id,
					now: fixedNow
				}),
			(error) => error instanceof SetupEngineError && error.code === 'readback_failed'
		);
		assert.equal(fake.applyCalls, 1);
		assert.deepEqual(await store.load(), {
			schema_version: 'quickmail-ja.setup-engine.v1.apply-state.v1',
			plan_id: plan.plan_id,
			plan_hash: plan.plan_hash,
			approval_id: plan.approval_id,
			approved: true,
			consumed: true,
			apply_started: true,
			readback_verified: false
		});

		fake.failReadback = false;
		const restartedLedger = new AtomicApprovalLedger({
			stateStore: createAtomicSetupStateStore(join(directory, 'apply-state.json'))
		});
		const recovered = await applyMutationPlan({
			plan,
			adapter: fake,
			approvalLedger: restartedLedger,
			approvalId: plan.approval_id,
			now: fixedNow
		});
		assert.equal(recovered.status, 'recovered');
		assert.equal(recovered.writes, 0);
		assert.equal(fake.applyCalls, 1);
		assert.equal((await store.load()).readback_verified, true);
		await rm(directory, { recursive: true, force: true });
	});

	test('two approval ledgers sharing a state path permit only one concurrent provider write', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'quickmail-ja-qmj10-concurrent-'));
		const file = join(directory, 'apply-state.json');
		const firstLedger = new AtomicApprovalLedger({
			stateStore: createAtomicSetupStateStore(file)
		});
		const secondLedger = new AtomicApprovalLedger({
			stateStore: createAtomicSetupStateStore(file)
		});
		const fake = new BlockingFakeCloudflare({ version: 1 });
		const target = cloudflareTarget();
		const inspection = await inspectSetup({ adapter: fake, target, now: fixedNow });
		const plan = createMutationPlan(basePlanInput({ inspection, desiredState: { version: 2 } }));
		await firstLedger.approve(plan, { now: fixedNow });

		const firstApply = applyMutationPlan({
			plan,
			adapter: fake,
			approvalLedger: firstLedger,
			approvalId: plan.approval_id,
			now: fixedNow
		});
		await fake.providerEntered;
		const secondApply = applyMutationPlan({
			plan,
			adapter: fake,
			approvalLedger: secondLedger,
			approvalId: plan.approval_id,
			now: fixedNow
		});
		await assert.rejects(
			secondApply,
			(error) => error instanceof SetupEngineError && error.code === 'apply_recovery_required'
		);
		fake.resolveReleaseProvider();
		const firstResult = await firstApply;
		assert.equal(firstResult.status, 'applied');
		assert.equal(fake.applyCalls, 1);
		assert.equal((await createAtomicSetupStateStore(file).load()).readback_verified, true);
		await rm(directory, { recursive: true, force: true });
	});

	test('readback verifier exposes the after/before boundary without writing', async () => {
		const fake = new FakeCloudflare({ version: 1 });
		const target = cloudflareTarget();
		const inspection = await inspectSetup({ adapter: fake, target, now: fixedNow });
		const plan = createMutationPlan(basePlanInput({ inspection, desiredState: { version: 2 } }));
		assert.deepEqual(
			verifyMutationReadback(plan, { version: 1 }, { phase: 'before', now: fixedNow }),
			{
				verified: true,
				phase: 'before',
				fingerprint: fingerprint({ version: 1 })
			}
		);
		assert.deepEqual(verifyMutationReadback(plan, { version: 2 }, { now: fixedNow }), {
			verified: true,
			phase: 'after',
			fingerprint: fingerprint({ version: 2 })
		});
		assert.equal(fake.applyCalls, 0);
	});
});
