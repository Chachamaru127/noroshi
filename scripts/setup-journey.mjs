import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAtomicSetupStateStore, fingerprint } from './setup-engine.mjs';

export const SETUP_JOURNEY_SCHEMA_VERSION = 'noroshi.setup-journey.v1';

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

function defaultStateRoot() {
	const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
	return join(base, 'noroshi', 'setup-sessions');
}

function canonicalWorkspacePath(workspaceRoot) {
	if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
		throw new TypeError('workspaceRoot is required');
	}
	return resolve(workspaceRoot);
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
	const nativeBrowserControl = browserStatus === 'ready' && computerStatus === 'ready';
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
	const chatGptWork = input.target_host === 'chatgpt_work';

	const checks = [
		check('browser', 'ブラウザ操作', browserStatus, {
			reason: browserStatus === 'ready' ? 'native_browser_available' : 'native_browser_unavailable'
		}),
		check('computer', 'コンピュータ操作', computerStatus, {
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
			copy_command: `curl -fsSL https://bun.com/install | bash -s "bun-v${requiredBun}"`
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
		check('resend_account', 'Resend アカウント', resendAccount, {
			official_url:
				input.resend?.account === 'present'
					? 'https://resend.com/login'
					: 'https://resend.com/signup'
		}),
		check('resend_login', 'Resend ログイン', loginStatus(input.resend?.login), {
			official_url: 'https://resend.com/login'
		}),
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
			'ChatGPT developer mode',
			chatGptWork
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
			'OpenAI Secure MCP Tunnel',
			chatGptWork ? (input.secure_mcp_tunnel === 'ready' ? 'ready' : 'user_action') : 'skipped',
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

function validateJourney(session) {
	if (!session || typeof session !== 'object' || Array.isArray(session)) {
		throw new TypeError('setup journey must be an object');
	}
	if (session.schema_version !== SETUP_JOURNEY_SCHEMA_VERSION) {
		throw new TypeError('unsupported setup journey schema');
	}
	canonicalWorkspacePath(session.workspace?.path);
	if (!Array.isArray(session.stages) || session.stages.length !== SETUP_JOURNEY_STAGES.length) {
		throw new TypeError('setup journey stages are incomplete');
	}
	for (const [index, stage] of session.stages.entries()) {
		if (stage?.id !== SETUP_JOURNEY_STAGES[index].id || !JOURNEY_STAGE_IDS.has(stage.id)) {
			throw new TypeError('setup journey stage order is invalid');
		}
		if (!STAGE_STATUSES.has(stage.status)) {
			throw new TypeError(`invalid setup journey stage status for ${stage.id}`);
		}
	}
	return session;
}

export async function createSetupJourney({
	workspaceRoot,
	stateRoot = defaultStateRoot(),
	now = new Date().toISOString(),
	revision = null
}) {
	const workspacePath = canonicalWorkspacePath(workspaceRoot);
	const session = {
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
	await saveSetupJourney(session, { stateRoot });
	return session;
}

export async function saveSetupJourney(session, { stateRoot = defaultStateRoot() } = {}) {
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
		id: `${action.id}-readback`,
		stage: action.stage,
		kind: 'readback',
		status: 'planned',
		executor: action.executor,
		retry: 'readback_only',
		readback: action.readback
	};
}

export async function resumeSetupJourney({ workspaceRoot, stateRoot = defaultStateRoot() }) {
	const workspacePath = canonicalWorkspacePath(workspaceRoot);
	const path = resolveJourneyStatePath(workspacePath, { stateRoot });
	const store = createAtomicSetupStateStore(path);
	let session = await store.load();
	if (!session) session = await createSetupJourney({ workspaceRoot: workspacePath, stateRoot });
	validateJourney(session);
	if (session.workspace.path !== workspacePath) {
		throw new TypeError('setup journey belongs to another workspace');
	}
	return {
		session,
		board: renderMissionBoard(session),
		next_action: nextActionFor(session)
	};
}

export async function recordSetupPreflight({
	workspaceRoot,
	stateRoot = defaultStateRoot(),
	observations,
	now = new Date().toISOString()
}) {
	const resumed = await resumeSetupJourney({ workspaceRoot, stateRoot });
	const preflight = assessSetupPreflight(observations);
	const session = resumed.session;
	session.preflight = preflight;
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
	await saveSetupJourney(session, { stateRoot });
	return {
		session,
		preflight,
		board: renderMissionBoard(session),
		next_action: nextActionFor(session)
	};
}

function currentStageIndex(session) {
	return session.stages.findIndex(({ status }) => status !== 'verified');
}

function normalizeJourneyAction(action) {
	if (!action || typeof action !== 'object' || Array.isArray(action)) {
		throw new TypeError('setup action must be an object');
	}
	for (const key of ['id', 'stage', 'kind', 'executor']) {
		if (typeof action[key] !== 'string' || !action[key].trim()) {
			throw new TypeError(`setup action ${key} is required`);
		}
	}
	if (!JOURNEY_STAGE_IDS.has(action.stage)) throw new TypeError('setup action stage is invalid');
	if (!['provider_write', 'human_action', 'readback', 'mailbox_readback'].includes(action.kind)) {
		throw new TypeError('setup action kind is invalid');
	}
	if (
		action.kind === 'provider_write' &&
		(typeof action.plan_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(action.plan_hash))
	) {
		throw new TypeError('provider write action requires a plan hash');
	}
	return JSON.parse(JSON.stringify(action));
}

export async function recordSetupAction({
	workspaceRoot,
	stateRoot = defaultStateRoot(),
	phase,
	action,
	evidence = null,
	stageComplete = false,
	now = new Date().toISOString()
}) {
	if (!['planned', 'issued', 'verified', 'blocked'].includes(phase)) {
		throw new TypeError('setup action phase is invalid');
	}
	const resumed = await resumeSetupJourney({ workspaceRoot, stateRoot });
	const session = resumed.session;
	const normalized = normalizeJourneyAction(action);
	const stageIndex = session.stages.findIndex(({ id }) => id === normalized.stage);
	const activeIndex = currentStageIndex(session);
	if (stageIndex !== activeIndex) {
		throw new TypeError('setup action must target the current unverified stage');
	}
	const existing = session.current_action;
	if (phase === 'planned') {
		if (existing && existing.status === 'issued') {
			throw new TypeError('issued setup action requires readback before another plan');
		}
		session.current_action = { ...normalized, status: 'planned' };
		session.stages[stageIndex].status = 'active';
	} else {
		if (!existing || existing.id !== normalized.id || existing.stage !== normalized.stage) {
			throw new TypeError('setup action transition does not match the saved action');
		}
		const savedAction = { ...existing };
		delete savedAction.status;
		if (fingerprint(savedAction) !== fingerprint(normalized)) {
			throw new TypeError('setup action transition changed the saved action');
		}
		if (phase === 'issued') {
			if (existing.status !== 'planned') {
				throw new TypeError('only a planned setup action can be issued');
			}
			session.current_action = { ...existing, status: 'issued' };
		} else if (phase === 'blocked') {
			session.current_action = { ...existing, status: 'blocked' };
			session.stages[stageIndex].status = 'blocked';
		} else {
			if (existing.kind === 'provider_write' && existing.status !== 'issued') {
				throw new TypeError('provider write must be recorded as issued before verification');
			}
			if (!evidence || evidence.status !== 'verified' || typeof evidence.kind !== 'string') {
				throw new TypeError('verified setup action requires non-secret readback evidence');
			}
			const stage = session.stages[stageIndex];
			stage.evidence = [...(stage.evidence ?? []), { action_id: existing.id, ...evidence }];
			stage.status = stageComplete ? 'verified' : 'active';
			session.current_action = null;
			if (stageComplete && session.stages[stageIndex + 1]?.status === 'pending') {
				session.stages[stageIndex + 1].status = 'active';
			}
		}
	}
	session.updated_at = now;
	await saveSetupJourney(session, { stateRoot });
	return {
		session,
		board: renderMissionBoard(session),
		next_action: nextActionFor(session)
	};
}

export function renderMissionBoard(session) {
	validateJourney({
		schema_version: SETUP_JOURNEY_SCHEMA_VERSION,
		workspace: { path: process.cwd() },
		stages: session?.stages
	});
	const symbols = { verified: '✓', active: '→', blocked: '!', pending: ' ' };
	return [
		'🔥 Noroshi 開通ミッション',
		...session.stages.map((stage) => `[${symbols[stage.status]}] ${stage.label}`)
	].join('\n');
}
