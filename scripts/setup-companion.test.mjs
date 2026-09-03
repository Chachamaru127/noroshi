import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	ApprovalScopeLedger,
	SETUP_STAGE_ORDER,
	assessHostCapabilities,
	correlateCanaryEvidence,
	recoverBrowserSession,
	verifyDnsEvidence
} from './setup-companion.mjs';

class FakeBrowser {
	constructor(state) {
		this.state = { ...state };
		this.reads = 0;
	}

	async inspect() {
		this.reads += 1;
		return { ...this.state };
	}
}

const expectedIdentity = {
	account: 'account-fixture',
	zone: 'zone-fixture',
	domain: 'example.test'
};

function approvalLedgerFor(identity = expectedIdentity) {
	const ledger = new ApprovalScopeLedger();
	ledger.bindIdentity(identity);
	return ledger;
}

test('companion stage order covers the bounded setup and rollback journey', () => {
	assert.deepEqual(SETUP_STAGE_ORDER, [
		'preflight',
		'resend_authentication',
		'd1_r2',
		'migration',
		'deploy',
		'secrets',
		'email_routing',
		'first_admin',
		'outbound_send',
		'reply_receive',
		'rollback'
	]);
});

test('host capability preflight chooses manual fallbacks without claiming the Skill adds capabilities', () => {
	assert.deepEqual(
		assessHostCapabilities({
			computer_use: false,
			authenticated_browser: false,
			terminal: true,
			secret_entry: 'human'
		}),
		{
			browser_mode: 'manual',
			terminal_mode: 'assisted',
			secret_entry_mode: 'human_direct',
			missing: ['computer_use', 'authenticated_browser']
		}
	);
});

const approvalOperation = {
	target: { provider: 'cloudflare', zone: 'zone-fixture' },
	payload: { record_type: 'TXT', purpose: 'sender-authentication' },
	before: { records: [] },
	after: { records: [{ type: 'TXT', purpose: 'sender-authentication' }] },
	rollback: { mode: 'restore_snapshot', snapshot_fingerprint: 'b'.repeat(64) },
	plan_hash: 'a'.repeat(64),
	expires_at: '2026-08-31T12:30:00.000Z'
};

test('bundled approval allocates distinct exact one-use grants without a new prompt', () => {
	const ledger = approvalLedgerFor();
	ledger.approve({ ...approvalOperation, count: 2 });
	assert.deepEqual(ledger.consume(approvalOperation, { now: '2026-08-31T12:00:00.000Z' }), {
		status: 'approved',
		unused_grants: 1
	});
	assert.deepEqual(ledger.consume(approvalOperation, { now: '2026-08-31T12:00:01.000Z' }), {
		status: 'approved',
		unused_grants: 0
	});
	assert.deepEqual(ledger.consume(approvalOperation, { now: '2026-08-31T12:00:02.000Z' }), {
		status: 'approval_required',
		reason: 'exhausted'
	});
});

test('approval ledger stops for any changed exact-plan field or an expired grant', () => {
	const ledger = approvalLedgerFor();
	ledger.approve({ ...approvalOperation, count: 5 });
	for (const changed of [
		{ ...approvalOperation, target: { ...approvalOperation.target, zone: 'zone-b' } },
		{ ...approvalOperation, payload: { ...approvalOperation.payload, record_type: 'MX' } },
		{ ...approvalOperation, before: { records: [{ type: 'MX' }] } },
		{ ...approvalOperation, after: { records: [] } },
		{ ...approvalOperation, rollback: { mode: 'manual_review' } },
		{ ...approvalOperation, plan_hash: 'c'.repeat(64) }
	]) {
		assert.deepEqual(ledger.consume(changed, { now: '2026-08-31T12:00:00.000Z' }), {
			status: 'approval_required',
			reason: 'scope_changed'
		});
	}
	assert.deepEqual(ledger.consume(approvalOperation, { now: approvalOperation.expires_at }), {
		status: 'approval_required',
		reason: 'expired'
	});
});

