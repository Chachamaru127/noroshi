import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createAtomicSetupStateStore, fingerprint } from './setup-engine.mjs';

const LEGACY_SETUP_JOURNEY_SCHEMA_VERSION = 'noroshi.setup-journey.v1';
export const SETUP_JOURNEY_SCHEMA_VERSION = 'noroshi.setup-journey.v2';

export const SETUP_JOURNEY_STAGES = Object.freeze([
	Object.freeze({ id: 'preflight', label: '準備を確認' }),
	Object.freeze({ id: 'provider_login', label: 'Cloudflare と Resend にログイン' }),
	Object.freeze({ id: 'resend_authentication', label: 'Resend の送信ドメインを認証' }),
	Object.freeze({ id: 'd1_r2', label: 'メール保存先の D1 と R2 を用意' }),
	Object.freeze({ id: 'migration', label: 'データベースを準備' }),
	Object.freeze({ id: 'deploy', label: 'Noroshi をデプロイ' }),
	Object.freeze({ id: 'secrets', label: '秘密値を安全に登録' }),
	Object.freeze({ id: 'email_routing', label: 'Cloudflare Email Routing を接続' }),
	Object.freeze({ id: 'first_admin', label: '最初の管理者を作成' }),
	Object.freeze({ id: 'outbound_send', label: '送信テストを確認' }),
	Object.freeze({ id: 'inbound_reply', label: '返信の受信を確認' }),
	Object.freeze({ id: 'mailbox_mcp', label: 'Mailbox MCP からメールを確認' })
]);

const JOURNEY_STAGE_IDS = new Set(SETUP_JOURNEY_STAGES.map(({ id }) => id));
const STAGE_STATUSES = new Set(['pending', 'active', 'blocked', 'verified']);
const CHECK_STATUSES = new Set(['ready', 'user_action', 'blocked', 'skipped']);
const SESSION_FIELDS = new Set([
	'schema_version',
	'session_id',
	'created_at',
	'updated_at',
	'workspace',
	'host',
	'inputs',
	'identity',
	'preflight',
	'stages',
	'current_action',
	'mailbox_handoff'
]);
const ACTION_FIELDS = new Set([
	'id',
	'stage',
	'kind',
	'executor',
	'plan_hash',
	'retry',
	'readback'
]);
const ACTION_READBACK_FIELDS = new Set([
	'capability',
	'target_fingerprint',
	'plan_hash',
	'identity_fingerprint',
	'canary_fingerprint'
]);
const EVIDENCE_COMMON_FIELDS = new Set(['kind', 'status', 'observed_at']);
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const EXISTING_MAIL_VALUES = new Set(['none', 'active', 'unknown']);
const HOST_VALUES = new Set(['codex', 'chatgpt_desktop', 'chatgpt_work']);
const MAILBOX_HANDOFF_STATUSES = new Set([
	'pending',
	'outbound_verified',
	'inbound_verified',
	'verified'
]);
const PREFLIGHT_STATUSES = new Set(['ready', 'user_action', 'blocked']);
const PREFLIGHT_DETAIL_FIELDS = new Set([
	'reason',
	'required_version',
	'observed_version',
	'official_url',
	'copy_command'
]);
const PREFLIGHT_URL_HOSTS = new Set([
	'bun.sh',
	'developers.cloudflare.com',
	'dash.cloudflare.com',
	'resend.com',
	'help.openai.com',
	'developers.openai.com'
]);
const PROVIDER_VERIFICATION_STAGES = new Set([
	'resend_authentication',
	'd1_r2',
	'migration',
	'deploy',
	'secrets',
	'email_routing'
]);
const PLAN_BOUND_STAGES = new Set([
	...PROVIDER_VERIFICATION_STAGES,
	'outbound_send',
	'inbound_reply',
	'mailbox_mcp'
]);
const EXECUTOR_BY_ACTION_KIND = Object.freeze({
	provider_write: 'host.adapter',
	human_action: 'human',
	readback: 'host.readback',
	mailbox_readback: 'mailbox.mcp'
});
const ACTION_KINDS_BY_STAGE = new Map([
	['provider_login', new Set(['human_action', 'readback'])],
	...Array.from(PROVIDER_VERIFICATION_STAGES, (stage) => [
		stage,
		new Set(['provider_write', 'human_action', 'readback'])
	]),
	['first_admin', new Set(['provider_write', 'human_action', 'readback'])],
	['outbound_send', new Set(['provider_write', 'readback'])],
	['inbound_reply', new Set(['human_action', 'readback'])],
	['mailbox_mcp', new Set(['mailbox_readback'])]
]);
const READBACK_CAPABILITIES = new Set([
	'provider.identity',
	'setup.inspect_stage',
	'cloudflare.inspect_accounts',
	'cloudflare.inspect_zones',
	'cloudflare.inspect_zone',
	'cloudflare.inspect_d1',
	'cloudflare.inspect_r2',
	'cloudflare.inspect_workers',
	'cloudflare.inspect_email_routing',
	'resend.inspect_team',
	'resend.inspect_domain',
	'resend.inspect_webhooks',
	'resend.inspect_api_keys',
	'resend.inspect_delivery',
	'resend.verify_domain',
	'noroshi.inspect_first_admin',
	'noroshi.inspect_inbound_reply',
	'noroshi.mailbox_mcp_readback'
]);
const BLOCK_REASON_CODES = new Set([
	'capability_unavailable',
	'identity_changed',
	'preflight_blocked',
	'provider_read_failed',
	'read_failed',
	'readback_failed',
	'readback_mismatch',
	'unknown_write_outcome',
	'user_action_required'
]);
const SECRET_LIKE_IDENTIFIER =
	/(?:api[-_.]?key|authorization|bearer|cookie|credential|password|token)/iu;

function defaultStateRoot() {
	const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
	return join(base, 'noroshi', 'setup-sessions');
}

function canonicalWorkspacePath(workspaceRoot) {
	if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
		throw new TypeError('workspaceRoot is required');
	}
	const requested = resolve(workspaceRoot);
	let candidate = requested;
	const missingSegments = [];
	while (true) {
		try {
			return join(realpathSync.native(candidate), ...missingSegments);
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
			const parent = dirname(candidate);
			if (parent === candidate) throw error;
			missingSegments.unshift(basename(candidate));
			candidate = parent;
		}
	}
}

