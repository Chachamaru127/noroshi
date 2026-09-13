import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	SETUP_JOURNEY_SCHEMA_VERSION,
	SETUP_JOURNEY_STAGES,
	assessSetupPreflight,
	createSetupJourney,
	recordSetupAction,
	recordSetupPreflight,
	renderMissionBoard,
	resolveJourneyStatePath,
	resumeSetupJourney,
	saveSetupJourney
} from './setup-journey.mjs';

const now = '2026-09-11T10:00:00.000Z';

function readyPreflight() {
	return {
		target_host: 'codex',
		browser: 'ready',
		computer: 'ready',
		terminal: 'ready',
		bun: { available: true, version: '1.3.14', required: '1.3.14' },
		wrangler: { available: true, source: 'repo', version: '4.124.0' },
		cloudflare: { account: 'present', login: 'ready' },
		resend: { account: 'present', login: 'ready' },
		domain: { value: 'example.test', ownership: 'confirmed' },
		dns: { authoritative_nameservers: 'observed', dnssec: 'observed', ttl: 'observed' },
		current_mx: { status: 'observed', records: [] },
		test_recipient: { value: 'tester@example.net', controlled_by_user: true },
		mailbox_mcp: 'available',
		existing_mail: 'none',
		identity: {
			cloudflare_fingerprint: 'c'.repeat(64),
			resend_fingerprint: 'd'.repeat(64)
		}
	};
}

async function advanceJourneyToOutbound({ workspaceRoot, stateRoot }) {
	await recordSetupPreflight({ workspaceRoot, stateRoot, observations: readyPreflight(), now });
	const login = {
		id: 'provider-login',
		stage: 'provider_login',
		kind: 'human_action',
		executor: 'human'
	};
	await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action: login, now });
	await recordSetupAction({
		workspaceRoot,
		stateRoot,
		phase: 'verified',
		action: login,
		evidence: {
			kind: 'provider_identity',
			status: 'verified',
			observed_at: now,
			cloudflare_identity_fingerprint: 'c'.repeat(64),
			resend_identity_fingerprint: 'd'.repeat(64)
		},
		now
	});
	const providerStages = [
		['resend_authentication', 'resend.inspect_domain', 'a'],
		['d1_r2', 'cloudflare.inspect_d1', 'b'],
		['migration', 'cloudflare.inspect_d1', 'c'],
		['deploy', 'cloudflare.inspect_workers', 'd'],
		['secrets', 'resend.inspect_api_keys', 'e'],
		['email_routing', 'cloudflare.inspect_email_routing', 'f']
	];
	for (const [stage, capability, hashCharacter] of providerStages) {
		const planHash = hashCharacter.repeat(64);
		const action = {
			id: `${stage}-write`,
			stage,
			kind: 'provider_write',
			executor: 'host.adapter',
			plan_hash: planHash,
			readback: { capability }
		};
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action, now });
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'issued', action, now });
		await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'verified',
			action,
			evidence: {
				kind: 'stage_verification',
				status: 'verified',
				observed_at: now,
				state_fingerprint: '9'.repeat(64),
				plan_hash: planHash
			},
			now
		});
	}
	const firstAdmin = {
		id: 'first-admin-readback',
		stage: 'first_admin',
		kind: 'readback',
		executor: 'host.readback'
	};
	await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action: firstAdmin, now });
	await recordSetupAction({
		workspaceRoot,
		stateRoot,
		phase: 'verified',
		action: firstAdmin,
		evidence: {
			kind: 'first_admin_readback',
			status: 'verified',
			observed_at: now,
			identity_fingerprint: '8'.repeat(64),
			setup_key_invalidated: true
		},
		now
	});
}

test('preflight represents every required capability and skips Chrome fallback with native control', () => {
	const result = assessSetupPreflight(readyPreflight());
	assert.equal(result.status, 'ready');
	assert.deepEqual(
		result.checks.map(({ id, status }) => [id, status]),
		[
			['browser', 'ready'],
			['computer', 'ready'],
			['chrome_extension', 'skipped'],
			['terminal', 'ready'],
			['bun', 'ready'],
			['wrangler', 'ready'],
			['cloudflare_account', 'ready'],
			['cloudflare_login', 'ready'],
			['cloudflare_identity', 'ready'],
			['resend_account', 'ready'],
			['resend_login', 'ready'],
			['resend_identity', 'ready'],
			['domain', 'ready'],
			['dns', 'ready'],
			['current_mx', 'ready'],
			['test_recipient', 'ready'],
			['mailbox_mcp', 'ready'],
			['chatgpt_developer_mode', 'skipped'],
			['secure_mcp_tunnel', 'skipped']
		]
	);
});