test('approval ledger refuses secret-bearing scope data', () => {
	const ledger = approvalLedgerFor();
	assert.throws(
		() =>
			ledger.approve({
				...approvalOperation,
				payload: { api_key: 'must-not-enter-approval-state' },
				count: 1
			}),
		/plan data|not permitted/u
	);
});

test('approval ledger refuses to issue a grant before observed identity is bound', () => {
	const ledger = new ApprovalScopeLedger();
	assert.throws(
		() => ledger.approve({ ...approvalOperation, count: 1 }),
		/account, zone and domain identity/u
	);
});

test('browser recovery opens an allowlisted origin after tab loss and rereads identity', async () => {
	const browser = new FakeBrowser({
		tab: 'missing'
	});
	const opened = [];
	const result = await recoverBrowserSession(
		browser,
		{
			allowed_origins: ['https://dash.cloudflare.com'],
			expected_origin: 'https://dash.cloudflare.com',
			expected_dom_contract: 'current',
			expected_identity: expectedIdentity
		},
		{
			approvalLedger: approvalLedgerFor(),
			reacquire: async (origin) => {
				opened.push(origin);
				browser.state = {
					origin,
					tab: 'present',
					authenticated: true,
					dom_contract: 'current',
					...expectedIdentity
				};
			}
		}
	);
	assert.equal(result.status, 'ready');
	assert.equal(result.reacquired, true);
	assert.deepEqual(result.identity, expectedIdentity);
	assert.deepEqual(opened, ['https://dash.cloudflare.com']);
	assert.equal(browser.reads, 2);
});

test('browser recovery never opens a tab when the expected origin is not allowlisted', async () => {
	let opens = 0;
	const result = await recoverBrowserSession(
		new FakeBrowser({ tab: 'missing' }),
		{
			allowed_origins: ['https://resend.com'],
			expected_origin: 'https://dash.cloudflare.com',
			expected_dom_contract: 'current',
			expected_identity: expectedIdentity
		},
		{
			approvalLedger: approvalLedgerFor(),
			reacquire: async () => {
				opens += 1;
			}
		}
	);
	assert.equal(result.status, 'unexpected_origin');
	assert.equal(opens, 0);
});

test('identity changes invalidate every old exact grant even when its scope omits identity fields', async () => {
	for (const [field, value] of [
		['account', 'account-current'],
		['zone', 'zone-current'],
		['domain', 'other.example.test']
	]) {
		const ledger = approvalLedgerFor();
		ledger.approve({ ...approvalOperation, count: 2 });
		const currentIdentity = { ...expectedIdentity, [field]: value };
		const result = await recoverBrowserSession(
			new FakeBrowser({
				origin: 'https://dash.cloudflare.com',
				authenticated: true,
				dom_contract: 'current',
				...currentIdentity
			}),
			{
				allowed_origins: ['https://dash.cloudflare.com'],
				expected_origin: 'https://dash.cloudflare.com',
				expected_dom_contract: 'current',
				expected_identity: expectedIdentity
			},
			{ approvalLedger: ledger }
		);
		assert.equal(result.status, 'identity_changed');
		assert.equal(result.invalidated_grants, 2);
		assert.deepEqual(ledger.consume(approvalOperation, { now: '2026-08-31T12:00:00.000Z' }), {
			status: 'approval_required',
			reason: 'identity_invalidated'
		});
	}
});

test('missing identity invalidates old grants and requires explicit reapproval', async () => {
	const ledger = approvalLedgerFor();
	ledger.approve({ ...approvalOperation, count: 1 });
	const result = await recoverBrowserSession(
		new FakeBrowser({
			origin: 'https://dash.cloudflare.com',
			authenticated: true,
			dom_contract: 'current',
			account: 'account-fixture',
			zone: 'zone-fixture'
		}),
		{
			allowed_origins: ['https://dash.cloudflare.com'],
			expected_origin: 'https://dash.cloudflare.com',
			expected_dom_contract: 'current',
			expected_identity: expectedIdentity
		},
		{ approvalLedger: ledger }
	);
	assert.equal(result.status, 'identity_unavailable');
	assert.equal(result.invalidated_grants, 1);
	assert.deepEqual(ledger.consume(approvalOperation, { now: '2026-08-31T12:00:00.000Z' }), {
		status: 'approval_required',
		reason: 'identity_invalidated'
	});

	ledger.bindIdentity(expectedIdentity);
	ledger.approve({ ...approvalOperation, count: 1 });
	assert.deepEqual(ledger.consume(approvalOperation, { now: '2026-08-31T12:00:00.000Z' }), {
		status: 'approved',
		unused_grants: 0
	});
});