function rejectUnknownFields(value, allowed, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not permitted in setup state`);
	}
}

function requireString(value, label) {
	if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
	return value;
}

function requireFingerprint(value, label) {
	if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
		throw new TypeError(`${label} requires a SHA-256 fingerprint`);
	}
	return value;
}

function requireTimestamp(value, label) {
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
		throw new TypeError(`${label} requires an observed_at timestamp`);
	}
	return value;
}

function requireSafeIdentifier(value, label) {
	const candidate = requireString(value, label);
	if (candidate.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(candidate)) {
		throw new TypeError(`${label} must be a bounded identifier`);
	}
	return candidate;
}

function requirePublicIdentifier(value, label) {
	const candidate = requireSafeIdentifier(value, label);
	if (SECRET_LIKE_IDENTIFIER.test(candidate)) {
		throw new TypeError(`${label} must be a public identifier`);
	}
	return candidate;
}

function validateStoredPreflight(preflight) {
	rejectUnknownFields(preflight, new Set(['status', 'checks']), 'setup journey preflight');
	if (!PREFLIGHT_STATUSES.has(preflight.status)) {
		throw new TypeError('setup journey preflight status is invalid');
	}
	const expectedChecks = assessSetupPreflight({}).checks;
	if (!Array.isArray(preflight.checks) || preflight.checks.length !== expectedChecks.length) {
		throw new TypeError('setup journey preflight checks are incomplete');
	}
	for (const [index, observed] of preflight.checks.entries()) {
		const expected = expectedChecks[index];
		rejectUnknownFields(
			observed,
			new Set(['id', 'label', 'status', ...PREFLIGHT_DETAIL_FIELDS]),
			'setup journey preflight check'
		);
		if (observed.id !== expected.id || observed.label !== expected.label) {
			throw new TypeError('setup journey preflight check order is invalid');
		}
		if (!CHECK_STATUSES.has(observed.status)) {
			throw new TypeError(`setup journey preflight status for ${observed.id} is invalid`);
		}
		if (observed.reason !== undefined) {
			requireSafeIdentifier(observed.reason, `setup journey preflight ${observed.id}.reason`);
		}
		for (const field of ['required_version', 'observed_version']) {
			if (observed[field] !== undefined && observed[field] !== null) {
				const version = requireString(
					observed[field],
					`setup journey preflight ${observed.id}.${field}`
				);
				if (version.length > 64 || !/^[A-Za-z0-9.+_-]+$/u.test(version)) {
					throw new TypeError(`setup journey preflight ${observed.id}.${field} is invalid`);
				}
			}
		}
		if (observed.official_url !== undefined) {
			const url = new URL(
				requireString(observed.official_url, `setup journey preflight ${observed.id}.official_url`)
			);
			if (url.protocol !== 'https:' || !PREFLIGHT_URL_HOSTS.has(url.hostname)) {
				throw new TypeError(`setup journey preflight ${observed.id}.official_url is invalid`);
			}
		}
		if (observed.copy_command !== undefined) {
			const command = requireString(
				observed.copy_command,
				`setup journey preflight ${observed.id}.copy_command`
			);
			if (
				command !== 'bun install --frozen-lockfile' &&
				!/^bun --version # required: [A-Za-z0-9.+_-]+$/u.test(command)
			) {
				throw new TypeError(`setup journey preflight ${observed.id}.copy_command is invalid`);
			}
		}
	}
	const derivedStatus = preflight.checks.some(({ status }) => status === 'blocked')
		? 'blocked'
		: preflight.checks.some(({ status }) => status === 'user_action')
			? 'user_action'
			: 'ready';
	if (preflight.status !== derivedStatus) {
		throw new TypeError('setup journey preflight aggregate status is invalid');
	}
}

export function resolveJourneyStatePath(workspaceRoot, { stateRoot = defaultStateRoot() } = {}) {
	const workspacePath = canonicalWorkspacePath(workspaceRoot);
	const root = resolve(stateRoot);
	const workspaceKey = fingerprint({ workspace_path: workspacePath }).slice(0, 24);
	return join(root, `workspace-${workspaceKey}.json`);
}

function check(id, label, status, details = {}) {
	if (!CHECK_STATUSES.has(status)) throw new TypeError(`invalid preflight status for ${id}`);
	return { id, label, status, ...details };
}

function directCapabilityStatus(value) {
	if (value === 'ready') return 'ready';
	if (value === 'unavailable' || value === 'unknown' || value === undefined) return 'user_action';
	return 'blocked';
}

function accountStatus(value) {
	return value === 'present'
		? 'ready'
		: value === 'missing' || value === 'unknown'
			? 'user_action'
			: 'blocked';
}

function loginStatus(value) {
	return value === 'ready'
		? 'ready'
		: value === 'signed_out' || value === 'unknown'
			? 'user_action'
			: 'blocked';
}

function valueStatus(value, readyValues) {
	return readyValues.includes(value)
		? 'ready'
		: value === 'unknown' || value === undefined
			? 'blocked'
			: 'user_action';
}

export function assessSetupPreflight(input = {}) {
	const browserStatus = directCapabilityStatus(input.browser);
	const computerStatus = directCapabilityStatus(input.computer);
	const nativeBrowserControl = browserStatus === 'ready' || computerStatus === 'ready';
	const chromeFallbackReady = !nativeBrowserControl && input.chrome_extension === 'ready';
	const effectiveBrowserControl = nativeBrowserControl || chromeFallbackReady;
	const capabilityStatus = (status) =>
		effectiveBrowserControl && status === 'user_action' ? 'skipped' : status;
	const requiredBun = String(input.bun?.required ?? '1.3.14');
	const bunReady = input.bun?.available === true && input.bun?.version === requiredBun;
	const wranglerReady = input.wrangler?.available === true && input.wrangler?.source === 'repo';
	const cloudflareAccount = accountStatus(input.cloudflare?.account);
	const resendAccount = accountStatus(input.resend?.account);
	const domainReady =
		typeof input.domain?.value === 'string' &&
		input.domain.value.trim().length > 0 &&
		input.domain?.ownership === 'confirmed';
	const recipientReady =
		typeof input.test_recipient?.value === 'string' &&
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.test_recipient.value) &&
		input.test_recipient.controlled_by_user === true;
	const hostedChatGptWeb = input.target_host === 'chatgpt_work';
	const cloudflareIdentityReady = FINGERPRINT_PATTERN.test(
		input.identity?.cloudflare_fingerprint ?? ''
	);
	const resendIdentityReady = FINGERPRINT_PATTERN.test(input.identity?.resend_fingerprint ?? '');

	const checks = [
		check('browser', 'ブラウザ操作', capabilityStatus(browserStatus), {
			reason: browserStatus === 'ready' ? 'native_browser_available' : 'native_browser_unavailable'
		}),
		check('computer', 'コンピュータ操作', capabilityStatus(computerStatus), {
			reason:
				computerStatus === 'ready' ? 'native_computer_available' : 'native_computer_unavailable'
		}),
		check(
			'chrome_extension',
			'ChatGPT Chrome 拡張',
			nativeBrowserControl
				? 'skipped'
				: input.chrome_extension === 'ready'
					? 'ready'
					: input.chrome_extension === 'blocked'
						? 'blocked'
						: 'user_action',
			{
				reason: nativeBrowserControl
					? 'native_control_makes_extension_unnecessary'
					: 'fallback_required'
			}
		),
		check('terminal', 'ターミナル', directCapabilityStatus(input.terminal)),
		check('bun', 'Bun', bunReady ? 'ready' : 'blocked', {
			required_version: requiredBun,
			observed_version: input.bun?.version ?? null,
			official_url: 'https://bun.sh/docs/installation',
			copy_command: `bun --version # required: ${requiredBun}`
		}),
		check('wrangler', 'repo-local Wrangler', wranglerReady ? 'ready' : 'blocked', {
			reason: wranglerReady ? 'repo_local_wrangler_available' : 'repo_local_wrangler_missing',
			official_url: 'https://developers.cloudflare.com/workers/wrangler/install-and-update/',
			copy_command: 'bun install --frozen-lockfile'
		}),
		check('cloudflare_account', 'Cloudflare アカウント', cloudflareAccount, {
			official_url:
				input.cloudflare?.account === 'present'
					? 'https://dash.cloudflare.com/'
					: 'https://dash.cloudflare.com/sign-up'
		}),
		check('cloudflare_login', 'Cloudflare ログイン', loginStatus(input.cloudflare?.login), {
			official_url: 'https://dash.cloudflare.com/'
		}),
		check(
			'cloudflare_identity',
			'Cloudflare identity',
			cloudflareIdentityReady ? 'ready' : 'blocked'
		),
		check('resend_account', 'Resend アカウント', resendAccount, {
			official_url:
				input.resend?.account === 'present'
					? 'https://resend.com/login'
					: 'https://resend.com/signup'
		}),
		check('resend_login', 'Resend ログイン', loginStatus(input.resend?.login), {
			official_url: 'https://resend.com/login'
		}),
		check('resend_identity', 'Resend identity', resendIdentityReady ? 'ready' : 'blocked'),
		check('domain', '独自ドメイン', domainReady ? 'ready' : 'user_action'),
		check(
			'dns',
			'権威DNS、DNSSEC、TTL',
			['authoritative_nameservers', 'dnssec', 'ttl'].every((key) => input.dns?.[key] === 'observed')
				? 'ready'
				: 'blocked'
		),
		check('current_mx', '現在の MX レコード', valueStatus(input.current_mx?.status, ['observed'])),
		check('test_recipient', '本人管理のテスト受信先', recipientReady ? 'ready' : 'user_action'),
		check(
			'mailbox_mcp',
			'読み取り専用 Mailbox MCP',
			input.mailbox_mcp === 'available' ? 'ready' : 'user_action'
		),
		check(
			'chatgpt_developer_mode',
			'ChatGPT Web developer mode',
			hostedChatGptWeb
				? input.chatgpt_developer_mode === 'ready'
					? 'ready'
					: 'user_action'
				: 'skipped',
			{
				official_url:
					'https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta'
			}
		),
		check(
			'secure_mcp_tunnel',
			'OpenAI Secure MCP Tunnel（hostedのみ）',
			hostedChatGptWeb
				? input.secure_mcp_tunnel === 'ready'
					? 'ready'
					: 'user_action'
				: 'skipped',
			{
				official_url: 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels'
			}
		)
	];

	return {
		status: checks.some(({ status }) => status === 'blocked')
			? 'blocked'
			: checks.some(({ status }) => status === 'user_action')
				? 'user_action'
				: 'ready',
		checks
	};
}

