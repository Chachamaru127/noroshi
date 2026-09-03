import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Local provider-neutral setup control plane.
 *
 * This module intentionally contains no provider client. Cloudflare, Resend,
 * DNS, and browser implementations are injected through the three-method
 * adapter boundary below. Keeping this in scripts/ also prevents the setup
 * engine from becoming part of the mailbox Worker bundle.
 */

export const SETUP_ENGINE_SCHEMA_VERSION = 'noroshi.setup-engine.v1';

export const SETUP_STEP_KINDS = Object.freeze([
	'resource_creation',
	'secret_staging',
	'remote_migration',
	'deployment',
	'webhook_creation',
	'email_routing',
	'dns_change',
	'domain_verification',
	'external_send',
	'destructive_cleanup'
]);

const STEP_KIND_SET = new Set(SETUP_STEP_KINDS);
const TARGET_FIELDS = [
	'provider',
	'adapter_kind',
	'resource_type',
	'resource_id',
	'resource_name',
	'account_id',
	'team_id',
	'zone_id',
	'domain_id',
	'domain',
	'origin'
];
const ROLLBACK_MODES = new Set([
	'restore_snapshot',
	'restore_owned_records',
	'disable',
	'manual_review',
	'not_needed'
]);
const PROTECTED_RESOURCE_TYPES = new Set([
	'cloudflare_zone',
	'cloudflare_d1_database',
	'cloudflare_r2_bucket',
	'resend_domain'
]);
const EXPLICIT_SAFE_DATA_KEYS = new Set(['secret_broker_reference']);
const FORBIDDEN_DATA_KEY_NAMES = new Set([
	'secret',
	'secret_value',
	'api_key',
	'api_key_value',
	'password',
	'passwd',
	'token',
	'access_token',
	'refresh_token',
	'authorization',
	'cookie',
	'cookies',
	'body',
	'body_text',
	'body_html',
	'message_body',
	'mail_body',
	'attachment',
	'attachment_content',
	'raw_message',
	'mailbox_content',
	'private_key',
	'client_secret',
	'signing_secret',
	'resend_api_key',
	'tokens',
	'passwords',
	'api_keys',
	'secrets',
	'apikey',
	'apikeys',
	'credentials'
]);
const FORBIDDEN_DATA_KEY_SUFFIXES = [
	'_secret',
	'_secrets',
	'_api_key',
	'_apikey',
	'_apikeys',
	'_password',
	'_passwd',
	'_token',
	'_access_token',
	'_refresh_token',
	'_authorization',
	'_cookie',
	'_cookies',
	'_tokens',
	'_passwords',
	'_api_keys',
	'_body',
	'_body_text',
	'_body_html',
	'_message_body',
	'_mail_body',
	'_attachment',
	'_attachment_content',
	'_raw_message',
	'_mailbox_content',
	'_private_key',
	'_credentials'
];
const SAFE_PROVIDER_RESULT_KEYS = new Set([
	'id',
	'resource_id',
	'provider_id',
	'operation_id',
	'request_id',
	'status',
	'created'
]);

/**
 * This is a repository-owned contract, not a provider/plugin registry. Each
 * QMJ-10 step kind may use only the exact capability/operation pairs below.
 */
export const SETUP_STEP_CAPABILITY_CONTRACT = Object.freeze({
	resource_creation: Object.freeze([
		Object.freeze({ capability_id: 'cloudflare.create_zone', operation: 'create_zone' }),
		Object.freeze({ capability_id: 'cloudflare.create_d1', operation: 'create_d1_database' }),
		Object.freeze({ capability_id: 'cloudflare.create_r2', operation: 'create_r2_bucket' }),
		Object.freeze({ capability_id: 'cloudflare.create_worker', operation: 'create_worker' }),
		Object.freeze({ capability_id: 'resend.create_domain', operation: 'create_domain' })
	]),
	secret_staging: Object.freeze([
		Object.freeze({
			capability_id: 'cloudflare.stage_worker_secret',
			operation: 'put_worker_secret'
		}),
		Object.freeze({
			capability_id: 'resend.create_sending_key',
			operation: 'create_domain_restricted_sending_key'
		})
	]),
	remote_migration: Object.freeze([
		Object.freeze({
			capability_id: 'cloudflare.apply_remote_migration',
			operation: 'apply_d1_migrations'
		})
	]),
	deployment: Object.freeze([
		Object.freeze({ capability_id: 'cloudflare.deploy_worker', operation: 'deploy_worker_version' })
	]),
	webhook_creation: Object.freeze([
		Object.freeze({ capability_id: 'resend.create_webhook', operation: 'create_webhook' })
	]),
	email_routing: Object.freeze([
		Object.freeze({
			capability_id: 'cloudflare.enable_email_routing',
			operation: 'enable_email_routing'
		}),
		Object.freeze({
			capability_id: 'cloudflare.configure_catch_all',
			operation: 'create_catch_all_rule'
		}),
		Object.freeze({
			capability_id: 'cloudflare.configure_catch_all',
			operation: 'update_catch_all_rule'
		})
	]),
	dns_change: Object.freeze([
		Object.freeze({ capability_id: 'cloudflare.change_dns', operation: 'create_dns_record' }),
		Object.freeze({ capability_id: 'cloudflare.change_dns', operation: 'update_dns_record' }),
		Object.freeze({ capability_id: 'cloudflare.change_dns', operation: 'delete_owned_dns_record' })
	]),
	domain_verification: Object.freeze([
		Object.freeze({ capability_id: 'resend.verify_domain', operation: 'verify_domain' })
	]),
	external_send: Object.freeze([
		Object.freeze({
			capability_id: 'resend.send_controlled_test',
			operation: 'send_controlled_test'
		})
	]),
	destructive_cleanup: Object.freeze([
		Object.freeze({ capability_id: 'cloudflare.delete_d1', operation: 'delete_empty_owned_d1' }),
		Object.freeze({ capability_id: 'cloudflare.delete_r2', operation: 'delete_empty_owned_r2' }),
		Object.freeze({ capability_id: 'cloudflare.delete_worker', operation: 'delete_owned_worker' }),
		Object.freeze({ capability_id: 'resend.delete_domain', operation: 'delete_owned_domain' }),
		Object.freeze({ capability_id: 'resend.delete_webhook', operation: 'delete_owned_webhook' }),
		Object.freeze({ capability_id: 'resend.revoke_api_key', operation: 'revoke_owned_api_key' })
	])
});

const SETUP_STEP_CAPABILITY_CONTRACT_KEYS = new Set(Object.keys(SETUP_STEP_CAPABILITY_CONTRACT));

const APPLY_STATE_SCHEMA_VERSION = `${SETUP_ENGINE_SCHEMA_VERSION}.apply-state.v1`;
const APPLY_STATE_FIELDS = new Set([
	'schema_version',
	'plan_id',
	'plan_hash',
	'approval_id',
	'approved',
	'consumed',
	'apply_started',
	'readback_verified'
]);