test('changed identity is rebound only by an explicit new approval', async () => {
	const ledger = approvalLedgerFor();
	ledger.approve({ ...approvalOperation, count: 1 });
	const changedIdentity = { ...expectedIdentity, account: 'account-current' };
	await recoverBrowserSession(
		new FakeBrowser({
			origin: 'https://dash.cloudflare.com',
			authenticated: true,
			dom_contract: 'current',
			...changedIdentity
		}),
		{
			allowed_origins: ['https://dash.cloudflare.com'],
			expected_origin: 'https://dash.cloudflare.com',
			expected_dom_contract: 'current',
			expected_identity: expectedIdentity
		},
		{ approvalLedger: ledger }
	);
	assert.deepEqual(ledger.consume(approvalOperation, { now: '2026-08-31T12:00:00.000Z' }), {
		status: 'approval_required',
		reason: 'identity_invalidated'
	});
	ledger.approve({ ...approvalOperation, count: 1 });
	assert.deepEqual(ledger.consume(approvalOperation, { now: '2026-08-31T12:00:00.000Z' }), {
		status: 'approved',
		unused_grants: 0
	});
});

test('browser recovery stops on session expiry, unexpected origin and DOM drift', async () => {
	const expected = {
		allowed_origins: ['https://dash.cloudflare.com', 'https://resend.com'],
		expected_origin: 'https://dash.cloudflare.com',
		expected_dom_contract: 'current',
		expected_identity: {
			account: 'account-fixture',
			zone: 'zone-fixture',
			domain: 'example.test'
		}
	};
	for (const [state, reason] of [
		[{ origin: expected.expected_origin, authenticated: false }, 'human_reauthentication'],
		[{ origin: 'https://lookalike.invalid', authenticated: true }, 'unexpected_origin'],
		[{ origin: 'https://resend.com', authenticated: true }, 'unexpected_origin'],
		[
			{
				origin: expected.expected_origin,
				authenticated: true,
				dom_contract: 'changed'
			},
			'official_dom_changed'
		]
	]) {
		const ledger = approvalLedgerFor();
		ledger.approve({ ...approvalOperation, count: 1 });
		assert.equal(
			(
				await recoverBrowserSession(new FakeBrowser(state), expected, {
					approvalLedger: ledger
				})
			).status,
			reason
		);
		assert.deepEqual(ledger.consume(approvalOperation, { now: '2026-08-31T12:00:00.000Z' }), {
			status: 'approval_required',
			reason: 'identity_invalidated'
		});
	}
});

test('browser recovery requires complete account zone and domain identity', async () => {
	const result = await recoverBrowserSession(
		new FakeBrowser({
			origin: 'https://dash.cloudflare.com',
			authenticated: true,
			dom_contract: 'current',
			account: 'account-fixture',
			zone: 'zone-fixture'
		}),
		{
			allowed_origins: ['https://dash.cloudflare.com'],
			expected_origin: 'https://dash.cloudflare.com',
			expected_dom_contract: 'current',
			expected_identity: {
				account: 'account-fixture',
				zone: 'zone-fixture',
				domain: 'example.test'
			}
		},
		{ approvalLedger: approvalLedgerFor() }
	);
	assert.equal(result.status, 'identity_unavailable');
});