function evidenceContract(stage, kind) {
	if (kind === 'blocked') {
		return { fields: ['reason_code'], fingerprints: [], complete: false, status: 'blocked' };
	}
	if (stage === 'provider_login' && kind === 'provider_identity') {
		return {
			fields: ['cloudflare_identity_fingerprint', 'resend_identity_fingerprint'],
			fingerprints: ['cloudflare_identity_fingerprint', 'resend_identity_fingerprint'],
			complete: true,
			status: 'verified'
		};
	}
	if (
		PROVIDER_VERIFICATION_STAGES.has(stage) &&
		['provider_readback', 'stage_verification'].includes(kind)
	) {
		return {
			fields: ['state_fingerprint', 'plan_hash'],
			fingerprints: ['state_fingerprint', 'plan_hash'],
			complete: kind === 'stage_verification',
			status: 'verified'
		};
	}
	if (stage === 'first_admin' && kind === 'first_admin_readback') {
		return {
			fields: ['identity_fingerprint', 'setup_key_invalidated'],
			fingerprints: ['identity_fingerprint'],
			complete: true,
			status: 'verified'
		};
	}
	if (stage === 'outbound_send' && kind === 'outbound_canary') {
		return {
			fields: [
				'canary_fingerprint',
				'identity_fingerprint',
				'plan_hash',
				'idempotency_key_fingerprint'
			],
			fingerprints: [
				'canary_fingerprint',
				'identity_fingerprint',
				'plan_hash',
				'idempotency_key_fingerprint'
			],
			optional: ['provider_result_id'],
			complete: true,
			status: 'verified'
		};
	}
	if (stage === 'inbound_reply' && kind === 'inbound_reply_canary') {
		return {
			fields: ['canary_fingerprint', 'identity_fingerprint', 'plan_hash'],
			fingerprints: ['canary_fingerprint', 'identity_fingerprint', 'plan_hash'],
			complete: true,
			status: 'verified'
		};
	}
	if (stage === 'mailbox_mcp' && kind === 'mailbox_mcp_readback') {
		return {
			fields: ['canary_fingerprint', 'identity_fingerprint', 'plan_hash', 'tools_fingerprint'],
			fingerprints: [
				'canary_fingerprint',
				'identity_fingerprint',
				'plan_hash',
				'tools_fingerprint'
			],
			complete: true,
			status: 'verified'
		};
	}
	throw new TypeError(`setup evidence kind ${kind} is not permitted for ${stage}`);
}