test('one native control capability is enough to skip the Chrome fallback', () => {
	for (const capabilities of [
		{ browser: 'ready', computer: 'unavailable' },
		{ browser: 'unavailable', computer: 'ready' }
	]) {
		const result = assessSetupPreflight({ ...readyPreflight(), ...capabilities });
		const statuses = Object.fromEntries(result.checks.map(({ id, status }) => [id, status]));
		assert.equal(result.status, 'ready');
		assert.equal(statuses.browser, capabilities.browser === 'ready' ? 'ready' : 'skipped');
		assert.equal(statuses.computer, capabilities.computer === 'ready' ? 'ready' : 'skipped');
		assert.equal(statuses.chrome_extension, 'skipped');
	}
});

test('a ready Chrome fallback replaces unavailable native controls', () => {
	const result = assessSetupPreflight({
		...readyPreflight(),
		browser: 'unavailable',
		computer: 'unavailable',
		chrome_extension: 'ready'
	});
	const statuses = Object.fromEntries(result.checks.map(({ id, status }) => [id, status]));
	assert.equal(result.status, 'ready');
	assert.equal(statuses.browser, 'skipped');
	assert.equal(statuses.computer, 'skipped');
	assert.equal(statuses.chrome_extension, 'ready');
});

test('ChatGPT Work cloud preflight requires developer mode and Secure MCP Tunnel', () => {
	const result = assessSetupPreflight({
		...readyPreflight(),
		target_host: 'chatgpt_work_cloud',
		chatgpt_developer_mode: 'unknown',
		secure_mcp_tunnel: 'unavailable'
	});
	const checks = Object.fromEntries(result.checks.map((entry) => [entry.id, entry]));
	assert.equal(result.status, 'user_action');
	assert.equal(checks.chatgpt_developer_mode.status, 'user_action');
	assert.equal(checks.secure_mcp_tunnel.status, 'user_action');
	assert.equal(
		checks.secure_mcp_tunnel.official_url,
		'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels'
	);
});

test('legacy chatgpt_work host remains a cloud alias for saved journeys', () => {
	const result = assessSetupPreflight({
		...readyPreflight(),
		target_host: 'chatgpt_work',
		chatgpt_developer_mode: 'unknown',
		secure_mcp_tunnel: 'unavailable'
	});
	assert.equal(result.status, 'user_action');
});

test('ChatGPT Work local uses the shared local stdio configuration without a tunnel', () => {
	const result = assessSetupPreflight({
		...readyPreflight(),
		target_host: 'chatgpt_work_local',
		chatgpt_developer_mode: 'unavailable',
		secure_mcp_tunnel: 'unavailable'
	});
	const checks = Object.fromEntries(result.checks.map((entry) => [entry.id, entry]));
	assert.equal(result.status, 'ready');
	assert.equal(checks.chatgpt_developer_mode.status, 'skipped');
	assert.equal(checks.secure_mcp_tunnel.status, 'skipped');
});

test('preflight asks for Chrome only as fallback and stops before hidden mid-setup blockers', () => {
	const result = assessSetupPreflight({
		...readyPreflight(),
		browser: 'unavailable',
		computer: 'unavailable',
		chrome_extension: 'unknown',
		bun: { available: true, version: '1.4.0', required: '1.3.14' },
		wrangler: { available: false, source: 'missing' },
		cloudflare: { account: 'unknown', login: 'unknown' },
		current_mx: { status: 'unknown' }
	});
	assert.equal(result.status, 'blocked');
	const statuses = Object.fromEntries(result.checks.map(({ id, status }) => [id, status]));
	assert.equal(statuses.chrome_extension, 'user_action');
	assert.equal(statuses.bun, 'blocked');
	assert.equal(statuses.wrangler, 'blocked');
	assert.equal(statuses.cloudflare_account, 'user_action');
	assert.equal(statuses.current_mx, 'blocked');
	assert.match(result.checks.find(({ id }) => id === 'bun').copy_command, /1\.3\.14/u);
	assert.equal(
		result.checks.find(({ id }) => id === 'cloudflare_account').official_url,
		'https://dash.cloudflare.com/sign-up'
	);
});