function normalizeDataKey(key) {
	return String(key)
		.replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
		.replace(/[^a-zA-Z0-9]+/gu, '_')
		.replace(/^_+|_+$/gu, '')
		.toLowerCase();
}

function isForbiddenDataKey(key) {
	const normalized = normalizeDataKey(key);
	if (EXPLICIT_SAFE_DATA_KEYS.has(normalized)) return false;
	return (
		FORBIDDEN_DATA_KEY_NAMES.has(normalized) ||
		FORBIDDEN_DATA_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
	);
}

function isProtectedResourceType(provider, resourceType) {
	const normalized = String(resourceType ?? '').toLowerCase();
	return (
		PROTECTED_RESOURCE_TYPES.has(normalized) ||
		(provider === 'cloudflare' && /(?:^|_)(?:zone|d1_database|r2_bucket)$/u.test(normalized)) ||
		(provider === 'resend' && /(?:^|_)domain$/u.test(normalized))
	);
}

export class SetupEngineError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.name = 'SetupEngineError';
		this.code = code;
		this.details = Object.freeze({ ...details });
	}
}

function stop(code, message, details = {}) {
	throw new SetupEngineError(code, message, details);
}

function assertObject(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		stop('invalid_input', `${label} must be an object`);
	}
}

function assertSafeData(value, path = '$', seen = new Set()) {
	if (value === undefined) return;
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) stop('unsafe_plan_data', `${path} must be finite`);
		return;
	}
	if (typeof value !== 'object') stop('unsafe_plan_data', `${path} has an unsupported value`);
	if (seen.has(value)) stop('unsafe_plan_data', `${path} contains a cycle`);
	seen.add(value);
	if (Array.isArray(value)) {
		value.forEach((entry, index) => assertSafeData(entry, `${path}[${index}]`, seen));
	} else {
		for (const [key, entry] of Object.entries(value)) {
			const normalizedKey = normalizeDataKey(key);
			if (isForbiddenDataKey(key)) {
				stop('unsafe_plan_data', `${path}.${key} is not permitted in setup state`);
			}
			if (normalizedKey === 'secret_broker_reference') {
				if (typeof entry !== 'string' || !entry.trim()) {
					stop(
						'unsafe_plan_data',
						`${path}.${key} must be a non-empty opaque secret broker reference`
					);
				}
				continue;
			}
			assertSafeData(entry, `${path}.${key}`, seen);
		}
	}
	seen.delete(value);
}