function normalizeJourneyEvidence(stage, evidence, { stored = false } = {}) {
	if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
		throw new TypeError('setup evidence must be an object');
	}
	const kind = requireString(evidence.kind, 'setup evidence kind');
	const contract = evidenceContract(stage, kind);
	rejectUnknownFields(
		evidence,
		new Set([
			...EVIDENCE_COMMON_FIELDS,
			...(stored ? ['action_id'] : []),
			...contract.fields,
			...(contract.optional ?? [])
		]),
		'setup evidence'
	);
	if (stored) requirePublicIdentifier(evidence.action_id, 'setup evidence action_id');
	if (evidence.status !== contract.status) {
		throw new TypeError(`setup evidence ${kind} requires status ${contract.status}`);
	}
	requireTimestamp(evidence.observed_at, `setup evidence ${kind}`);
	for (const field of contract.fields) {
		if (field === 'setup_key_invalidated') {
			if (evidence[field] !== true) {
				throw new TypeError(`setup evidence ${kind} requires ${field}=true`);
			}
		} else if (field === 'reason_code') {
			if (!BLOCK_REASON_CODES.has(evidence[field])) {
				throw new TypeError('setup evidence reason code is not permitted');
			}
		} else {
			requireString(evidence[field], `setup evidence ${kind}.${field}`);
		}
	}
	for (const field of contract.fingerprints) {
		requireFingerprint(evidence[field], `setup evidence ${kind}.${field}`);
	}
	for (const field of contract.optional ?? []) {
		if (evidence[field] !== undefined) {
			requirePublicIdentifier(evidence[field], `setup evidence ${kind}.${field}`);
		}
	}
	return { evidence: JSON.parse(JSON.stringify(evidence)), completesStage: contract.complete };
}

function normalizeJourneyAction(action) {
	rejectUnknownFields(action, ACTION_FIELDS, 'setup action');
	const id = requirePublicIdentifier(action.id, 'setup action id');
	for (const key of ['stage', 'kind', 'executor'])
		requireString(action[key], `setup action ${key}`);
	if (!JOURNEY_STAGE_IDS.has(action.stage)) throw new TypeError('setup action stage is invalid');
	if (action.stage === 'preflight') {
		throw new TypeError('setup action for preflight is not permitted in setup state');
	}
	const expectedExecutor = EXECUTOR_BY_ACTION_KIND[action.kind];
	if (!expectedExecutor || !ACTION_KINDS_BY_STAGE.get(action.stage)?.has(action.kind)) {
		throw new TypeError('setup action kind is invalid');
	}
	if (action.executor !== expectedExecutor) {
		throw new TypeError(`setup action ${action.kind} requires fixed executor ${expectedExecutor}`);
	}
	if (
		action.retry !== undefined &&
		(action.kind !== 'readback' || action.retry !== 'readback_only')
	) {
		throw new TypeError('setup action retry is invalid');
	}
	if (PLAN_BOUND_STAGES.has(action.stage)) {
		requireFingerprint(action.plan_hash, 'plan-bound setup action plan_hash');
	} else if (action.plan_hash !== undefined) {
		requireFingerprint(action.plan_hash, 'setup action plan_hash');
	}
	if (action.kind === 'provider_write') {
		if (!action.readback) throw new TypeError('provider write action requires readback');
	}
	const normalized = { ...action, id };
	if (action.readback !== undefined) {
		rejectUnknownFields(action.readback, ACTION_READBACK_FIELDS, 'setup action readback');
		if (!READBACK_CAPABILITIES.has(action.readback.capability)) {
			throw new TypeError('setup action readback capability is not permitted');
		}
		for (const [key, value] of Object.entries(action.readback)) {
			if (key !== 'capability') {
				requireFingerprint(value, `setup action readback ${key}`);
			}
		}
		if (action.readback.plan_hash !== undefined && action.readback.plan_hash !== action.plan_hash) {
			throw new TypeError('setup action readback plan_hash does not match action');
		}
		normalized.readback = { ...action.readback };
	}
	return JSON.parse(JSON.stringify(normalized));
}

function validateStages(stages) {
	if (!Array.isArray(stages) || stages.length !== SETUP_JOURNEY_STAGES.length) {
		throw new TypeError('setup journey stages are incomplete');
	}
	for (const [index, stage] of stages.entries()) {
		rejectUnknownFields(
			stage,
			new Set(['id', 'label', 'status', 'evidence']),
			'setup journey stage'
		);
		if (stage?.id !== SETUP_JOURNEY_STAGES[index].id || !JOURNEY_STAGE_IDS.has(stage.id)) {
			throw new TypeError('setup journey stage order is invalid');
		}
		if (stage.label !== SETUP_JOURNEY_STAGES[index].label) {
			throw new TypeError('setup journey stage label is invalid');
		}
		if (!STAGE_STATUSES.has(stage.status)) {
			throw new TypeError(`invalid setup journey stage status for ${stage.id}`);
		}
		if (stage.evidence !== undefined) {
			if (!Array.isArray(stage.evidence))
				throw new TypeError('setup journey stage evidence must be an array');
			for (const evidence of stage.evidence)
				normalizeJourneyEvidence(stage.id, evidence, { stored: true });
		}
	}
}