test('clipboard split never asks the model to recover or display a secret', async () => {
	const result = await recoverBrowserSession(
		new FakeBrowser({
			origin: 'https://resend.com',
			authenticated: true,
			dom_contract: 'current',
			account: 'team-fixture',
			zone: 'send-domain-fixture',
			domain: 'example.test',
			clipboard: 'isolated'
		}),
		{
			allowed_origins: ['https://resend.com'],
			expected_origin: 'https://resend.com',
			expected_dom_contract: 'current',
			expected_identity: {
				account: 'team-fixture',
				zone: 'send-domain-fixture',
				domain: 'example.test'
			}
		},
		{
			approvalLedger: approvalLedgerFor({
				account: 'team-fixture',
				zone: 'send-domain-fixture',
				domain: 'example.test'
			})
		}
	);
	assert.deepEqual(result, {
		status: 'human_secret_entry_required',
		allowed_methods: ['human_direct', 'secret_input_broker'],
		display_secret: false
	});
});

test('resume invalidates grants for changed identity before considering clipboard fallback', async () => {
	const ledger = approvalLedgerFor({
		account: 'account-stale',
		zone: 'zone-stale',
		domain: 'example.test'
	});
	ledger.approve({ ...approvalOperation, count: 1 });
	const result = await recoverBrowserSession(
		new FakeBrowser({
			origin: 'https://dash.cloudflare.com',
			authenticated: true,
			dom_contract: 'current',
			account: 'account-current',
			zone: 'zone-current',
			domain: 'example.test',
			clipboard: 'isolated'
		}),
		{
			allowed_origins: ['https://dash.cloudflare.com'],
			expected_origin: 'https://dash.cloudflare.com',
			expected_dom_contract: 'current',
			expected_identity: {
				account: 'account-stale',
				zone: 'zone-stale',
				domain: 'example.test'
			}
		},
		{ approvalLedger: ledger }
	);
	assert.equal(result.status, 'identity_changed');
	assert.equal(result.requires_new_approval, true);
	assert.equal(result.invalidated_grants, 1);
	assert.deepEqual(ledger.consume(approvalOperation, { now: '2026-08-31T12:00:00.000Z' }), {
		status: 'approval_required',
		reason: 'identity_invalidated'
	});
});

test('canary completion requires the same non-secret token across all independent surfaces', () => {
	const token = 'canary-fixture-01';
	const complete = Object.fromEntries(
		['email_routing_activity', 'worker_d1', 'resend', 'noroshi_ui'].map((surface) => [
			surface,
			{ token, status: 'observed' }
		])
	);
	assert.deepEqual(correlateCanaryEvidence(complete), {
		status: 'verified',
		token,
		surfaces: Object.keys(complete)
	});
	assert.deepEqual(
		correlateCanaryEvidence({ ...complete, resend: { token: 'other', status: 'observed' } }),
		{ status: 'incomplete', missing_or_mismatched: ['resend'] }
	);
});

test('canary evidence rejects unbounded or secret-like tokens without reflecting them', () => {
	for (const token of [
		'',
		'canary-x',
		`canary-${'a'.repeat(80)}`,
		['re', 'provider-value'].join('_'),
		'canary-sk-live-provider-value',
		'canary-re-provider-value',
		'canary-secret-value',
		'canary-token-value',
		'canary-has whitespace',
		'canary-日本語'
	]) {
		const evidence = Object.fromEntries(
			['email_routing_activity', 'worker_d1', 'resend', 'noroshi_ui'].map((surface) => [
				surface,
				{ token, status: 'observed' }
			])
		);
		assert.deepEqual(correlateCanaryEvidence(evidence), {
			status: 'incomplete',
			reason: 'invalid_canary_token'
		});
	}
});

test('DNS completion compares domain and configuration fingerprint without an email token', () => {
	const observation = {
		domain: 'example.test',
		configuration_fingerprint: 'd'.repeat(64),
		mx: ['mx1.example.invalid', 'mx2.example.invalid'],
		txt: ['v=spf1 include:example.invalid -all']
	};
	assert.deepEqual(
		verifyDnsEvidence({ authoritative_dns: observation, public_resolver: observation }),
		{ status: 'verified', domain: 'example.test', configuration_fingerprint: 'd'.repeat(64) }
	);
	assert.deepEqual(
		verifyDnsEvidence({
			authoritative_dns: observation,
			public_resolver: { ...observation, configuration_fingerprint: 'e'.repeat(64) }
		}),
		{ status: 'incomplete', reason: 'dns_evidence_mismatch' }
	);
});
