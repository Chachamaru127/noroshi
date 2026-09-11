import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
		mailbox_mcp: 'available'
	};
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
			['resend_account', 'ready'],
			['resend_login', 'ready'],
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

test('ChatGPT Work preflight requires developer mode and Secure MCP Tunnel', () => {
	const result = assessSetupPreflight({
		...readyPreflight(),
		target_host: 'chatgpt_work',
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
		const first = await createSetupJourney({ workspaceRoot: workspace, stateRoot, now });
		assert.equal(first.schema_version, SETUP_JOURNEY_SCHEMA_VERSION);
		assert.equal(first.stages.length, 12);
		assert.deepEqual(
			first.stages.map(({ id }) => id),
			SETUP_JOURNEY_STAGES.map(({ id }) => id)
		);
		first.inputs = {
			domain: 'example.test',
			test_recipient: 'tester@example.net',
			existing_mail: 'none'
		};
		first.stages[0].status = 'verified';
		await saveSetupJourney(first, { stateRoot });

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
			{ cookies: ['browser-cookie'] }
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
			executor: 'host.terminal',
			plan_hash: 'a'.repeat(64),
			readback: { capability: 'cloudflare.inspect_d1', target: 'noroshi' }
		};
		await saveSetupJourney(session, { stateRoot });
		const resumed = await resumeSetupJourney({ workspaceRoot, stateRoot });
		assert.deepEqual(resumed.next_action, {
			id: 'create-d1-01-readback',
			stage: 'd1_r2',
			kind: 'readback',
			status: 'planned',
			executor: 'host.terminal',
			retry: 'readback_only',
			readback: { capability: 'cloudflare.inspect_d1', target: 'noroshi' }
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
			evidence: { kind: 'human_readback', status: 'verified', observed_at: now },
			stageComplete: true,
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
			action: writeAction,
			evidence: {
				kind: 'provider_readback',
				status: 'verified',
				state_fingerprint: 'b'.repeat(64),
				observed_at: now
			},
			stageComplete: true,
			now
		});
		assert.equal(verified.session.stages[2].status, 'verified');
		assert.equal(verified.session.stages[3].status, 'active');
		assert.equal(verified.session.current_action, null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('journey refuses out-of-order verification and secret-bearing evidence', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'noroshi-journey-order-'));
	const workspaceRoot = join(directory, 'workspace');
	const stateRoot = join(directory, 'state');
	try {
		await createSetupJourney({ workspaceRoot, stateRoot, now });
		const action = {
			id: 'out-of-order',
			stage: 'deploy',
			kind: 'human_action',
			executor: 'human'
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
		await recordSetupAction({
			workspaceRoot,
			stateRoot,
			phase: 'planned',
			action: preflight,
			now
		});
		await assert.rejects(
			() =>
				recordSetupAction({
					workspaceRoot,
					stateRoot,
					phase: 'verified',
					action: preflight,
					evidence: { kind: 'human_readback', status: 'verified', api_key: 'forbidden' },
					stageComplete: true,
					now
				}),
			/not permitted in setup state/u
		);
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