function completionEvidence(stage) {
	return [...(stage.evidence ?? [])]
		.reverse()
		.find(
			(evidence) =>
				evidence.status === 'verified' && evidenceContract(stage.id, evidence.kind).complete
		);
}

function rederiveMailboxHandoff(session) {
	rejectUnknownFields(
		session.mailbox_handoff,
		new Set(['status', 'canary_fingerprint', 'identity_fingerprint']),
		'setup journey mailbox_handoff'
	);
	const outbound = completionEvidence(session.stages[9]);
	const inbound = completionEvidence(session.stages[10]);
	const mailbox = completionEvidence(session.stages[11]);
	let expected = { status: 'pending' };
	if (outbound) {
		expected = {
			status: 'outbound_verified',
			canary_fingerprint: outbound.canary_fingerprint,
			identity_fingerprint: outbound.identity_fingerprint
		};
	}
	for (const [stage, evidence, status] of [
		['inbound_reply', inbound, 'inbound_verified'],
		['mailbox_mcp', mailbox, 'verified']
	]) {
		if (!evidence) continue;
		if (
			expected.status === 'pending' ||
			expected.canary_fingerprint !== evidence.canary_fingerprint ||
			expected.identity_fingerprint !== evidence.identity_fingerprint
		) {
			throw new TypeError(`${stage} mailbox handoff fingerprint mismatch`);
		}
		expected.status = status;
	}
	if (JSON.stringify(session.mailbox_handoff) === JSON.stringify(expected)) return false;
	session.mailbox_handoff = expected;
	return true;
}

function rederiveStageStatuses(session) {
	let changed = false;
	let previousStagesVerified = true;
	for (const [index, stage] of session.stages.entries()) {
		let status;
		if (index === 0) {
			status =
				session.preflight === undefined
					? 'pending'
					: session.preflight.status === 'ready'
						? 'verified'
						: session.preflight.status === 'blocked'
							? 'blocked'
							: 'active';
		} else if (completionEvidence(stage)) {
			status = 'verified';
		} else {
			const lastEvidence = stage.evidence?.at(-1);
			if (session.current_action?.stage === stage.id) {
				status =
					session.current_action.status === 'blocked' || lastEvidence?.status === 'blocked'
						? 'blocked'
						: 'active';
			} else if (lastEvidence?.status === 'blocked') {
				status = 'blocked';
			} else {
				status = previousStagesVerified ? 'active' : 'pending';
			}
		}
		if (stage.status !== status) {
			stage.status = status;
			changed = true;
		}
		previousStagesVerified = previousStagesVerified && status === 'verified';
	}
	return changed;
}

function rederiveJourneyProgress(session) {
	const stageChanged = rederiveStageStatuses(session);
	return rederiveMailboxHandoff(session) || stageChanged;
}

function advanceMailboxHandoff(session, stage, evidence) {
	if (stage === 'outbound_send') {
		session.mailbox_handoff = {
			status: 'outbound_verified',
			canary_fingerprint: evidence.canary_fingerprint,
			identity_fingerprint: evidence.identity_fingerprint
		};
		return;
	}
	if (!['inbound_reply', 'mailbox_mcp'].includes(stage)) return;
	const expectedStatus = stage === 'inbound_reply' ? 'outbound_verified' : 'inbound_verified';
	if (
		session.mailbox_handoff.status !== expectedStatus ||
		session.mailbox_handoff.canary_fingerprint !== evidence.canary_fingerprint ||
		session.mailbox_handoff.identity_fingerprint !== evidence.identity_fingerprint
	) {
		throw new TypeError('mailbox handoff fingerprint mismatch');
	}
	session.mailbox_handoff = {
		...session.mailbox_handoff,
		status: stage === 'inbound_reply' ? 'inbound_verified' : 'verified'
	};
}