test('journey is keyed to the workspace, persists atomically with 0600 mode, and resumes', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-'));
	const workspace = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	try {
		const first = await recordSetupPreflight({
			workspaceRoot: workspace,
			stateRoot,
			observations: readyPreflight(),
			now
		});
		assert.equal(first.session.schema_version, SETUP_JOURNEY_SCHEMA_VERSION);
		assert.equal(first.session.stages.length, 12);
		assert.deepEqual(
			first.session.stages.map(({ id }) => id),
			SETUP_JOURNEY_STAGES.map(({ id }) => id)
		);
		assert.deepEqual(first.session.inputs, {
			domain: 'example.test',
			test_recipient: 'tester@example.net',
			existing_mail: 'none',
			current_mx_fingerprint: fingerprintForTest([])
		});
		assert.deepEqual(first.session.identity, {
			cloudflare_fingerprint: 'c'.repeat(64),
			resend_fingerprint: 'd'.repeat(64)
		});

		const path = resolveJourneyStatePath(workspace, { stateRoot });
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true);
		const resumed = await resumeSetupJourney({ workspaceRoot: workspace, stateRoot });
		assert.equal(resumed.session.inputs.domain, 'example.test');
		assert.equal(resumed.session.stages[0].status, 'verified');
		assert.match(resumed.board, /Noroshi 開通ミッション/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('preflight cannot replace a bound host, domain, recipient, or provider identity after downstream progress', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-preflight-binding-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	try {
		await recordSetupPreflight({ workspaceRoot, stateRoot, observations: readyPreflight(), now });
		const replacements = [
			{ target_host: 'chatgpt_work_cloud' },
			{ domain: { value: 'other.example', ownership: 'confirmed' } },
			{ test_recipient: { value: 'other@example.net', controlled_by_user: true } },
			{ identity: { cloudflare_fingerprint: 'e'.repeat(64) } },
			{ identity: { resend_fingerprint: 'f'.repeat(64) } }
		];
		for (const replacement of replacements) {
			await assert.rejects(
				() =>
					recordSetupPreflight({
						workspaceRoot,
						stateRoot,
						observations: { ...readyPreflight(), ...replacement },
						now
					}),
				/setup journey target changed/u
			);
		}
		const resumed = await resumeSetupJourney({ workspaceRoot, stateRoot });
		assert.equal(resumed.session.host.target_host, 'codex');
		assert.equal(resumed.session.inputs.domain, 'example.test');
		assert.equal(resumed.session.inputs.test_recipient, 'tester@example.net');
		assert.equal(resumed.session.identity.cloudflare_fingerprint, 'c'.repeat(64));
		assert.equal(resumed.session.identity.resend_fingerprint, 'd'.repeat(64));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('real and symlinked workspace paths resolve to one journey', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-symlink-'));
	const workspace = join(directory, 'workspace');
	const alias = join(directory, 'workspace-alias');
	const stateRoot = join(directory, 'state');
	try {
		await mkdir(workspace);
		await symlink(workspace, alias);
		const created = await createSetupJourney({ workspaceRoot: workspace, stateRoot, now });
		const resumed = await resumeSetupJourney({ workspaceRoot: alias, stateRoot });
		assert.equal(
			resolveJourneyStatePath(workspace, { stateRoot }),
			resolveJourneyStatePath(alias, { stateRoot })
		);
		assert.equal(resumed.session.session_id, created.session_id);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('v1 migration drops legacy completion and preserves only issued write recovery', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-v1-migration-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	try {
		await mkdir(stateRoot, { recursive: true });
		const legacy = {
			schema_version: 'noroshi.setup-journey.v1',
			session_id: 'legacy-session',
			created_at: now,
			updated_at: now,
			workspace: { path: workspaceRoot, revision: null },
			host: { target_host: 'codex' },
			inputs: { domain: 'example.test', test_recipient: 'tester@example.net' },
			identity: {
				cloudflare_fingerprint: 'c'.repeat(64),
				resend_fingerprint: 'd'.repeat(64)
			},
			stages: SETUP_JOURNEY_STAGES.map((stage, index) => ({
				...stage,
				status: index < 9 ? 'verified' : index === 9 ? 'blocked' : 'pending',
				...(index === 1
					? {
							evidence: [
								{
									action_id: 'legacy-login',
									kind: 'human_readback',
									status: 'verified',
									observed_at: now
								}
							]
						}
					: {})
			})),
			current_action: {
				id: 'send-canary-01',
				stage: 'outbound_send',
				kind: 'provider_write',
				status: 'issued',
				executor: 'host.terminal',
				plan_hash: 'a'.repeat(64),
				readback: { capability: 'resend.inspect_delivery', target: 'canary-01' }
			},
			mailbox_handoff: { status: 'pending' }
		};
		await writeFile(
			resolveJourneyStatePath(workspaceRoot, { stateRoot }),
			`${JSON.stringify(legacy)}\n`,
			{ mode: 0o600 }
		);
		const resumed = await resumeSetupJourney({ workspaceRoot, stateRoot });
		assert.equal(resumed.session.schema_version, 'noroshi.setup-journey.v2');
		assert.equal(
			resumed.session.stages.every(({ status }) => status !== 'verified'),
			true
		);
		assert.equal(
			resumed.session.stages.every(({ evidence }) => evidence === undefined),
			true
		);
		assert.equal(resumed.session.current_action.status, 'issued');
		assert.equal(resumed.session.current_action.executor, 'host.adapter');
		assert.equal(resumed.session.current_action.readback.target, undefined);
		assert.match(resumed.session.current_action.readback.target_fingerprint, /^[a-f0-9]{64}$/u);
		assert.equal(resumed.next_action.kind, 'readback');
		assert.equal(resumed.next_action.executor, 'host.readback');
		await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'blocked',
			action: resumed.next_action,
			evidence: {
				kind: 'blocked',
				status: 'blocked',
				observed_at: now,
				reason_code: 'readback_failed'
			},
			now
		});
		const stored = JSON.parse(
			await readFile(resolveJourneyStatePath(workspaceRoot, { stateRoot }), 'utf8')
		);
		assert.equal(stored.schema_version, 'noroshi.setup-journey.v2');
		assert.equal(stored.current_action.status, 'issued');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('journey refuses secret and message-body fields before they reach disk', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-secret-'));
	try {
		const session = await createSetupJourney({
			workspaceRoot: join(directory, 'workspace'),
			stateRoot: join(directory, 'state'),
			now
		});
		for (const unsafe of [
			{ api_key: 'provider-secret' },
			{ password: 'operator-password' },
			{ message_body: 'mail content' },
			{ cookies: ['browser-cookie'] },
			{ credential_value: 'credential-fixture' },
			{ authorization_header: 'authorization-fixture' },
			{ provider_page_text: 'page-fixture' },
			{ browser_profile: 'profile-fixture' },
			{ browser_profiles: ['profile-fixture'] },
			{ screenshot: 'image-fixture' },
			{ screenshots: ['image-fixture'] },
			{ approval_grant: 'grant-fixture' },
			{ approval_grants: ['grant-fixture'] },
			{ unknown_field: 'unknown-fixture' }
		]) {
			await assert.rejects(
				() =>
					saveSetupJourney(
						{ ...session, evidence: unsafe },
						{ stateRoot: join(directory, 'state') }
					),
				/not permitted in setup state/u
			);
		}
		for (const unsafeSession of [
			{ ...session, host: { target_host: 'secret-bearing-host-value' } },
			{ ...session, mailbox_handoff: { status: 'pending', api_key: 'provider-secret' } },
			{ ...session, inputs: { ...session.inputs, domain: 'provider-secret' } },
			{
				...session,
				preflight: {
					status: 'ready',
					checks: [{ id: 'api_key', label: 'provider-secret', status: 'ready' }]
				}
			}
		]) {
			await assert.rejects(
				() => saveSetupJourney(unsafeSession, { stateRoot: join(directory, 'state') }),
				/invalid|incomplete|not permitted/u
			);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('issued provider writes keep the readback lock when blocked and cannot be replaced', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-issued-blocked-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	const action = {
		id: 'send-canary-01',
		stage: 'outbound_send',
		kind: 'provider_write',
		executor: 'host.adapter',
		plan_hash: 'a'.repeat(64),
		readback: { capability: 'resend.inspect_delivery', target_fingerprint: '1'.repeat(64) }
	};
	try {
		await advanceJourneyToOutbound({ workspaceRoot, stateRoot });
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action, now });
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'issued', action, now });
		const blocked = await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'blocked',
			action,
			evidence: {
				kind: 'blocked',
				status: 'blocked',
				observed_at: now,
				reason_code: 'readback_failed'
			},
			now
		});
		assert.equal(blocked.session.current_action.status, 'issued');
		assert.equal(blocked.session.stages[9].status, 'blocked');
		assert.equal(blocked.next_action.kind, 'readback');
		assert.equal(blocked.next_action.executor, 'host.readback');
		await assert.rejects(
			() =>
				recordSetupAction({
					workspaceRoot,
					stateRoot,
					phase: 'planned',
					action: { ...action, id: 'send-canary-02' },
					now
				}),
			/readback before another plan/u
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('an issued write can be verified after a repeated preflight becomes blocked', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-issued-preflight-block-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	const action = {
		id: 'resend-domain-create',
		stage: 'resend_authentication',
		kind: 'provider_write',
		executor: 'host.adapter',
		plan_hash: 'a'.repeat(64),
		readback: { capability: 'resend.inspect_domain' }
	};
	try {
		await recordSetupPreflight({ workspaceRoot, stateRoot, observations: readyPreflight(), now });
		const login = {
			id: 'provider-login',
			stage: 'provider_login',
			kind: 'human_action',
			executor: 'human'
		};
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action: login, now });
		await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'verified',
			action: login,
			evidence: {
				kind: 'provider_identity',
				status: 'verified',
				observed_at: now,
				cloudflare_identity_fingerprint: 'c'.repeat(64),
				resend_identity_fingerprint: 'd'.repeat(64)
			},
			now
		});
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action, now });
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'issued', action, now });
		const blockedPreflight = await recordSetupPreflight({
			workspaceRoot,
			stateRoot,
			observations: {
				...readyPreflight(),
				bun: { available: true, version: '1.4.0', required: '1.3.14' }
			},
			now
		});
		assert.equal(blockedPreflight.session.stages[0].status, 'blocked');
		const verified = await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'verified',
			action,
			evidence: {
				kind: 'stage_verification',
				status: 'verified',
				observed_at: now,
				state_fingerprint: 'b'.repeat(64),
				plan_hash: 'a'.repeat(64)
			},
			now
		});
		assert.equal(verified.session.stages[2].status, 'verified');
		assert.equal(verified.session.current_action, null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('issued writes resume with readback only and never ask for a second write', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-issued-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	try {
		const session = await createSetupJourney({ workspaceRoot, stateRoot, now });
		session.current_action = {
			id: 'create-d1-01',
			stage: 'd1_r2',
			kind: 'provider_write',
			status: 'issued',
			executor: 'host.adapter',
			plan_hash: 'a'.repeat(64),
			readback: { capability: 'cloudflare.inspect_d1', target_fingerprint: '1'.repeat(64) }
		};
		await saveSetupJourney(session, { stateRoot });
		const resumed = await resumeSetupJourney({ workspaceRoot, stateRoot });
		assert.deepEqual(resumed.next_action, {
			id: 'create-d1-01',
			stage: 'd1_r2',
			kind: 'readback',
			executor: 'host.readback',
			plan_hash: 'a'.repeat(64),
			retry: 'readback_only',
			readback: { capability: 'cloudflare.inspect_d1', target_fingerprint: '1'.repeat(64) }
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('journey records planned, issued, and verified actions in order across restarts', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-transition-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	const loginAction = {
		id: 'provider-login-readback',
		stage: 'provider_login',
		kind: 'human_action',
		executor: 'human'
	};
	const writeAction = {
		id: 'resend-domain-create',
		stage: 'resend_authentication',
		kind: 'provider_write',
		executor: 'host.adapter',
		plan_hash: 'a'.repeat(64),
		readback: { capability: 'resend.inspect_domain' }
	};
	try {
		await recordSetupPreflight({
			workspaceRoot,
			stateRoot,
			observations: readyPreflight(),
			now
		});
		await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'planned',
			action: loginAction,
			now
		});
		await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'verified',
			action: loginAction,
			evidence: {
				kind: 'provider_identity',
				status: 'verified',
				observed_at: now,
				cloudflare_identity_fingerprint: 'c'.repeat(64),
				resend_identity_fingerprint: 'd'.repeat(64)
			},
			stageComplete: false,
			now
		});
		await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'planned',
			action: writeAction,
			now
		});
		await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'issued',
			action: writeAction,
			now
		});
		const restarted = await resumeSetupJourney({ workspaceRoot, stateRoot });
		assert.equal(restarted.next_action.kind, 'readback');
		assert.equal(restarted.next_action.id, writeAction.id);
		assert.equal(restarted.next_action.executor, 'host.readback');
		assert.equal(restarted.next_action.plan_hash, writeAction.plan_hash);
		assert.equal('status' in restarted.next_action, false);
		assert.equal(restarted.next_action.retry, 'readback_only');
		await assert.rejects(
			() =>
				recordSetupAction({
					workspaceRoot,
					stateRoot,
					phase: 'planned',
					action: { ...writeAction, id: 'duplicate-write' },
					now
				}),
			/readback before another plan/u
		);
		const verified = await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'verified',
			action: restarted.next_action,
			evidence: {
				kind: 'stage_verification',
				status: 'verified',
				state_fingerprint: 'b'.repeat(64),
				plan_hash: 'a'.repeat(64),
				observed_at: now
			},
			stageComplete: false,
			now
		});
		assert.equal(verified.session.stages[2].status, 'verified');
		assert.equal(verified.session.stages[3].status, 'active');
		assert.equal(verified.session.current_action, null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('provider login evidence must match the identities persisted by preflight', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-provider-identity-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	const action = {
		id: 'provider-login',
		stage: 'provider_login',
		kind: 'human_action',
		executor: 'human'
	};
	try {
		await recordSetupPreflight({ workspaceRoot, stateRoot, observations: readyPreflight(), now });
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action, now });
		await assert.rejects(
			() =>
				recordSetupAction({
					workspaceRoot,
					stateRoot,
					phase: 'verified',
					action,
					evidence: {
						kind: 'provider_identity',
						status: 'verified',
						observed_at: now,
						cloudflare_identity_fingerprint: 'e'.repeat(64),
						resend_identity_fingerprint: 'd'.repeat(64)
					},
					now
				}),
			/provider identity does not match preflight/u
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('journey refuses preflight actions, out-of-order actions, and unknown action/evidence fields', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-order-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	try {
		await createSetupJourney({ workspaceRoot, stateRoot, now });
		const action = {
			id: 'out-of-order',
			stage: 'deploy',
			kind: 'human_action',
			executor: 'human',
			plan_hash: 'a'.repeat(64)
		};
		await assert.rejects(
			() => recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action, now }),
			/current unverified stage/u
		);
		const preflight = {
			id: 'preflight-evidence',
			stage: 'preflight',
			kind: 'human_action',
			executor: 'human'
		};
		await assert.rejects(
			() =>
				recordSetupAction({
					workspaceRoot,
					stateRoot,
					phase: 'planned',
					action: preflight,
					now
				}),
			/not permitted in setup state/u
		);

		await recordSetupPreflight({ workspaceRoot, stateRoot, observations: readyPreflight(), now });
		const login = {
			id: 'provider-login',
			stage: 'provider_login',
			kind: 'human_action',
			executor: 'human'
		};
		await assert.rejects(
			() =>
				recordSetupAction({
					workspaceRoot,
					stateRoot,
					phase: 'planned',
					action: { ...login, credential_value: 'forbidden' },
					now
				}),
			/not permitted/u
		);
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action: login, now });
		for (const unsafe of [
			{ kind: 'provider_identity', status: 'verified', observed_at: now, unknown_field: true },
			{
				kind: 'provider_identity',
				status: 'verified',
				observed_at: now,
				cloudflare_identity_fingerprint: 'c'.repeat(64),
				resend_identity_fingerprint: 'd'.repeat(64),
				provider_result_id: 'wrong-contract-field'
			},
			{ kind: 'human_readback', status: 'verified', observed_at: now },
			{ kind: 'blocked', status: 'blocked', observed_at: now, reason_code: 'read_failed' }
		]) {
			await assert.rejects(
				() =>
					recordSetupAction({
						workspaceRoot,
						stateRoot,
						phase: 'verified',
						action: login,
						evidence: unsafe,
						now
					}),
				/not permitted|evidence kind|requires verified evidence/u
			);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('journey action metadata uses fixed executors, capabilities, fingerprints, and public identifiers', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-action-contract-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	try {
		await recordSetupPreflight({ workspaceRoot, stateRoot, observations: readyPreflight(), now });
		const base = {
			id: 'provider-login',
			stage: 'provider_login',
			kind: 'human_action',
			executor: 'human'
		};
		for (const invalid of [
			{ ...base, executor: 'model-selected-executor' },
			{ ...base, id: 'paste-api-key' },
			{
				...base,
				readback: { capability: 'arbitrary.provider.call', target_fingerprint: '1'.repeat(64) }
			},
			{
				...base,
				readback: { capability: 'provider.identity', target: 'raw-provider-target' }
			}
		]) {
			await assert.rejects(
				() =>
					recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action: invalid, now }),
				/fixed executor|public identifier|capability is not permitted|target is not permitted/u
			);
		}
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action: base, now });
		await assert.rejects(
			() =>
				recordSetupAction({
					workspaceRoot,
					stateRoot,
					phase: 'blocked',
					action: base,
					evidence: {
						kind: 'blocked',
						status: 'blocked',
						observed_at: now,
						reason_code: 'paste-api-key'
					},
					now
				}),
			/reason code is not permitted/u
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('stage completion is derived from fixed evidence contracts, not the caller boolean', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-stage-contract-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	try {
		await recordSetupPreflight({ workspaceRoot, stateRoot, observations: readyPreflight(), now });
		const login = {
			id: 'provider-login',
			stage: 'provider_login',
			kind: 'human_action',
			executor: 'human'
		};
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action: login, now });
		await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'verified',
			action: login,
			evidence: {
				kind: 'provider_identity',
				status: 'verified',
				observed_at: now,
				cloudflare_identity_fingerprint: 'c'.repeat(64),
				resend_identity_fingerprint: 'd'.repeat(64)
			},
			now
		});
		const action = {
			id: 'resend-authentication-write',
			stage: 'resend_authentication',
			kind: 'provider_write',
			executor: 'host.adapter',
			plan_hash: '3'.repeat(64),
			readback: {
				capability: 'resend.inspect_domain',
				target_fingerprint: '6'.repeat(64)
			}
		};
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action, now });
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'issued', action, now });
		await assert.rejects(
			() =>
				recordSetupAction({
					workspaceRoot,
					stateRoot,
					phase: 'verified',
					action,
					evidence: {
						kind: 'stage_verification',
						status: 'verified',
						observed_at: now
					},
					stageComplete: true,
					now
				}),
			/required/u
		);
		const verified = await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'verified',
			action,
			evidence: {
				kind: 'stage_verification',
				status: 'verified',
				observed_at: now,
				state_fingerprint: '7'.repeat(64),
				plan_hash: '3'.repeat(64)
			},
			stageComplete: false,
			now
		});
		assert.equal(verified.session.stages[2].status, 'verified');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('persisted verified statuses are rederived from completion evidence', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-derived-status-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	const login = {
		id: 'provider-login',
		stage: 'provider_login',
		kind: 'human_action',
		executor: 'human'
	};
	try {
		await recordSetupPreflight({ workspaceRoot, stateRoot, observations: readyPreflight(), now });
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action: login, now });
		const completed = await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'verified',
			action: login,
			evidence: {
				kind: 'provider_identity',
				status: 'verified',
				observed_at: now,
				cloudflare_identity_fingerprint: 'c'.repeat(64),
				resend_identity_fingerprint: 'd'.repeat(64)
			},
			now
		});
		completed.session.stages[1].status = 'blocked';
		completed.session.stages[2].status = 'verified';
		await saveSetupJourney(completed.session, { stateRoot });
		const resumed = await resumeSetupJourney({ workspaceRoot, stateRoot });
		assert.equal(resumed.session.stages[1].status, 'verified');
		assert.equal(resumed.session.stages[2].status, 'active');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('outbound, inbound, and mailbox completion share one canary and identity through mailbox handoff', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-mailbox-handoff-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	const canaryFingerprint = '1'.repeat(64);
	const identityFingerprint = '2'.repeat(64);
	try {
		await advanceJourneyToOutbound({ workspaceRoot, stateRoot });
		const outbound = {
			id: 'outbound-canary',
			stage: 'outbound_send',
			kind: 'provider_write',
			executor: 'host.adapter',
			plan_hash: '3'.repeat(64),
			readback: { capability: 'resend.inspect_delivery' }
		};
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action: outbound, now });
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'issued', action: outbound, now });
		const sent = await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'verified',
			action: outbound,
			evidence: {
				kind: 'outbound_canary',
				status: 'verified',
				observed_at: now,
				canary_fingerprint: canaryFingerprint,
				identity_fingerprint: identityFingerprint,
				plan_hash: '3'.repeat(64),
				idempotency_key_fingerprint: '4'.repeat(64)
			},
			now
		});
		assert.deepEqual(sent.session.mailbox_handoff, {
			status: 'outbound_verified',
			canary_fingerprint: canaryFingerprint,
			identity_fingerprint: identityFingerprint
		});

		const inbound = {
			id: 'inbound-reply',
			stage: 'inbound_reply',
			kind: 'readback',
			executor: 'host.readback',
			plan_hash: '5'.repeat(64)
		};
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action: inbound, now });
		await assert.rejects(
			() =>
				recordSetupAction({
					workspaceRoot,
					stateRoot,
					phase: 'verified',
					action: inbound,
					evidence: {
						kind: 'inbound_reply_canary',
						status: 'verified',
						observed_at: now,
						canary_fingerprint: '6'.repeat(64),
						identity_fingerprint: identityFingerprint,
						plan_hash: '5'.repeat(64)
					},
					now
				}),
			/mailbox handoff fingerprint mismatch/u
		);
		const received = await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'verified',
			action: inbound,
			evidence: {
				kind: 'inbound_reply_canary',
				status: 'verified',
				observed_at: now,
				canary_fingerprint: canaryFingerprint,
				identity_fingerprint: identityFingerprint,
				plan_hash: '5'.repeat(64)
			},
			now
		});
		assert.equal(received.session.mailbox_handoff.status, 'inbound_verified');

		const mailbox = {
			id: 'mailbox-readback',
			stage: 'mailbox_mcp',
			kind: 'mailbox_readback',
			executor: 'mailbox.mcp',
			plan_hash: '7'.repeat(64)
		};
		await recordSetupAction({ workspaceRoot, stateRoot, phase: 'planned', action: mailbox, now });
		const completed = await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'verified',
			action: mailbox,
			evidence: {
				kind: 'mailbox_mcp_readback',
				status: 'verified',
				observed_at: now,
				canary_fingerprint: canaryFingerprint,
				identity_fingerprint: identityFingerprint,
				plan_hash: '7'.repeat(64),
				tools_fingerprint: '8'.repeat(64)
			},
			now
		});
		assert.equal(completed.session.mailbox_handoff.status, 'verified');
		assert.deepEqual(
			completed.session.stages.slice(9).map(({ status }) => status),
			['verified', 'verified', 'verified']
		);
		completed.session.mailbox_handoff = { status: 'pending' };
		await saveSetupJourney(completed.session, { stateRoot });
		const resumed = await resumeSetupJourney({ workspaceRoot, stateRoot });
		assert.equal(resumed.session.mailbox_handoff.status, 'verified');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('concurrent journey transitions cannot overwrite each other', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-concurrent-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	try {
		await recordSetupPreflight({ workspaceRoot, stateRoot, observations: readyPreflight(), now });
		const actionFor = (id) => ({
			id,
			stage: 'provider_login',
			kind: 'human_action',
			executor: 'human'
		});
		const results = await Promise.allSettled(
			['login-a', 'login-b'].map((id) =>
				recordSetupAction({
					workspaceRoot,
					stateRoot,
					phase: 'planned',
					action: actionFor(id),
					now
				})
			)
		);
		assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
		assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
		const resumed = await resumeSetupJourney({ workspaceRoot, stateRoot });
		assert.ok(['login-a', 'login-b'].includes(resumed.session.current_action.id));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('mission board is derived from state and shows all twelve stages', () => {
	const stages = SETUP_JOURNEY_STAGES.map((stage, index) => ({
		...stage,
		status: index === 0 ? 'verified' : index === 1 ? 'active' : 'pending'
	}));
	const board = renderMissionBoard({ stages });
	assert.match(board, /\[✓\] 準備を確認/u);
	assert.match(board, /\[→\] Cloudflare と Resend にログイン/u);
	assert.equal(board.split('\n').filter((line) => /^\[[✓→ !]\]/u.test(line)).length, 12);
});

function fingerprintForTest(value) {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
