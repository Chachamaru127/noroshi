import { fingerprint } from './setup-engine.mjs';

export const SETUP_STAGE_ORDER = Object.freeze([
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

const REQUIRED_CANARY_SURFACES = Object.freeze([
	'email_routing_activity',
	'worker_d1',
	'resend',
	'quickmail_ui'
]);

const APPROVAL_FIELDS = Object.freeze([
	'target',
	'payload',
	'before',
	'after',
	'rollback',
	'plan_hash',
	'expires_at'
]);

function exactApprovalOperation(scope) {
	const exact = {};
	for (const field of APPROVAL_FIELDS) {
		if (scope?.[field] === undefined) throw new TypeError(`approval ${field} is required`);
		exact[field] = scope[field];
	}
	if (!/^[a-f0-9]{64}$/u.test(exact.plan_hash)) {
		throw new TypeError('approval plan_hash must be a SHA-256 hex digest');
	}
	if (!Number.isFinite(Date.parse(exact.expires_at))) {
		throw new TypeError('approval expires_at must be an ISO date');
	}
	return exact;
}

export class ApprovalScopeLedger {
	#approvals = new Map();
	#invalidatedKeys = new Set();
	#identity = null;
	#identityFingerprint = null;
	#identityEpoch = 0;

	bindIdentity(value) {
		const normalized = normalizedIdentity(value);
		if (!normalized) throw new TypeError('approval identity requires account, zone and domain');
		const nextFingerprint = fingerprint(normalized);
		if (this.#identityFingerprint && this.#identityFingerprint !== nextFingerprint) {
			throw new TypeError('approval ledger is bound to another observed identity');
		}
		this.#identity = normalized;
		this.#identityFingerprint = nextFingerprint;
		return { ...normalized };
	}

	invalidateForObservedIdentity(value, { reason = 'identity_changed' } = {}) {
		const observed = normalizedIdentity(value);
		let invalidatedGrants = 0;
		for (const [key, grants] of this.#approvals) {
			this.#invalidatedKeys.add(key);
			invalidatedGrants += grants.filter((grant) => !grant.consumed).length;
		}
		this.#approvals.clear();
		this.#identityEpoch += 1;
		this.#identity = observed;
		this.#identityFingerprint = observed ? fingerprint(observed) : null;
		return {
			reason,
			invalidated_grants: invalidatedGrants,
			identity_epoch: this.#identityEpoch,
			identity: observed ? { ...observed } : null
		};
	}

	approve(scope) {
		if (!this.#identityFingerprint) {
			throw new TypeError(
				'approval requires a bound account, zone and domain identity before issuance'
			);
		}
		if (!Number.isSafeInteger(scope?.count) || scope.count < 1) {
			throw new TypeError('approval count must be a positive integer');
		}
		const exact = exactApprovalOperation(scope);
		const key = fingerprint(exact);
		const grants = this.#approvals.get(key) ?? [];
		for (let index = 0; index < scope.count; index += 1) {
			grants.push({
				consumed: false,
				identity_fingerprint: this.#identityFingerprint,
				identity_epoch: this.#identityEpoch
			});
		}
		this.#approvals.set(key, grants);
		this.#invalidatedKeys.delete(key);
	}

	consume(scope, { now = new Date().toISOString() } = {}) {
		const exact = exactApprovalOperation(scope);
		const key = fingerprint(exact);
		if (this.#invalidatedKeys.has(key)) {
			return { status: 'approval_required', reason: 'identity_invalidated' };
		}
		const grants = this.#approvals.get(key);
		if (!grants) return { status: 'approval_required', reason: 'scope_changed' };
		if (Date.parse(now) >= Date.parse(exact.expires_at)) {
			return { status: 'approval_required', reason: 'expired' };
		}
		const grant = grants.find((candidate) => !candidate.consumed);
		if (!grant) return { status: 'approval_required', reason: 'exhausted' };
		grant.consumed = true;
		return {
			status: 'approved',
			unused_grants: grants.filter((candidate) => !candidate.consumed).length
		};
	}
}

export function assessHostCapabilities(capabilities = {}) {
	const missing = [];
	if (!capabilities.computer_use) missing.push('computer_use');
	if (!capabilities.authenticated_browser) missing.push('authenticated_browser');
	return {
		browser_mode:
			capabilities.computer_use && capabilities.authenticated_browser ? 'assisted' : 'manual',
		terminal_mode: capabilities.terminal ? 'assisted' : 'manual',
		secret_entry_mode:
			capabilities.secret_entry === 'broker' ? 'secret_input_broker' : 'human_direct',
		missing
	};
}

function identity(state) {
	return {
		account: state.account,
		zone: state.zone,
		domain: state.domain
	};
}

function normalizedIdentity(value) {
	if (!completeIdentity(value)) return null;
	return {
		account: value.account.trim(),
		zone: value.zone.trim(),
		domain: value.domain.trim().toLowerCase()
	};
}

function completeIdentity(value) {
	return ['account', 'zone', 'domain'].every(
		(key) => typeof value?.[key] === 'string' && value[key].trim().length > 0
	);
}

function sameIdentity(left, right) {
	return ['account', 'zone', 'domain'].every((key) => left[key] === right[key]);
}

export async function recoverBrowserSession(browser, expected, { approvalLedger, reacquire } = {}) {
	if (
		!approvalLedger ||
		typeof approvalLedger.bindIdentity !== 'function' ||
		typeof approvalLedger.invalidateForObservedIdentity !== 'function'
	) {
		throw new TypeError('browser recovery requires an approval ledger');
	}
	const expectedIdentity = normalizedIdentity(expected.expected_identity);
	if (!expectedIdentity) throw new TypeError('expected identity requires account, zone and domain');
	approvalLedger.bindIdentity(expectedIdentity);

	const invalidate = (value, reason, status) => {
		const invalidation = approvalLedger.invalidateForObservedIdentity(value, { reason });
		return {
			status,
			requires_new_approval: true,
			invalidated_grants: invalidation.invalidated_grants
		};
	};

	let state = await browser.inspect();
	let reacquired = false;
	if (state.tab === 'missing') {
		if (!expected.allowed_origins.includes(expected.expected_origin)) {
			return invalidate(null, 'unexpected_origin', 'unexpected_origin');
		}
		if (typeof reacquire !== 'function') {
			return invalidate(null, 'identity_unavailable', 'reacquire_required');
		}
		await reacquire(expected.expected_origin);
		state = await browser.inspect();
		reacquired = true;
	}
	if (
		!expected.allowed_origins.includes(state.origin) ||
		state.origin !== expected.expected_origin
	) {
		return invalidate(null, 'unexpected_origin', 'unexpected_origin');
	}
	if (!state.authenticated) {
		return invalidate(null, 'session_expired', 'human_reauthentication');
	}
	if (state.dom_contract !== expected.expected_dom_contract) {
		return invalidate(null, 'official_dom_changed', 'official_dom_changed');
	}
	const currentIdentity = normalizedIdentity(identity(state));
	if (!currentIdentity) {
		return invalidate(null, 'identity_unavailable', 'identity_unavailable');
	}
	if (!sameIdentity(expectedIdentity, currentIdentity)) {
		const invalidation = approvalLedger.invalidateForObservedIdentity(currentIdentity, {
			reason: 'identity_changed'
		});
		return {
			status: 'identity_changed',
			requires_new_approval: true,
			identity: currentIdentity,
			invalidated_grants: invalidation.invalidated_grants
		};
	}
	if (state.clipboard === 'isolated') {
		return {
			status: 'human_secret_entry_required',
			allowed_methods: ['human_direct', 'secret_input_broker'],
			display_secret: false
		};
	}
	return {
		status: 'ready',
		identity: currentIdentity,
		...(reacquired ? { reacquired: true } : {})
	};
}

function normalizedDnsObservation(observation) {
	if (
		typeof observation?.domain !== 'string' ||
		!observation.domain.trim() ||
		!/^[a-f0-9]{64}$/u.test(observation.configuration_fingerprint) ||
		!Array.isArray(observation.mx) ||
		observation.mx.length === 0 ||
		!Array.isArray(observation.txt) ||
		observation.txt.length === 0
	) {
		return null;
	}
	return {
		domain: observation.domain.toLowerCase(),
		configuration_fingerprint: observation.configuration_fingerprint,
		mx: [...observation.mx].sort(),
		txt: [...observation.txt].sort()
	};
}

export function verifyDnsEvidence(evidence) {
	const authoritative = normalizedDnsObservation(evidence?.authoritative_dns);
	const publicResolver = normalizedDnsObservation(evidence?.public_resolver);
	if (
		!authoritative ||
		!publicResolver ||
		fingerprint(authoritative) !== fingerprint(publicResolver)
	) {
		return { status: 'incomplete', reason: 'dns_evidence_mismatch' };
	}
	return {
		status: 'verified',
		domain: authoritative.domain,
		configuration_fingerprint: authoritative.configuration_fingerprint
	};
}

export function correlateCanaryEvidence(evidence) {
	const firstToken = evidence?.[REQUIRED_CANARY_SURFACES[0]]?.token;
	if (!isSafeCanaryToken(firstToken)) {
		return { status: 'incomplete', reason: 'invalid_canary_token' };
	}
	const missingOrMismatched = REQUIRED_CANARY_SURFACES.filter((surface) => {
		const item = evidence?.[surface];
		return !item || item.status !== 'observed' || !firstToken || item.token !== firstToken;
	});
	if (missingOrMismatched.length > 0) {
		return { status: 'incomplete', missing_or_mismatched: missingOrMismatched };
	}
	return { status: 'verified', token: firstToken, surfaces: [...REQUIRED_CANARY_SURFACES] };
}

function isSafeCanaryToken(value) {
	return (
		typeof value === 'string' &&
		value.length >= 12 &&
		value.length <= 72 &&
		/^canary-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) &&
		!/(?:secret|password|api-key|bearer|token)/u.test(value) &&
		!/^canary-(?:sk|re|whsec|pk)-/u.test(value)
	);
}