function validateJourney(session) {
	rejectUnknownFields(session, SESSION_FIELDS, 'setup journey');
	if (session.schema_version !== SETUP_JOURNEY_SCHEMA_VERSION) {
		throw new TypeError('unsupported setup journey schema');
	}
	requireSafeIdentifier(session.session_id, 'setup journey session_id');
	requireTimestamp(session.created_at, 'setup journey created_at');
	requireTimestamp(session.updated_at, 'setup journey updated_at');
	rejectUnknownFields(session.workspace, new Set(['path', 'revision']), 'setup journey workspace');
	const canonicalPath = canonicalWorkspacePath(session.workspace.path);
	if (session.workspace.path !== canonicalPath)
		throw new TypeError('setup journey workspace path is not canonical');
	if (
		session.workspace.revision !== null &&
		(typeof session.workspace.revision !== 'string' ||
			!/^[a-f0-9]{7,64}$/u.test(session.workspace.revision))
	) {
		throw new TypeError('setup journey workspace revision is invalid');
	}
	rejectUnknownFields(session.host, new Set(['target_host']), 'setup journey host');
	if (session.host.target_host !== undefined && !HOST_VALUES.has(session.host.target_host)) {
		throw new TypeError('setup journey target host is invalid');
	}
	rejectUnknownFields(
		session.inputs,
		new Set(['domain', 'test_recipient', 'existing_mail', 'current_mx_fingerprint']),
		'setup journey inputs'
	);
	if (session.inputs.domain !== undefined) {
		const domain = requireString(session.inputs.domain, 'setup journey inputs.domain');
		if (
			domain.length > 253 ||
			!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(
				domain
			)
		) {
			throw new TypeError('setup journey inputs.domain is invalid');
		}
	}
	if (session.inputs.test_recipient !== undefined) {
		const recipient = requireString(
			session.inputs.test_recipient,
			'setup journey inputs.test_recipient'
		);
		if (recipient.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient)) {
			throw new TypeError('setup journey inputs.test_recipient is invalid');
		}
	}
	if (
		session.inputs.existing_mail !== undefined &&
		!EXISTING_MAIL_VALUES.has(session.inputs.existing_mail)
	) {
		throw new TypeError('setup journey inputs.existing_mail is invalid');
	}
	if (session.inputs.current_mx_fingerprint !== undefined) {
		requireFingerprint(
			session.inputs.current_mx_fingerprint,
			'setup journey inputs.current_mx_fingerprint'
		);
	}
	rejectUnknownFields(
		session.identity,
		new Set(['cloudflare_fingerprint', 'resend_fingerprint']),
		'setup journey identity'
	);
	for (const value of Object.values(session.identity))
		requireFingerprint(value, 'setup journey identity');
	if (session.preflight !== undefined) validateStoredPreflight(session.preflight);
	validateStages(session.stages);
	if (session.current_action !== null) {
		rejectUnknownFields(
			session.current_action,
			new Set([...ACTION_FIELDS, 'status']),
			'setup current action'
		);
		const { status, ...action } = session.current_action;
		normalizeJourneyAction(action);
		if (!['planned', 'issued', 'blocked'].includes(status)) {
			throw new TypeError('setup current action status is invalid');
		}
	}
	rejectUnknownFields(
		session.mailbox_handoff,
		new Set(['status', 'canary_fingerprint', 'identity_fingerprint']),
		'setup journey mailbox_handoff'
	);
	if (!MAILBOX_HANDOFF_STATUSES.has(session.mailbox_handoff.status)) {
		throw new TypeError('setup journey mailbox_handoff status is invalid');
	}
	if (session.mailbox_handoff.status === 'pending') {
		if (
			session.mailbox_handoff.canary_fingerprint !== undefined ||
			session.mailbox_handoff.identity_fingerprint !== undefined
		) {
			throw new TypeError('pending mailbox handoff cannot contain fingerprints');
		}
	} else {
		requireFingerprint(
			session.mailbox_handoff.canary_fingerprint,
			'setup journey mailbox_handoff.canary_fingerprint'
		);
		requireFingerprint(
			session.mailbox_handoff.identity_fingerprint,
			'setup journey mailbox_handoff.identity_fingerprint'
		);
	}
	return session;
}

function newSetupJourney(workspacePath, { now, revision = null }) {
	return {
		schema_version: SETUP_JOURNEY_SCHEMA_VERSION,
		session_id: randomUUID(),
		created_at: now,
		updated_at: now,
		workspace: { path: workspacePath, revision },
		host: {},
		inputs: {},
		identity: {},
		stages: SETUP_JOURNEY_STAGES.map((stage) => ({ ...stage, status: 'pending' })),
		current_action: null,
		mailbox_handoff: { status: 'pending' }
	};
}

function validTimestampOr(value, fallback) {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function validRevisionOrNull(value) {
	return typeof value === 'string' && /^[a-f0-9]{7,64}$/u.test(value) ? value : null;
}

function migrateLegacyInputs(input) {
	const migrated = {};
	if (
		typeof input?.domain === 'string' &&
		input.domain.length <= 253 &&
		/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(
			input.domain
		)
	) {
		migrated.domain = input.domain;
	}
	if (
		typeof input?.test_recipient === 'string' &&
		input.test_recipient.length <= 254 &&
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.test_recipient)
	) {
		migrated.test_recipient = input.test_recipient;
	}
	if (EXISTING_MAIL_VALUES.has(input?.existing_mail)) {
		migrated.existing_mail = input.existing_mail;
	}
	if (FINGERPRINT_PATTERN.test(input?.current_mx_fingerprint ?? '')) {
		migrated.current_mx_fingerprint = input.current_mx_fingerprint;
	}
	return migrated;
}

function migrateLegacyIdentity(identity) {
	const migrated = {};
	for (const key of ['cloudflare_fingerprint', 'resend_fingerprint']) {
		if (FINGERPRINT_PATTERN.test(identity?.[key] ?? '')) migrated[key] = identity[key];
	}
	return migrated;
}

function migrateLegacyIssuedAction(action) {
	if (
		action?.status !== 'issued' ||
		action.kind !== 'provider_write' ||
		!JOURNEY_STAGE_IDS.has(action.stage) ||
		action.stage === 'preflight' ||
		!FINGERPRINT_PATTERN.test(action.plan_hash ?? '')
	) {
		return null;
	}
	let id;
	try {
		id = requirePublicIdentifier(action.id, 'legacy setup action id');
	} catch {
		id = `legacy-${action.stage}-${action.plan_hash.slice(0, 12)}`;
	}
	const capability = READBACK_CAPABILITIES.has(action.readback?.capability)
		? action.readback.capability
		: 'setup.inspect_stage';
	let targetFingerprint = action.readback?.target_fingerprint;
	if (!FINGERPRINT_PATTERN.test(targetFingerprint ?? '')) {
		try {
			targetFingerprint = fingerprint({
				stage: action.stage,
				plan_hash: action.plan_hash,
				legacy_target: action.readback?.target ?? null
			});
		} catch {
			targetFingerprint = fingerprint({ stage: action.stage, plan_hash: action.plan_hash });
		}
	}
	const readback = {
		capability,
		target_fingerprint: targetFingerprint,
		plan_hash: action.plan_hash
	};
	for (const field of ['identity_fingerprint', 'canary_fingerprint']) {
		if (FINGERPRINT_PATTERN.test(action.readback?.[field] ?? '')) {
			readback[field] = action.readback[field];
		}
	}
	return {
		...normalizeJourneyAction({
			id,
			stage: action.stage,
			kind: 'provider_write',
			executor: EXECUTOR_BY_ACTION_KIND.provider_write,
			plan_hash: action.plan_hash,
			readback
		}),
		status: 'issued'
	};
}