function canonicalJson(value) {
	assertSafeData(value);
	if (value === undefined) return 'null';
	if (value === null) return 'null';
	if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
	if (typeof value === 'number') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
		.join(',')}}`;
}

function cloneSafe(value) {
	return JSON.parse(canonicalJson(value));
}

export function fingerprint(value) {
	return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function constantEqual(left, right) {
	return typeof left === 'string' && typeof right === 'string' && left === right;
}

function normalizeString(value, label, { lower = false, optional = false } = {}) {
	if (value === undefined || value === null) {
		if (optional) return undefined;
		stop('invalid_input', `${label} is required`);
	}
	if (typeof value !== 'string') stop('invalid_input', `${label} must be a string`);
	const normalized = value.trim();
	if (!normalized && !optional) stop('invalid_input', `${label} is required`);
	return lower ? normalized.toLowerCase() : normalized;
}

function normalizeTarget(input) {
	assertObject(input, 'target');
	for (const key of Object.keys(input)) {
		if (!TARGET_FIELDS.includes(key))
			stop('invalid_target', `target field ${key} is not allowlisted`);
	}
	const provider = normalizeString(input.provider, 'target.provider', { lower: true });
	if (!['cloudflare', 'resend'].includes(provider)) {
		stop('invalid_target', 'target.provider is not an allowlisted provider');
	}
	const resourceType = normalizeString(input.resource_type, 'target.resource_type', {
		lower: true
	});
	const adapterKind = normalizeString(input.adapter_kind ?? provider, 'target.adapter_kind', {
		lower: true
	});
	if (!['cloudflare', 'resend', 'dns', 'browser'].includes(adapterKind)) {
		stop('invalid_target', 'target.adapter_kind is not allowlisted');
	}
	if (adapterKind === 'dns' && provider !== 'cloudflare') {
		stop('invalid_target', 'DNS changes must use the Cloudflare provider');
	}
	if (provider === 'cloudflare' && !input.account_id) {
		stop('missing_target_id', 'Cloudflare account_id is required');
	}
	if (provider === 'resend' && !input.team_id) {
		stop('missing_target_id', 'Resend team_id is required');
	}
	if (adapterKind === 'dns' && !input.zone_id) {
		stop('missing_target_id', 'DNS zone_id is required');
	}
	if (adapterKind === 'browser') {
		const origin = normalizeString(input.origin, 'target.origin');
		if (
			!/^https:\/\/(?:dash\.cloudflare\.com|resend\.com|www\.resend\.com|noroshi(?:-[a-z0-9-]+)?\.pages\.dev)(?:\/|$)/iu.test(
				origin
			)
		) {
			stop('origin_not_allowlisted', 'browser origin is not an allowlisted official origin');
		}
	}
	const target = { provider, adapter_kind: adapterKind, resource_type: resourceType };
	for (const key of TARGET_FIELDS.slice(3)) {
		const value = input[key];
		if (value !== undefined && value !== null) {
			target[key] = normalizeString(value, `target.${key}`, {
				lower: ['provider', 'adapter_kind', 'resource_type', 'domain'].includes(key)
			});
		}
	}
	return target;
}

function stepContractEntry(step) {
	const entries = SETUP_STEP_CAPABILITY_CONTRACT[step.kind];
	if (!entries || !SETUP_STEP_CAPABILITY_CONTRACT_KEYS.has(step.kind)) return null;
	return (
		entries.find(
			(entry) => entry.capability_id === step.capability_id && entry.operation === step.operation
		) ?? null
	);
}

function assertStepCapabilityContract(step, target) {
	const contractEntry = stepContractEntry(step);
	if (!contractEntry) {
		stop(
			'invalid_step_contract',
			`step ${step.kind} must use an exact repository capability and operation pair`
		);
	}
	const capabilityProvider = step.capability_id.split('.', 1)[0];
	if (capabilityProvider !== target.provider) {
		stop('step_target_mismatch', 'step capability provider does not match the target provider');
	}
	if (step.adapter_kind && step.adapter_kind !== target.adapter_kind) {
		stop('step_target_mismatch', 'step adapter kind does not match the target adapter kind');
	}
	return contractEntry;
}

function normalizeStep(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		stop('invalid_step', 'exactly one setup step is required');
	}
	if (Array.isArray(input.steps) || Array.isArray(input.step)) {
		stop('multiple_steps', 'one apply call accepts exactly one step');
	}
	const kind = normalizeString(input.kind, 'step.kind', { lower: true });
	if (!STEP_KIND_SET.has(kind)) stop('invalid_step', `step kind ${kind} is not allowlisted`);
	const capabilityId = normalizeString(input.capability_id, 'step.capability_id', {
		lower: true
	});
	if (!/^(?:cloudflare|resend)\.[a-z0-9_]+$/u.test(capabilityId)) {
		stop('invalid_step', 'step capability_id is not an allowlisted setup capability');
	}
	const operation = normalizeString(input.operation, 'step.operation', { lower: true });
	const costClass = normalizeString(input.cost_class ?? 'none', 'step.cost_class', {
		lower: true
	});
	const step = {
		kind,
		capability_id: capabilityId,
		operation,
		cost_class: costClass
	};
	if (input.adapter_kind !== undefined) {
		step.adapter_kind = normalizeString(input.adapter_kind, 'step.adapter_kind', { lower: true });
	}
	return step;
}

function normalizeRollback(input, target) {
	assertObject(input, 'rollback');
	const mode = normalizeString(input.mode, 'rollback.mode', { lower: true });
	if (!ROLLBACK_MODES.has(mode)) stop('invalid_rollback', 'rollback mode is not allowlisted');
	const ownedIds = input.owned_resource_ids ?? [];
	if (!Array.isArray(ownedIds) || ownedIds.some((id) => typeof id !== 'string' || !id.trim())) {
		stop('invalid_rollback', 'owned_resource_ids must be a list of non-empty IDs');
	}
	const rollback = {
		mode,
		resource_type: target.resource_type,
		owned_resource_ids: [...new Set(ownedIds.map((id) => id.trim()))],
		preserve_unowned: input.preserve_unowned !== false,
		description: normalizeString(
			input.description ?? 'manual review follows the recorded snapshot',
			'rollback.description'
		)
	};
	if (input.approval_class !== undefined) {
		rollback.approval_class = normalizeString(input.approval_class, 'rollback.approval_class', {
			lower: true
		});
	}
	if (input.approval_id !== undefined) {
		rollback.approval_id = normalizeString(input.approval_id, 'rollback.approval_id');
	}
	return rollback;
}

function diffValues(before, after, path = '$', output = []) {
	if (canonicalJson(before) === canonicalJson(after)) return output;
	const beforeObject = before && typeof before === 'object' && !Array.isArray(before);
	const afterObject = after && typeof after === 'object' && !Array.isArray(after);
	if (beforeObject && afterObject) {
		const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
		for (const key of keys) {
			diffValues(before[key], after[key], `${path}.${key}`, output);
		}
		return output;
	}
	output.push({
		path,
		before: before === undefined ? null : cloneSafe(before),
		after: after === undefined ? null : cloneSafe(after)
	});
	return output;
}

function ensureFreshExpiry(expiresAt, now) {
	const expires = normalizeString(expiresAt, 'expires_at');
	const expiryMs = Date.parse(expires);
	if (!Number.isFinite(expiryMs) || expiryMs <= now)
		stop('plan_expired', 'plan expiry must be in the future');
	return new Date(expiryMs).toISOString();
}

function ensureState(value, label) {
	assertSafeData(value);
	if (value === undefined) stop('provider_read_failed', `${label} was not returned`);
	return cloneSafe(value);
}

function ensureInspectionState(value, label) {
	const state = ensureState(value, label);
	if (!state || typeof state !== 'object' || Array.isArray(state)) {
		stop('provider_read_failed', `${label} must be an object`);
	}
	for (const key of ['resources', 'items', 'webhooks', 'domains', 'records', 'routing_rules']) {
		if (key in state && !Array.isArray(state[key])) {
			stop('provider_read_failed', `${label}.${key} must be an array`);
		}
	}
	return state;
}

function stateResources(state) {
	if (!state || typeof state !== 'object' || Array.isArray(state)) return [];
	const lists = [state.resources, state.items, state.webhooks, state.domains];
	return lists.flatMap((list) => (Array.isArray(list) ? list : []));
}

function assertNoCollision(inspection, target, step, desired) {
	const state = inspection.state;
	if (state?.collision === true || state?.resource_collision === true) {
		stop('resource_collision', 'provider reported a same-name or ownership collision');
	}
	if (!['resource_creation', 'webhook_creation'].includes(step.kind)) return;
	const name = target.resource_name ?? desired?.resource_name ?? desired?.name;
	if (name) {
		const existing = stateResources(state).filter(
			(resource) =>
				String(resource.name ?? resource.resource_name ?? '').toLowerCase() ===
				String(name).toLowerCase()
		);
		if (existing.length) {
			stop('resource_collision', 'same-name resource exists; explicit adoption is outside QMJ-10');
		}
	}
	if (step.kind === 'webhook_creation') {
		const endpoint = String(desired.endpoint ?? desired.url ?? desired.webhook_url ?? '')
			.trim()
			.toLowerCase();
		const eventTypes = Array.isArray(desired.event_types)
			? [...new Set(desired.event_types.map((value) => String(value).trim().toLowerCase()))].sort()
			: [];
		if (endpoint) {
			for (const resource of stateResources(state)) {
				const existingEndpoint = String(
					resource.endpoint ?? resource.url ?? resource.webhook_url ?? ''
				)
					.trim()
					.toLowerCase();
				const existingEvents = Array.isArray(resource.event_types)
					? [
							...new Set(resource.event_types.map((value) => String(value).trim().toLowerCase()))
						].sort()
					: [];
				if (
					existingEndpoint === endpoint &&
					canonicalJson(existingEvents) === canonicalJson(eventTypes)
				) {
					stop(
						'resource_collision',
						'duplicate webhook configuration exists; explicit adoption is outside QMJ-10'
					);
				}
			}
		}
	}
}

function assertInboundTopology(target, step, desired) {
	if (!desired || typeof desired !== 'object') return;
	if (
		desired.resend_receiving === true ||
		desired.resend_inbound_mx === true ||
		desired.apex_inbound_mx_provider === 'resend' ||
		desired.inbound_provider === 'resend'
	) {
		stop('forbidden_topology', 'Resend Receiving and apex inbound MX are not supported');
	}
	const records = [desired.records, desired.dns_records].flatMap((value) =>
		Array.isArray(value) ? value : []
	);
	const apex = String(target.domain ?? desired.domain ?? '').toLowerCase();
	for (const record of records) {
		if (String(record?.type ?? '').toUpperCase() !== 'MX') continue;
		const name = String(record?.name ?? record?.host ?? '')
			.replace(/\.$/u, '')
			.toLowerCase();
		const content = String(record?.content ?? record?.value ?? record?.target ?? '').toLowerCase();
		if ((!name || name === '@' || (apex && name === apex)) && /resend/iu.test(content)) {
			stop('forbidden_topology', 'Resend apex inbound MX is not supported');
		}
	}
}

function assertAuthoritativeDnsSnapshot(target, step, before) {
	if (step.kind !== 'dns_change') return;
	if (!before || before.authoritative !== true) {
		stop('non_authoritative_snapshot', 'DNS changes require an authoritative snapshot');
	}
	if (!Array.isArray(before.records) || !Array.isArray(before.routing_rules)) {
		stop('incomplete_dns_snapshot', 'DNS snapshot must include records and routing_rules');
	}
	if (!target.zone_id) stop('missing_target_id', 'DNS changes require zone_id');
}

function assertDnsRollbackInvariants(step, rollback) {
	if (step.kind !== 'dns_change') return;
	if (rollback.mode !== 'restore_owned_records' || !rollback.owned_resource_ids.length) {
		stop('invalid_rollback', 'DNS rollback requires an explicit owned-record list');
	}
	if (!rollback.preserve_unowned) {
		stop('invalid_rollback', 'DNS rollback must preserve unowned records');
	}
}

function dnsList(value) {
	return Array.isArray(value) ? value : [];
}

function dnsStateSuperset(actual, expected) {
	if (!actual || typeof actual !== 'object' || !expected || typeof expected !== 'object')
		return false;
	for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
		if (key === 'records' || key === 'routing_rules') continue;
		if (canonicalJson(actual[key]) !== canonicalJson(expected[key])) return false;
	}
	for (const key of ['records', 'routing_rules']) {
		const actualItems = dnsList(actual[key]);
		const expectedItems = dnsList(expected[key]);
		for (const expectedItem of expectedItems) {
			if (
				!actualItems.some((actualItem) => canonicalJson(actualItem) === canonicalJson(expectedItem))
			) {
				return false;
			}
		}
	}
	return true;
}

function dnsRollbackReadbackMatches(actual, before, after, ownedIds) {
	if (!dnsStateSuperset(actual, before)) return false;
	for (const key of ['records', 'routing_rules']) {
		const beforeItems = dnsList(before[key]);
		const afterItems = dnsList(after[key]);
		const actualItems = dnsList(actual[key]);
		for (const actualItem of actualItems) {
			const id = String(actualItem?.id ?? actualItem?.resource_id ?? '');
			if (!ownedIds.includes(id)) continue;
			const beforeItem = beforeItems.find(
				(item) => String(item?.id ?? item?.resource_id ?? '') === id
			);
			const afterItem = afterItems.find(
				(item) => String(item?.id ?? item?.resource_id ?? '') === id
			);
			if (beforeItem && canonicalJson(beforeItem) !== canonicalJson(actualItem)) return false;
			if (!beforeItem && afterItem) return false;
		}
	}
	return true;
}

function safePlanHashInput(plan) {
	const copy = { ...plan };
	delete copy.plan_hash;
	return copy;
}

function assertPlanShape(plan) {
	assertObject(plan, 'plan');
	if (plan.schema_version !== SETUP_ENGINE_SCHEMA_VERSION) {
		stop('plan_schema_mismatch', 'plan schema is not supported');
	}
	for (const key of ['plan_id', 'approval_id']) {
		if (typeof plan[key] !== 'string' || !plan[key].trim()) {
			stop('invalid_plan', `plan ${key} must be a non-empty string`);
		}
		if (normalizeString(plan[key], key) !== plan[key]) {
			stop('invalid_plan', `plan ${key} is not canonical`);
		}
	}
	if (typeof plan.expires_at !== 'string' || !plan.expires_at.trim()) {
		stop('plan_expired', 'plan expiry must be a non-empty string');
	}
	if (!plan.step || Array.isArray(plan.step)) stop('multiple_steps', 'plan must contain one step');
	if (!plan.target || Array.isArray(plan.target)) stop('invalid_target', 'plan target is required');
	const normalizedTarget = normalizeTarget(plan.target);
	const normalizedStep = normalizeStep(plan.step);
	if (canonicalJson(normalizedTarget) !== canonicalJson(plan.target)) {
		stop('invalid_target', 'plan target is not canonical');
	}
	if (canonicalJson(normalizedStep) !== canonicalJson(plan.step)) {
		stop('invalid_step', 'plan step is not canonical');
	}
	const normalizedRollback = normalizeRollback(plan.rollback, normalizedTarget);
	if (canonicalJson(normalizedRollback) !== canonicalJson(plan.rollback)) {
		stop('invalid_rollback', 'plan rollback is not canonical');
	}
	assertNoCollision({ state: plan.before }, normalizedTarget, normalizedStep, plan.after);
	assertInboundTopology(normalizedTarget, normalizedStep, plan.after);
	assertAuthoritativeDnsSnapshot(normalizedTarget, normalizedStep, plan.before);
	assertDnsRollbackInvariants(normalizedStep, normalizedRollback);
	assertStepCapabilityContract(normalizedStep, normalizedTarget);
	if (typeof plan.plan_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(plan.plan_hash)) {
		stop('plan_hash_mismatch', 'plan hash is missing or malformed');
	}
	const expectedHash = fingerprint(safePlanHashInput(plan));
	if (!constantEqual(expectedHash, plan.plan_hash))
		stop('plan_hash_mismatch', 'plan hash does not match');
	if (fingerprint(plan.before) !== plan.current_state_fingerprint) {
		stop('plan_state_mismatch', 'plan before state fingerprint does not match');
	}
	if (fingerprint(plan.after) !== plan.desired_state_fingerprint) {
		stop('plan_state_mismatch', 'plan after state fingerprint does not match');
	}
	const expectedDiff = diffValues(plan.before, plan.after);
	if (canonicalJson(plan.diff) !== canonicalJson(expectedDiff)) {
		stop('plan_diff_mismatch', 'plan diff does not match its before and after states');
	}
	return plan;
}

function normalizeProviderResult(result) {
	if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
	const safe = {};
	for (const key of SAFE_PROVIDER_RESULT_KEYS) {
		if (result[key] === undefined) continue;
		if (
			typeof result[key] === 'string' ||
			typeof result[key] === 'boolean' ||
			typeof result[key] === 'number'
		) {
			safe[key] = result[key];
		}
	}
	return safe;
}

function adapterOrStop(adapter) {
	if (!adapter || typeof adapter !== 'object')
		stop('adapter_missing', 'a narrow setup adapter is required');
	for (const method of ['inspect', 'applyStep', 'rollbackStep']) {
		if (typeof adapter[method] !== 'function')
			stop('adapter_invalid', `adapter.${method} is required`);
	}
	return adapter;
}

function providerReadFailure(error) {
	if (error instanceof SetupEngineError) return error;
	return new SetupEngineError('provider_read_failed', 'provider state could not be read safely');
}

export async function inspectSetup({
	adapter,
	adapters,
	target,
	step,
	request = null,
	now = Date.now()
}) {
	const normalizedTarget = normalizeTarget(target);
	const selectedAdapter = resolveAdapter(adapters, { target: normalizedTarget }, adapter);
	const normalizedStep = step ? normalizeStep(step) : undefined;
	if (normalizedStep) assertStepCapabilityContract(normalizedStep, normalizedTarget);
	let result;
	try {
		result = await selectedAdapter.inspect({
			target: cloneSafe(normalizedTarget),
			...(normalizedStep ? { step: cloneSafe(normalizedStep) } : {}),
			request: request === null ? null : cloneSafe(request)
		});
	} catch (error) {
		throw providerReadFailure(error);
	}
	if (!result || typeof result !== 'object' || Array.isArray(result)) {
		stop('provider_read_failed', 'provider inspection returned no readable state');
	}
	if (
		result.ok === false ||
		result.error ||
		result.failed === true ||
		result.list_failed === true ||
		result.read_failed === true
	) {
		stop('provider_read_failed', 'provider inspection failed; an empty result is not safe');
	}
	if (result.list_complete === false || result.complete === false) {
		stop('provider_read_failed', 'provider list was incomplete; an empty result is not safe');
	}
	const state = ensureInspectionState(result.state ?? result.snapshot, 'provider state');
	const observedAt = new Date(now).toISOString();
	return {
		schema_version: SETUP_ENGINE_SCHEMA_VERSION,
		target: cloneSafe(normalizedTarget),
		state,
		current_state_fingerprint: fingerprint(state),
		observed_at: observedAt,
		...(result.authoritative === true ? { authoritative: true } : {}),
		...(typeof result.resource_count === 'number' ? { resource_count: result.resource_count } : {})
	};
}

export function createMutationPlan({
	inspection,
	target,
	step,
	desiredState,
	rollback,
	approvalId,
	expiresAt,
	now = Date.now(),
	planId = randomUUID()
}) {
	assertObject(inspection, 'inspection');
	const inspectedTarget = normalizeTarget(inspection.target);
	const normalizedTarget = normalizeTarget(target ?? inspectedTarget);
	if (canonicalJson(inspectedTarget) !== canonicalJson(normalizedTarget)) {
		stop('target_mismatch', 'plan target differs from inspected target');
	}
	const normalizedStep = normalizeStep(step);
	assertStepCapabilityContract(normalizedStep, normalizedTarget);
	const before = ensureState(inspection.state, 'inspection.state');
	const currentFingerprint = fingerprint(before);
	if (!constantEqual(currentFingerprint, inspection.current_state_fingerprint)) {
		stop('plan_state_mismatch', 'inspection state changed before planning');
	}
	const after = ensureState(desiredState, 'desiredState');
	assertNoCollision(inspection, normalizedTarget, normalizedStep, after);
	assertInboundTopology(normalizedTarget, normalizedStep, after);
	assertAuthoritativeDnsSnapshot(normalizedTarget, normalizedStep, before);
	const normalizedRollback = normalizeRollback(rollback, normalizedTarget);
	assertDnsRollbackInvariants(normalizedStep, normalizedRollback);
	const normalizedApproval = normalizeString(approvalId, 'approval_id');
	const normalizedPlanId = normalizeString(planId, 'plan_id');
	const expires = ensureFreshExpiry(expiresAt, now);
	const plan = {
		schema_version: SETUP_ENGINE_SCHEMA_VERSION,
		plan_id: normalizedPlanId,
		step: normalizedStep,
		target: normalizedTarget,
		before,
		after,
		diff: diffValues(before, after),
		current_state_fingerprint: currentFingerprint,
		desired_state_fingerprint: fingerprint(after),
		rollback: normalizedRollback,
		approval_id: normalizedApproval,
		expires_at: expires,
		created_at: new Date(now).toISOString(),
		plan_hash: ''
	};
	plan.rollback.approval_id = normalizeString(
		plan.rollback.approval_id ?? `${normalizedPlanId}:rollback`,
		'rollback.approval_id'
	);
	plan.plan_hash = fingerprint(safePlanHashInput(plan));
	assertPlanShape(plan);
	return cloneSafe(plan);
}

export function verifyMutationPlan(plan, { now = Date.now(), target } = {}) {
	assertPlanShape(plan);
	const normalizedTarget = normalizeTarget(plan.target);
	if (target && canonicalJson(normalizedTarget) !== canonicalJson(normalizeTarget(target))) {
		stop('target_mismatch', 'approved target does not match the plan target');
	}
	const expiryMs = Date.parse(plan.expires_at);
	if (!Number.isFinite(expiryMs) || expiryMs <= now)
		stop('plan_expired', 'approved plan has expired or has an invalid expiry');
	return cloneSafe(plan);
}

function newApplyState(plan) {
	return {
		schema_version: APPLY_STATE_SCHEMA_VERSION,
		plan_id: plan.plan_id,
		plan_hash: plan.plan_hash,
		approval_id: plan.approval_id,
		approved: true,
		consumed: false,
		apply_started: false,
		readback_verified: false
	};
}

function assertApplyStateShape(state) {
	assertObject(state, 'apply state');
	for (const key of Object.keys(state)) {
		if (!APPLY_STATE_FIELDS.has(key))
			stop('state_schema_mismatch', `apply state field ${key} is not allowed`);
	}
	if (state.schema_version !== APPLY_STATE_SCHEMA_VERSION) {
		stop('state_schema_mismatch', 'apply state schema is not supported');
	}
	for (const key of ['plan_id', 'plan_hash', 'approval_id']) {
		if (typeof state[key] !== 'string' || !state[key].trim()) {
			stop('state_schema_mismatch', `apply state ${key} is required`);
		}
	}
	if (!/^[a-f0-9]{64}$/u.test(state.plan_hash)) {
		stop('state_schema_mismatch', 'apply state plan hash is malformed');
	}
	for (const key of ['approved', 'consumed', 'apply_started', 'readback_verified']) {
		if (typeof state[key] !== 'boolean') {
			stop('state_schema_mismatch', `apply state ${key} must be boolean`);
		}
	}
	if (!state.approved && (state.consumed || state.apply_started || state.readback_verified)) {
		stop('state_schema_mismatch', 'unapproved apply state cannot be in progress');
	}
	if (state.readback_verified && !state.apply_started) {
		stop('state_schema_mismatch', 'verified apply state must have started');
	}
	if (state.apply_started && !state.consumed) {
		stop('state_schema_mismatch', 'started apply state must have consumed approval');
	}
	return state;
}

function assertApplyStateForPlan(state, plan) {
	assertApplyStateShape(state);
	if (
		state.plan_id !== plan.plan_id ||
		state.plan_hash !== plan.plan_hash ||
		state.approval_id !== plan.approval_id
	) {
		stop('state_mismatch', 'resumable state is bound to another plan or approval');
	}
	return state;
}

export class InMemoryApprovalLedger {
	#approvals = new Map();

	approve(plan, { now = Date.now() } = {}) {
		const verified = verifyMutationPlan(plan, { now });
		const existing = this.#approvals.get(verified.approval_id);
		if (existing && existing.plan_hash !== verified.plan_hash) {
			stop('approval_mismatch', 'approval ID is already bound to another plan');
		}
		this.#approvals.set(
			verified.approval_id,
			existing ?? { ...newApplyState(verified), expires_at: verified.expires_at, used_at: null }
		);
		return { approval_id: verified.approval_id, plan_hash: verified.plan_hash };
	}

	consume(plan, { approvalId, now = Date.now() } = {}) {
		const verified = verifyMutationPlan(plan, { now });
		if (approvalId !== verified.approval_id)
			stop('approval_mismatch', 'approval ID does not match the plan');
		const approval = this.#approvals.get(approvalId);
		if (!approval || approval.plan_hash !== verified.plan_hash) {
			stop('approval_mismatch', 'approval is missing or bound to another plan');
		}
		if (approval.used_at || approval.consumed)
			stop('approval_used', 'approval is one-use and has already been consumed');
		this.#approvals.set(approvalId, {
			...approval,
			consumed: true,
			used_at: new Date(now).toISOString()
		});
		return { approval_id: approvalId, consumed_at: new Date(now).toISOString() };
	}

	beginApply(plan, { approvalId, now = Date.now() } = {}) {
		const verified = verifyMutationPlan(plan, { now });
		if (approvalId !== verified.approval_id)
			stop('approval_mismatch', 'approval ID does not match the plan');
		const approval = this.#approvals.get(approvalId);
		if (!approval || approval.plan_hash !== verified.plan_hash) {
			stop('approval_mismatch', 'approval is missing or bound to another plan');
		}
		if (approval.readback_verified || approval.apply_started) {
			return { ...cloneSafe(approval), resumed: true, started_now: false };
		}
		if (!approval.approved || approval.consumed)
			stop('approval_used', 'approval is not available for a new apply');
		const next = {
			...approval,
			consumed: true,
			apply_started: true,
			used_at: new Date(now).toISOString()
		};
		this.#approvals.set(approvalId, next);
		return { ...cloneSafe(next), resumed: false, started_now: true };
	}

	getApplyState(plan, { now = Date.now() } = {}) {
		const verified = verifyMutationPlan(plan, { now });
		const state = this.#approvals.get(verified.approval_id);
		if (!state || state.kind === 'rollback') return null;
		if (state.plan_hash !== verified.plan_hash) {
			stop('state_mismatch', 'approval state is bound to another plan');
		}
		return cloneSafe(state);
	}

	markReadbackVerified(plan, { now = Date.now() } = {}) {
		const verified = verifyMutationPlan(plan, { now });
		const state = this.#approvals.get(verified.approval_id);
		if (!state || state.plan_hash !== verified.plan_hash || !state.apply_started) {
			stop('state_mismatch', 'apply state cannot be marked verified');
		}
		const next = { ...state, readback_verified: true };
		this.#approvals.set(verified.approval_id, next);
		return { ...cloneSafe(next) };
	}

	approveRollback(plan, { now = Date.now() } = {}) {
		const verified = verifyMutationPlan(plan, { now });
		const approvalId = verified.rollback?.approval_id;
		if (!approvalId) stop('approval_mismatch', 'rollback approval ID is missing');
		const key = `rollback:${approvalId}`;
		const existing = this.#approvals.get(key);
		if (existing && existing.plan_hash !== verified.plan_hash) {
			stop('approval_mismatch', 'rollback approval ID is already bound to another plan');
		}
		this.#approvals.set(key, {
			plan_hash: verified.plan_hash,
			expires_at: verified.expires_at,
			used_at: existing?.used_at ?? null,
			kind: 'rollback'
		});
		return { approval_id: approvalId, plan_hash: verified.plan_hash, kind: 'rollback' };
	}

	consumeRollback(plan, { approvalId, now = Date.now() } = {}) {
		const verified = verifyMutationPlan(plan, { now });
		if (approvalId !== verified.rollback?.approval_id) {
			stop('approval_mismatch', 'rollback approval ID does not match the plan');
		}
		const key = `rollback:${approvalId}`;
		const approval = this.#approvals.get(key);
		if (!approval || approval.plan_hash !== verified.plan_hash) {
			stop('approval_mismatch', 'rollback approval is missing or bound to another plan');
		}
		if (approval.used_at)
			stop('approval_used', 'rollback approval is one-use and has already been consumed');
		this.#approvals.set(key, { ...approval, used_at: new Date(now).toISOString() });
		return { approval_id: approvalId, consumed_at: new Date(now).toISOString(), kind: 'rollback' };
	}

	get(approvalId) {
		const value = this.#approvals.get(approvalId);
		return value ? { ...value } : null;
	}
}

/**
 * Approval ledger backed by the QMJ-10 atomic state file. The state contains
 * only one plan's identity and four monotonic apply flags. A restart may
 * inspect/read back an in-flight write, but never starts the provider step a
 * second time. Rollback approvals remain fail-closed in memory; losing one on
 * restart cannot cause a rollback write.
 */
export class AtomicApprovalLedger {
	#store;
	#rollbackApprovals = new Map();
	#tail = Promise.resolve();

	constructor({ stateStore } = {}) {
		if (
			!stateStore ||
			typeof stateStore.load !== 'function' ||
			typeof stateStore.save !== 'function' ||
			typeof stateStore.withLock !== 'function'
		) {
			stop(
				'state_store_missing',
				'an atomic QMJ-10 state store with a cross-process lock is required'
			);
		}
		this.#store = stateStore;
	}

	#withLock(operation) {
		const run = this.#tail.then(
			() => this.#store.withLock(operation),
			() => this.#store.withLock(operation)
		);
		this.#tail = run.catch(() => undefined);
		return run;
	}

	async #load() {
		const state = await this.#store.load();
		if (state === null) return null;
		return assertApplyStateShape(state);
	}

	#assertPlanState(state, plan) {
		if (!state) stop('approval_mismatch', 'approval state is missing');
		return assertApplyStateForPlan(state, plan);
	}

	approve(plan, { now = Date.now() } = {}) {
		return this.#withLock(async () => {
			const verified = verifyMutationPlan(plan, { now });
			const existing = await this.#load();
			if (existing) {
				this.#assertPlanState(existing, verified);
				return { approval_id: verified.approval_id, plan_hash: verified.plan_hash };
			}
			await this.#store.save(newApplyState(verified));
			return { approval_id: verified.approval_id, plan_hash: verified.plan_hash };
		});
	}

	getApplyState(plan, { now = Date.now() } = {}) {
		return this.#withLock(async () => {
			const verified = verifyMutationPlan(plan, { now });
			const state = await this.#load();
			if (!state) return null;
			return cloneSafe(this.#assertPlanState(state, verified));
		});
	}

	beginApply(plan, { approvalId, now = Date.now() } = {}) {
		return this.#withLock(async () => {
			const verified = verifyMutationPlan(plan, { now });
			if (approvalId !== verified.approval_id)
				stop('approval_mismatch', 'approval ID does not match the plan');
			const state = this.#assertPlanState(await this.#load(), verified);
			if (state.readback_verified || state.apply_started) {
				return { ...cloneSafe(state), resumed: true, started_now: false };
			}
			if (!state.approved || state.consumed)
				stop('approval_used', 'approval is not available for a new apply');
			const next = { ...state, consumed: true, apply_started: true };
			await this.#store.save(next);
			return { ...cloneSafe(next), resumed: false, started_now: true };
		});
	}

	markReadbackVerified(plan, { now = Date.now() } = {}) {
		return this.#withLock(async () => {
			const verified = verifyMutationPlan(plan, { now });
			const state = this.#assertPlanState(await this.#load(), verified);
			if (!state.apply_started)
				stop('state_mismatch', 'apply state cannot be marked verified before apply starts');
			if (state.readback_verified) return cloneSafe(state);
			const next = { ...state, readback_verified: true };
			await this.#store.save(next);
			return cloneSafe(next);
		});
	}

	approveRollback(plan, { now = Date.now() } = {}) {
		return this.#withLock(async () => {
			const verified = verifyMutationPlan(plan, { now });
			const approvalId = verified.rollback?.approval_id;
			if (!approvalId) stop('approval_mismatch', 'rollback approval ID is missing');
			const existing = this.#rollbackApprovals.get(approvalId);
			if (existing && existing.plan_hash !== verified.plan_hash) {
				stop('approval_mismatch', 'rollback approval ID is already bound to another plan');
			}
			this.#rollbackApprovals.set(approvalId, {
				plan_hash: verified.plan_hash,
				expires_at: verified.expires_at,
				used_at: existing?.used_at ?? null
			});
			return { approval_id: approvalId, plan_hash: verified.plan_hash, kind: 'rollback' };
		});
	}

	consumeRollback(plan, { approvalId, now = Date.now() } = {}) {
		return this.#withLock(async () => {
			const verified = verifyMutationPlan(plan, { now });
			if (approvalId !== verified.rollback?.approval_id) {
				stop('approval_mismatch', 'rollback approval ID does not match the plan');
			}
			const approval = this.#rollbackApprovals.get(approvalId);
			if (!approval || approval.plan_hash !== verified.plan_hash) {
				stop('approval_mismatch', 'rollback approval is missing or bound to another plan');
			}
			if (approval.used_at)
				stop('approval_used', 'rollback approval is one-use and has already been consumed');
			this.#rollbackApprovals.set(approvalId, {
				...approval,
				used_at: new Date(now).toISOString()
			});
			return {
				approval_id: approvalId,
				consumed_at: new Date(now).toISOString(),
				kind: 'rollback'
			};
		});
	}
}

function resolveAdapter(adapters, plan, explicit) {
	if (explicit) return adapterOrStop(explicit);
	const adapter = adapters?.[plan.target.adapter_kind] ?? adapters?.[plan.target.provider];
	return adapterOrStop(adapter);
}

function assertBrowserReadOnly(target) {
	if (target.adapter_kind === 'browser') {
		stop('browser_read_only', 'browser adapters are inspect-only in QMJ-10');
	}
}

export async function applyMutationPlan({
	plan,
	adapter,
	adapters,
	approvalLedger,
	approvalId,
	target,
	now = Date.now()
}) {
	const verified = verifyMutationPlan(plan, { now, target });
	assertBrowserReadOnly(verified.target);
	const ledger = approvalLedger ?? new InMemoryApprovalLedger();
	const selectedAdapter = resolveAdapter(adapters, verified, adapter);
	let current;
	try {
		current = await inspectSetup({
			adapter: selectedAdapter,
			target: verified.target,
			step: verified.step,
			now
		});
	} catch (error) {
		throw providerReadFailure(error);
	}
	const applyState =
		typeof ledger.getApplyState === 'function'
			? await ledger.getApplyState(verified, { now })
			: null;
	if (applyState?.readback_verified || applyState?.apply_started) {
		if (constantEqual(current.current_state_fingerprint, verified.desired_state_fingerprint)) {
			if (!applyState.readback_verified && typeof ledger.markReadbackVerified === 'function') {
				await ledger.markReadbackVerified(verified, { now });
			}
			return {
				status: applyState.readback_verified ? 'already_verified' : 'recovered',
				writes: 0,
				readback: cloneSafe(current),
				verified: true
			};
		}
		stop(
			'apply_recovery_required',
			'apply was started but readback is not the approved after state; inspect before any new plan'
		);
	}
	if (!constantEqual(current.current_state_fingerprint, verified.current_state_fingerprint)) {
		stop('current_state_mismatch', 'provider state changed after planning; no write was made');
	}
	const applyTransition =
		typeof ledger.beginApply === 'function'
			? await ledger.beginApply(verified, {
					approvalId: approvalId ?? verified.approval_id,
					now
				})
			: await Promise.resolve(
					ledger.consume(verified, { approvalId: approvalId ?? verified.approval_id, now })
				);
	if (applyTransition?.apply_started && applyTransition.started_now === false) {
		stop(
			'apply_recovery_required',
			'apply was started by another attempt; inspect current state before any new write'
		);
	}
	let providerResult;
	try {
		providerResult = await selectedAdapter.applyStep({ plan: cloneSafe(verified) });
	} catch {
		stop('provider_apply_failed', 'provider step failed after approval; inspect before retrying');
	}
	let readback;
	try {
		readback = await inspectSetup({
			adapter: selectedAdapter,
			target: verified.target,
			step: verified.step,
			now
		});
	} catch {
		stop(
			'readback_failed',
			'provider result is unverified; inspect current state before retrying',
			{
				applied: true
			}
		);
	}
	if (!constantEqual(readback.current_state_fingerprint, verified.desired_state_fingerprint)) {
		stop('readback_mismatch', 'provider readback differs from the approved after state', {
			applied: true
		});
	}
	if (typeof ledger.markReadbackVerified === 'function') {
		await ledger.markReadbackVerified(verified, { now });
	}
	return {
		status: 'applied',
		writes: 1,
		provider_result: normalizeProviderResult(providerResult),
		readback: cloneSafe(readback),
		verified: true
	};
}

export function verifyMutationReadback(plan, state, { phase = 'after', now = Date.now() } = {}) {
	const verified = verifyMutationPlan(plan, { now });
	const expected =
		phase === 'before' ? verified.current_state_fingerprint : verified.desired_state_fingerprint;
	const actual = fingerprint(ensureState(state, 'readback state'));
	if (!constantEqual(actual, expected))
		stop('readback_mismatch', `${phase} state does not match the approved plan`);
	return { verified: true, phase, fingerprint: actual };
}

export async function rollbackMutationPlan({
	plan,
	adapter,
	adapters,
	approvalLedger,
	rollbackApprovalId,
	now = Date.now(),
	target
}) {
	const verified = verifyMutationPlan(plan, { now, target });
	assertBrowserReadOnly(verified.target);
	if (isProtectedResourceType(verified.target.provider, verified.target.resource_type)) {
		return {
			status: 'manual_review_required',
			writes: 0,
			reason: 'protected resource is never automatically deleted'
		};
	}
	if (verified.step.kind === 'dns_change' && verified.rollback.mode !== 'restore_owned_records') {
		stop('invalid_rollback', 'DNS rollback requires restore_owned_records');
	}
	if (verified.step.kind === 'dns_change' && !verified.rollback.owned_resource_ids.length) {
		stop('invalid_rollback', 'DNS rollback has no owned-record boundary');
	}
	const selectedAdapter = resolveAdapter(adapters, verified, adapter);
	let current;
	try {
		current = await inspectSetup({
			adapter: selectedAdapter,
			target: verified.target,
			step: verified.step,
			now
		});
	} catch (error) {
		throw providerReadFailure(error);
	}
	if (
		constantEqual(current.current_state_fingerprint, verified.current_state_fingerprint) ||
		(verified.step.kind === 'dns_change' &&
			dnsRollbackReadbackMatches(
				current.state,
				verified.before,
				verified.after,
				verified.rollback.owned_resource_ids
			))
	) {
		return { status: 'noop', writes: 0, verified: true, readback: cloneSafe(current) };
	}
	const currentMatchesApproved =
		constantEqual(current.current_state_fingerprint, verified.desired_state_fingerprint) ||
		(verified.step.kind === 'dns_change' && dnsStateSuperset(current.state, verified.after));
	if (!currentMatchesApproved) {
		stop('rollback_drift', 'current state differs from both approved snapshots; no write was made');
	}
	if (verified.rollback.mode === 'manual_review' || verified.rollback.mode === 'not_needed') {
		return { status: 'manual_review_required', writes: 0, reason: 'rollback is not automated' };
	}
	if (!approvalLedger || typeof approvalLedger.consumeRollback !== 'function') {
		stop('approval_mismatch', 'rollback requires a separate one-use approval');
	}
	await approvalLedger.consumeRollback(verified, {
		approvalId: rollbackApprovalId ?? verified.rollback.approval_id,
		now
	});
	let result;
	try {
		result = await selectedAdapter.rollbackStep({
			plan: cloneSafe(verified),
			owned_resource_ids: [...verified.rollback.owned_resource_ids],
			preserve_unowned: verified.rollback.preserve_unowned
		});
	} catch {
		stop('rollback_failed', 'rollback failed; inspect provider state before retrying');
	}
	let readback;
	try {
		readback = await inspectSetup({
			adapter: selectedAdapter,
			target: verified.target,
			step: verified.step,
			now
		});
	} catch {
		stop('rollback_readback_failed', 'rollback result is unverified; inspect provider state');
	}
	const rollbackMatchesApproved =
		constantEqual(readback.current_state_fingerprint, verified.current_state_fingerprint) ||
		(verified.step.kind === 'dns_change' &&
			dnsRollbackReadbackMatches(
				readback.state,
				verified.before,
				verified.after,
				verified.rollback.owned_resource_ids
			));
	if (!rollbackMatchesApproved) {
		stop('rollback_readback_mismatch', 'rollback readback differs from the original snapshot');
	}
	return {
		status: 'rolled_back',
		writes: 1,
		provider_result: normalizeProviderResult(result),
		readback: cloneSafe(readback),
		verified: true
	};
}

export class SetupEngine {
	constructor({ adapters = {}, approvalLedger, stateStore, clock = () => Date.now() } = {}) {
		this.adapters = adapters;
		this.approvalLedger =
			approvalLedger ??
			(stateStore ? new AtomicApprovalLedger({ stateStore }) : new InMemoryApprovalLedger());
		this.clock = clock;
	}

	inspect(input) {
		return inspectSetup({ ...input, now: input?.now ?? this.clock(), adapters: this.adapters });
	}

	plan(input) {
		return createMutationPlan({ ...input, now: input?.now ?? this.clock() });
	}

	approve(plan) {
		return this.approvalLedger.approve(plan, { now: this.clock() });
	}

	approveRollback(plan) {
		return this.approvalLedger.approveRollback(plan, { now: this.clock() });
	}

	apply(plan, { adapter, approvalId, target, now = this.clock() } = {}) {
		return applyMutationPlan({
			plan,
			adapter,
			adapters: this.adapters,
			approvalLedger: this.approvalLedger,
			approvalId,
			target,
			now
		});
	}

	rollback(plan, { adapter, target, rollbackApprovalId, now = this.clock() } = {}) {
		return rollbackMutationPlan({
			plan,
			adapter,
			adapters: this.adapters,
			approvalLedger: this.approvalLedger,
			target,
			rollbackApprovalId,
			now
		});
	}
}

export function createSetupEngine(options) {
	return new SetupEngine(options);
}

export function createAtomicSetupStateStore(filePath) {
	const path = normalizeString(filePath, 'state file path');
	const lockPath = `${path}.lock`;
	return {
		async withLock(operation) {
			if (typeof operation !== 'function')
				stop('state_lock_failed', 'state lock operation must be a function');
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			let lockHandle;
			try {
				lockHandle = await open(lockPath, 'wx', 0o600);
			} catch (error) {
				if (error?.code === 'EEXIST') {
					stop(
						'state_lock_unavailable',
						'atomic setup state is locked; stale locks are never removed automatically'
					);
				}
				throw new SetupEngineError(
					'state_lock_failed',
					'atomic setup state lock could not be acquired'
				);
			}
			let result;
			let operationError;
			try {
				result = await operation();
			} catch (error) {
				operationError = error;
			}
			let releaseError;
			try {
				await lockHandle.close();
			} catch (error) {
				releaseError = error;
			}
			try {
				await unlink(lockPath);
			} catch (error) {
				releaseError ??= error;
			}
			if (operationError) throw operationError;
			if (releaseError) {
				throw new SetupEngineError(
					'state_lock_release_failed',
					'atomic setup state lock could not be released safely'
				);
			}
			return result;
		},
		async save(state) {
			const safe = cloneSafe(state);
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			const temporaryPath = `${path}.${randomUUID()}.tmp`;
			try {
				const handle = await open(temporaryPath, 'wx', 0o600);
				try {
					await handle.writeFile(`${canonicalJson(safe)}\n`, 'utf8');
					await handle.chmod(0o600);
				} finally {
					await handle.close();
				}
				await rename(temporaryPath, path);
			} catch (error) {
				await unlink(temporaryPath).catch(() => undefined);
				throw error;
			}
		},
		async load() {
			try {
				const contents = await readFile(path, 'utf8');
				return cloneSafe(JSON.parse(contents));
			} catch (error) {
				if (error?.code === 'ENOENT') return null;
				if (error instanceof SetupEngineError) throw error;
				throw new SetupEngineError(
					'state_read_failed',
					'resumable setup state could not be read safely'
				);
			}
		}
	};
}

export function assertProtectedRollbackBoundary(resourceType) {
	if (
		isProtectedResourceType('cloudflare', resourceType) ||
		isProtectedResourceType('resend', resourceType)
	) {
		stop('protected_resource', 'protected resources require manual review for cleanup');
	}
	return true;
}