function migrateV1Journey(legacy, workspacePath, now) {
	const currentAction = migrateLegacyIssuedAction(legacy?.current_action);
	let sessionId;
	try {
		sessionId = requirePublicIdentifier(legacy?.session_id, 'legacy setup journey session_id');
	} catch {
		sessionId = randomUUID();
	}
	return {
		schema_version: SETUP_JOURNEY_SCHEMA_VERSION,
		session_id: sessionId,
		created_at: validTimestampOr(legacy?.created_at, now),
		updated_at: now,
		workspace: {
			path: workspacePath,
			revision: validRevisionOrNull(legacy?.workspace?.revision)
		},
		host: HOST_VALUES.has(legacy?.host?.target_host)
			? { target_host: legacy.host.target_host }
			: {},
		inputs: migrateLegacyInputs(legacy?.inputs),
		identity: migrateLegacyIdentity(legacy?.identity),
		stages: SETUP_JOURNEY_STAGES.map((stage) => ({
			...stage,
			status: currentAction?.stage === stage.id ? 'active' : 'pending'
		})),
		current_action: currentAction,
		mailbox_handoff: { status: 'pending' }
	};
}

async function withLockedJourney(
	{
		workspaceRoot,
		stateRoot = defaultStateRoot(),
		now = new Date().toISOString(),
		revision = null
	},
	operation
) {
	const workspacePath = canonicalWorkspacePath(workspaceRoot);
	const path = resolveJourneyStatePath(workspacePath, { stateRoot });
	const store = createAtomicSetupStateStore(path);
	return store.withLock(async () => {
		let session = await store.load();
		let created = false;
		let migrated = false;
		if (!session) {
			session = newSetupJourney(workspacePath, { now, revision });
			created = true;
		} else if (session.schema_version === LEGACY_SETUP_JOURNEY_SCHEMA_VERSION) {
			session = migrateV1Journey(session, workspacePath, now);
			migrated = true;
		}
		let derivedChanged = rederiveJourneyProgress(session);
		validateJourney(session);
		if (session.workspace.path !== workspacePath) {
			throw new TypeError('setup journey belongs to another workspace');
		}
		const result = await operation(session, { created });
		derivedChanged = rederiveJourneyProgress(session) || derivedChanged;
		if (created || migrated || derivedChanged || result?.changed === true) {
			validateJourney(session);
			await store.save(session);
		}
		return result?.value;
	});
}

export async function createSetupJourney({
	workspaceRoot,
	stateRoot = defaultStateRoot(),
	now = new Date().toISOString(),
	revision = null
}) {
	return withLockedJourney({ workspaceRoot, stateRoot, now, revision }, (session, { created }) => ({
		value: session,
		changed: created
	}));
}

export async function saveSetupJourney(session, { stateRoot = defaultStateRoot() } = {}) {
	rederiveJourneyProgress(session);
	validateJourney(session);
	const path = resolveJourneyStatePath(session.workspace.path, { stateRoot });
	const store = createAtomicSetupStateStore(path);
	await store.withLock(async () => {
		await store.save(session);
	});
	return path;
}

function nextActionFor(session) {
	const action = session.current_action;
	if (!action) return null;
	if (action.status !== 'issued') return { ...action };
	return {
		id: action.id,
		stage: action.stage,
		kind: 'readback',
		executor: EXECUTOR_BY_ACTION_KIND.readback,
		plan_hash: action.plan_hash,
		retry: 'readback_only',
		readback: action.readback
	};
}

export async function resumeSetupJourney({ workspaceRoot, stateRoot = defaultStateRoot() }) {
	return withLockedJourney({ workspaceRoot, stateRoot }, (session) => ({
		value: {
			session,
			board: renderMissionBoard(session),
			next_action: nextActionFor(session)
		}
	}));
}

function persistedPreflightData(observations) {
	const inputs = {};
	if (typeof observations.domain?.value === 'string' && observations.domain.value.trim()) {
		inputs.domain = observations.domain.value.trim();
	}
	if (
		typeof observations.test_recipient?.value === 'string' &&
		observations.test_recipient.value.trim()
	) {
		inputs.test_recipient = observations.test_recipient.value.trim();
	}
	if (typeof observations.existing_mail === 'string' && observations.existing_mail.trim()) {
		const existingMail = observations.existing_mail.trim();
		if (!EXISTING_MAIL_VALUES.has(existingMail)) {
			throw new TypeError('preflight existing_mail is not permitted in setup state');
		}
		inputs.existing_mail = existingMail;
	}
	if (
		observations.current_mx?.status === 'observed' &&
		Array.isArray(observations.current_mx.records)
	) {
		inputs.current_mx_fingerprint = fingerprint(observations.current_mx.records);
	}
	const identity = {};
	for (const [source, destination] of [
		['cloudflare_fingerprint', 'cloudflare_fingerprint'],
		['resend_fingerprint', 'resend_fingerprint']
	]) {
		const value = observations.identity?.[source];
		if (value !== undefined)
			identity[destination] = requireFingerprint(value, `preflight identity.${source}`);
	}
	return { inputs, identity };
}

function downstreamProgressed(session) {
	return (
		session.current_action !== null ||
		session.stages
			.slice(1)
			.some((stage) => stage.status !== 'pending' || (stage.evidence?.length ?? 0) > 0)
	);
}

function assertStablePreflightTarget(session, persisted, targetHost) {
	if (!downstreamProgressed(session)) return;
	for (const [label, current, next] of [
		['host', session.host.target_host, targetHost],
		['domain', session.inputs.domain, persisted.inputs.domain],
		['test recipient', session.inputs.test_recipient, persisted.inputs.test_recipient],
		[
			'Cloudflare identity',
			session.identity.cloudflare_fingerprint,
			persisted.identity.cloudflare_fingerprint
		],
		['Resend identity', session.identity.resend_fingerprint, persisted.identity.resend_fingerprint]
	]) {
		if (current !== undefined && next !== undefined && current !== next) {
			throw new TypeError(`setup journey target changed: ${label}`);
		}
	}
}

export async function recordSetupPreflight({
	workspaceRoot,
	stateRoot = defaultStateRoot(),
	observations,
	now = new Date().toISOString()
}) {
	const preflight = assessSetupPreflight(observations);
	const persisted = persistedPreflightData(observations);
	return withLockedJourney({ workspaceRoot, stateRoot, now }, (session) => {
		const targetHost =
			typeof observations.target_host === 'string' ? observations.target_host : undefined;
		assertStablePreflightTarget(session, persisted, targetHost);
		session.preflight = preflight;
		session.inputs = { ...session.inputs, ...persisted.inputs };
		session.identity = { ...session.identity, ...persisted.identity };
		session.host = { ...session.host, ...(targetHost ? { target_host: targetHost } : {}) };
		session.updated_at = now;
		session.stages[0].status =
			preflight.status === 'ready'
				? 'verified'
				: preflight.status === 'blocked'
					? 'blocked'
					: 'active';
		if (preflight.status === 'ready' && session.stages[1].status === 'pending') {
			session.stages[1].status = 'active';
		}
		return {
			changed: true,
			value: {
				session,
				preflight,
				board: renderMissionBoard(session),
				next_action: nextActionFor(session)
			}
		};
	});
}

function currentStageIndex(session) {
	return session.stages.findIndex(({ status }) => status !== 'verified');
}

export async function recordSetupAction({
	workspaceRoot,
	stateRoot = defaultStateRoot(),
	phase,
	action,
	evidence = null,
	stageComplete: _ignoredStageComplete = false,
	now = new Date().toISOString()
}) {
	if (!['planned', 'issued', 'verified', 'blocked'].includes(phase)) {
		throw new TypeError('setup action phase is invalid');
	}
	const normalized = normalizeJourneyAction(action);
	void _ignoredStageComplete;
	return withLockedJourney({ workspaceRoot, stateRoot, now }, (session) => {
		const stageIndex = session.stages.findIndex(({ id }) => id === normalized.stage);
		const activeIndex = currentStageIndex(session);
		const existing = session.current_action;
		const expectedIssuedReadback = existing?.status === 'issued' ? nextActionFor(session) : null;
		const savedIssuedAction = existing?.status === 'issued' ? { ...existing } : null;
		if (savedIssuedAction) delete savedIssuedAction.status;
		const issuedRecovery =
			existing?.status === 'issued' &&
			(fingerprint(expectedIssuedReadback) === fingerprint(normalized) ||
				fingerprint(savedIssuedAction) === fingerprint(normalized)) &&
			['verified', 'blocked'].includes(phase);
		if (stageIndex !== activeIndex && !issuedRecovery) {
			throw new TypeError('setup action must target the current unverified stage');
		}
		if (phase === 'planned') {
			if (existing?.status === 'issued') {
				throw new TypeError('issued setup action requires readback before another plan');
			}
			if (existing?.status === 'planned') {
				const savedAction = { ...existing };
				delete savedAction.status;
				if (fingerprint(savedAction) !== fingerprint(normalized)) {
					throw new TypeError('another setup action is already planned');
				}
			} else {
				session.current_action = { ...normalized, status: 'planned' };
			}
			session.stages[stageIndex].status = 'active';
		} else {
			if (!existing || existing.id !== normalized.id || existing.stage !== normalized.stage) {
				throw new TypeError('setup action transition does not match the saved action');
			}
			const savedAction = { ...existing };
			delete savedAction.status;
			const matchesSavedAction = fingerprint(savedAction) === fingerprint(normalized);
			if (!matchesSavedAction && !issuedRecovery) {
				throw new TypeError('setup action transition changed the saved action');
			}
			if (phase === 'issued') {
				if (existing.kind !== 'provider_write') {
					throw new TypeError('only a provider write setup action can be issued');
				}
				if (existing.status !== 'planned') {
					throw new TypeError('only a planned setup action can be issued');
				}
				session.current_action = { ...existing, status: 'issued' };
			} else if (phase === 'blocked') {
				if (evidence !== null && evidence !== undefined) {
					const blocked = normalizeJourneyEvidence(normalized.stage, evidence);
					if (blocked.evidence.status !== 'blocked') {
						throw new TypeError('blocked setup action requires blocked evidence');
					}
					const stage = session.stages[stageIndex];
					stage.evidence = [
						...(stage.evidence ?? []),
						{ action_id: existing.id, ...blocked.evidence }
					];
				}
				session.current_action = {
					...existing,
					status: existing.status === 'issued' ? 'issued' : 'blocked'
				};
				session.stages[stageIndex].status = 'blocked';
			} else {
				if (existing.kind === 'provider_write' && existing.status !== 'issued') {
					throw new TypeError('provider write must be recorded as issued before verification');
				}
				if (!evidence) {
					throw new TypeError('verified setup action requires non-secret readback evidence');
				}
				const verified = normalizeJourneyEvidence(normalized.stage, evidence);
				if (verified.evidence.status !== 'verified') {
					throw new TypeError('verified setup action requires verified evidence');
				}
				if (
					normalized.stage === 'provider_login' &&
					(verified.evidence.cloudflare_identity_fingerprint !==
						session.identity.cloudflare_fingerprint ||
						verified.evidence.resend_identity_fingerprint !== session.identity.resend_fingerprint)
				) {
					throw new TypeError('provider identity does not match preflight');
				}
				if (
					existing.plan_hash &&
					verified.evidence.plan_hash &&
					existing.plan_hash !== verified.evidence.plan_hash
				) {
					throw new TypeError('verified setup evidence plan_hash does not match the issued action');
				}
				advanceMailboxHandoff(session, normalized.stage, verified.evidence);
				const stage = session.stages[stageIndex];
				stage.evidence = [
					...(stage.evidence ?? []),
					{ action_id: existing.id, ...verified.evidence }
				];
				stage.status = verified.completesStage ? 'verified' : 'active';
				session.current_action = null;
				if (verified.completesStage && session.stages[stageIndex + 1]?.status === 'pending') {
					session.stages[stageIndex + 1].status = 'active';
				}
			}
		}
		session.updated_at = now;
		return {
			changed: true,
			value: {
				session,
				board: renderMissionBoard(session),
				next_action: nextActionFor(session)
			}
		};
	});
}

export function renderMissionBoard(session) {
	validateStages(session?.stages);
	const symbols = { verified: '✓', active: '→', blocked: '!', pending: ' ' };
	return [
		'🔥 Noroshi 開通ミッション',
		...session.stages.map((stage) => `[${symbols[stage.status]}] ${stage.label}`)
	].join('\n');
}
