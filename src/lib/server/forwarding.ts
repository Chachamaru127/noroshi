import type { D1Database } from '@cloudflare/workers-types';
import type { MailAddress } from '$lib/types';
import { getAddressForUser, getDomainByName } from './domains';
import { hashToken } from './crypto';

import {
	createVerificationToken,
	ForwardingStateError,
	ForwardingValidationError,
	ForwardingVerificationError,
	normalizeForwardingDestination,
	type ForwardingAttemptStatus,
	type ForwardingDestinationStatus,
	type ForwardingRuleStatus
} from './forwarding-contract';

export {
	createVerificationToken,
	ForwardingStateError,
	ForwardingValidationError,
	ForwardingVerificationError,
	normalizeForwardingDestination,
	FORWARDING_VERIFICATION_TTL_MS,
	MAX_FORWARDING_DESTINATION_LENGTH
} from './forwarding-contract';
export type {
	ForwardingAttemptStatus,
	ForwardingDestinationStatus,
	ForwardingRuleStatus,
	ForwardingVerificationErrorCode
} from './forwarding-contract';

export const MAX_FORWARDING_ATTEMPTS_PER_PAGE = 100;

export function forwardingVerificationIdempotencyKey(
	destinationId: string,
	verificationTokenHash: string
): string {
	return `forwarding-verification:${destinationId}:${verificationTokenHash}`;
}

export type ForwardingDestination = {
	id: string;
	user_id: string;
	source_address_id: string;
	destination_address: string;
	status: ForwardingDestinationStatus;
	verification_expires_at: string | null;
	verification_used_at: string | null;
	verified_at: string | null;
	created_at: string;
	updated_at: string;
};

export type ForwardingRule = {
	id: string;
	user_id: string;
	source_address_id: string;
	destination_id: string;
	status: ForwardingRuleStatus;
	created_at: string;
	updated_at: string;
};

export type ForwardingAttempt = {
	id: string;
	rule_id: string;
	email_id: string;
	provider_id: string | null;
	status: ForwardingAttemptStatus;
	attempt_count: number;
	next_attempt_at: string | null;
	last_attempt_at: string | null;
	error_code: string | null;
	lease_token: string | null;
	lease_expires_at: string | null;
	hop: number;
	destination_id: string | null;
	destination_address: string | null;
	created_at: string;
	updated_at: string;
};

export type ForwardingRuleView = {
	source_address: MailAddress;
	destination: ForwardingDestination;
	rule: ForwardingRule;
	latest_attempt: ForwardingAttempt | null;
};

export type ForwardingOverview = {
	source_address: MailAddress;
	destination: ForwardingDestination | null;
	rule: ForwardingRule | null;
	latest_attempt: ForwardingAttempt | null;
};

type DestinationRow = {
	id: string;
	user_id: string;
	source_address_id: string;
	destination_address: string;
	status: ForwardingDestinationStatus;
	verification_token_hash: string | null;
	verification_expires_at: string | null;
	verification_used_at: string | null;
	verified_at: string | null;
	created_at: string;
	updated_at: string;
};

type RuleRow = {
	id: string;
	user_id: string;
	source_address_id: string;
	destination_id: string;
	status: ForwardingRuleStatus;
	created_at: string;
	updated_at: string;
};

type AttemptRow = {
	id: string;
	rule_id: string;
	email_id: string;
	provider_id: string | null;
	status: ForwardingAttemptStatus;
	attempt_count: number;
	next_attempt_at: string | null;
	last_attempt_at: string | null;
	error_code: string | null;
	lease_token?: string | null;
	lease_expires_at?: string | null;
	hop?: number;
	destination_id?: string | null;
	destination_address?: string | null;
	created_at: string;
	updated_at: string;
};

type ForwardingAddressRow = {
	id: string;
	user_id: string;
	domain_id: string;
	domain_name: string;
	address: string;
	can_send: number;
	label: string | null;
	is_default: number;
	signature: string | null;
	created_at: string;
};

function mapDestination(row: DestinationRow): ForwardingDestination {
	return {
		id: row.id,
		user_id: row.user_id,
		source_address_id: row.source_address_id,
		destination_address: row.destination_address,
		status: row.status,
		verification_expires_at: row.verification_expires_at,
		verification_used_at: row.verification_used_at,
		verified_at: row.verified_at,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

function mapRule(row: RuleRow): ForwardingRule {
	return {
		id: row.id,
		user_id: row.user_id,
		source_address_id: row.source_address_id,
		destination_id: row.destination_id,
		status: row.status,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

function mapAttempt(row: AttemptRow): ForwardingAttempt {
	return {
		id: row.id,
		rule_id: row.rule_id,
		email_id: row.email_id,
		provider_id: row.provider_id,
		status: row.status,
		attempt_count: row.attempt_count,
		next_attempt_at: row.next_attempt_at,
		last_attempt_at: row.last_attempt_at,
		error_code: row.error_code,
		lease_token: row.lease_token ?? null,
		lease_expires_at: row.lease_expires_at ?? null,
		hop: row.hop ?? 0,
		destination_id: row.destination_id ?? null,
		destination_address: row.destination_address ?? null,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

function mapAddress(row: ForwardingAddressRow): MailAddress {
	return {
		id: row.id,
		user_id: row.user_id,
		domain_id: row.domain_id,
		domain_name: row.domain_name,
		address: row.address,
		can_send: row.can_send === 1,
		label: row.label,
		is_default: row.is_default === 1,
		signature: row.signature,
		created_at: row.created_at
	};
}

function destinationDomain(address: string): string {
	return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

async function ensureExternalDestination(
	db: D1Database,
	userId: string,
	source: MailAddress,
	destination: string
): Promise<void> {
	const destinationDomainName = destinationDomain(destination);
	if (
		source.address.toLowerCase() === destination ||
		source.domain_name.toLowerCase() === destinationDomainName
	) {
		throw new ForwardingValidationError('Destination must be outside QuickMail domains');
	}

	const [managedDomain, ownedAddress, loginAddress] = await Promise.all([
		getDomainByName(db, destinationDomainName),
		db
			.prepare('SELECT id FROM addresses WHERE user_id = ? AND lower(address) = ?')
			.bind(userId, destination)
			.first<{ id: string }>(),
		db
			.prepare('SELECT id FROM users WHERE id = ? AND lower(email) = ?')
			.bind(userId, destination)
			.first<{ id: string }>()
	]);

	if (managedDomain || ownedAddress || loginAddress) {
		throw new ForwardingValidationError('Destination must be outside QuickMail domains');
	}
}

export async function getForwardingDestinationForUser(
	db: D1Database,
	userId: string,
	sourceAddressId: string
): Promise<ForwardingDestination | null> {
	const row = await db
		.prepare('SELECT * FROM forwarding_destinations WHERE user_id = ? AND source_address_id = ?')
		.bind(userId, sourceAddressId)
		.first<DestinationRow>();
	return row ? mapDestination(row) : null;
}

async function getDestinationByIdForUser(
	db: D1Database,
	userId: string,
	destinationId: string
): Promise<ForwardingDestination | null> {
	const row = await db
		.prepare('SELECT * FROM forwarding_destinations WHERE user_id = ? AND id = ?')
		.bind(userId, destinationId)
		.first<DestinationRow>();
	return row ? mapDestination(row) : null;
}

export async function getForwardingRuleForUser(
	db: D1Database,
	userId: string,
	ruleId: string
): Promise<ForwardingRule | null> {
	const row = await db
		.prepare('SELECT * FROM forwarding_rules WHERE user_id = ? AND id = ?')
		.bind(userId, ruleId)
		.first<RuleRow>();
	return row ? mapRule(row) : null;
}

/** Delivery uses the address boundary after an inbound message is stored. */
export async function getForwardingRuleForSourceAddress(
	db: D1Database,
	userId: string,
	sourceAddressId: string
): Promise<{ rule: ForwardingRule; destination: ForwardingDestination } | null> {
	const row = await db
		.prepare('SELECT * FROM forwarding_rules WHERE user_id = ? AND source_address_id = ?')
		.bind(userId, sourceAddressId)
		.first<RuleRow>();
	if (!row) return null;
	const destination = await getDestinationByIdForUser(db, userId, row.destination_id);
	if (!destination) return null;
	return { rule: mapRule(row), destination };
}

export async function createOrResetForwardingDestination(
	db: D1Database,
	userId: string,
	input: { sourceAddressId: string; destination: unknown },
	now = new Date()
): Promise<{
	sourceAddress: MailAddress;
	destination: ForwardingDestination;
	rule: ForwardingRule;
	verificationToken: string | null;
	verificationTokenHash: string | null;
	created: boolean;
}> {
	const sourceAddress = await getAddressForUser(db, userId, input.sourceAddressId);
	if (!sourceAddress) throw new ForwardingValidationError('Source address not found');
	if (sourceAddress.can_send === false)
		throw new ForwardingValidationError('Source address is receive-only');

	const normalized = normalizeForwardingDestination(input.destination);
	await ensureExternalDestination(db, userId, sourceAddress, normalized);

	const existing = await getForwardingDestinationForUser(db, userId, sourceAddress.id);
	const existingRule = await db
		.prepare('SELECT * FROM forwarding_rules WHERE user_id = ? AND source_address_id = ?')
		.bind(userId, sourceAddress.id)
		.first<RuleRow>();

	if (
		existing?.destination_address.toLowerCase() === normalized &&
		existing.status === 'verified'
	) {
		let rule = existingRule ? mapRule(existingRule) : null;
		if (!rule) {
			const ruleId = crypto.randomUUID();
			const timestamp = now.toISOString();
			await db
				.prepare(
					`INSERT INTO forwarding_rules
					 (id, user_id, source_address_id, destination_id, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'disabled', ?, ?)`
				)
				.bind(ruleId, userId, sourceAddress.id, existing.id, timestamp, timestamp)
				.run();
			rule = await getForwardingRuleForUser(db, userId, ruleId);
		}
		if (!rule) throw new Error('Failed to create forwarding rule');
		return {
			sourceAddress,
			destination: existing,
			rule,
			verificationToken: null,
			verificationTokenHash: null,
			created: false
		};
	}

	const generated = await createVerificationToken(now.getTime());
	const timestamp = now.toISOString();
	let destinationId = existing?.id ?? crypto.randomUUID();
	if (existing) {
		await db
			.prepare(
				`UPDATE forwarding_destinations
				 SET destination_address = ?, status = 'pending', verification_token_hash = ?,
				     verification_expires_at = ?, verification_used_at = NULL, verified_at = NULL,
				     updated_at = ?
				 WHERE id = ? AND user_id = ? AND source_address_id = ?`
			)
			.bind(
				normalized,
				generated.tokenHash,
				new Date(generated.expiresAt).toISOString(),
				timestamp,
				destinationId,
				userId,
				sourceAddress.id
			)
			.run();
	} else {
		await db
			.prepare(
				`INSERT INTO forwarding_destinations
				 (id, user_id, source_address_id, destination_address, status,
				  verification_token_hash, verification_expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
			)
			.bind(
				destinationId,
				userId,
				sourceAddress.id,
				normalized,
				generated.tokenHash,
				new Date(generated.expiresAt).toISOString(),
				timestamp,
				timestamp
			)
			.run();
	}

	if (existingRule) {
		await db
			.prepare(
				`UPDATE forwarding_rules
				 SET destination_id = ?, status = 'disabled', enabled_at = NULL, updated_at = ?
				 WHERE id = ? AND user_id = ? AND source_address_id = ?`
			)
			.bind(destinationId, timestamp, existingRule.id, userId, sourceAddress.id)
			.run();
	} else {
		const ruleId = crypto.randomUUID();
		await db
			.prepare(
				`INSERT INTO forwarding_rules
				 (id, user_id, source_address_id, destination_id, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'disabled', ?, ?)`
			)
			.bind(ruleId, userId, sourceAddress.id, destinationId, timestamp, timestamp)
			.run();
	}

	const destination = await getForwardingDestinationForUser(db, userId, sourceAddress.id);
	const rule = await db
		.prepare('SELECT * FROM forwarding_rules WHERE user_id = ? AND source_address_id = ?')
		.bind(userId, sourceAddress.id)
		.first<RuleRow>();
	if (!destination || !rule) throw new Error('Failed to save forwarding configuration');

	return {
		sourceAddress,
		destination,
		rule: mapRule(rule),
		verificationToken: generated.token,
		verificationTokenHash: generated.tokenHash,
		created: !existing
	};
}

export async function verifyForwardingDestination(
	db: D1Database,
	token: string,
	now = new Date()
): Promise<{ destination: ForwardingDestination; rule: ForwardingRule | null }> {
	if (!token || token.length > 512 || /[\u0000-\u001f\u007f]/.test(token)) {
		throw new ForwardingVerificationError('invalid');
	}

	const tokenHash = await hashToken(token);
	const row = await db
		.prepare('SELECT * FROM forwarding_destinations WHERE verification_token_hash = ?')
		.bind(tokenHash)
		.first<DestinationRow>();
	if (!row) throw new ForwardingVerificationError('invalid');
	if (row.verification_used_at || row.status === 'verified') {
		throw new ForwardingVerificationError('used');
	}

	const expiry = row.verification_expires_at ? Date.parse(row.verification_expires_at) : NaN;
	if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
		throw new ForwardingVerificationError('expired');
	}

	const timestamp = now.toISOString();
	const result = await db
		.prepare(
			`UPDATE forwarding_destinations
			 SET status = 'verified', verified_at = ?, verification_used_at = ?, updated_at = ?
			 WHERE id = ? AND verification_token_hash = ?
			   AND status = 'pending' AND verification_used_at IS NULL`
		)
		.bind(timestamp, timestamp, timestamp, row.id, tokenHash)
		.run();
	if ((result.meta.changes ?? 0) === 0) throw new ForwardingVerificationError('used');

	const destination = await getDestinationByIdForUser(db, row.user_id, row.id);
	if (!destination) throw new Error('Verified destination disappeared');
	const rule = await db
		.prepare('SELECT * FROM forwarding_rules WHERE user_id = ? AND source_address_id = ?')
		.bind(row.user_id, row.source_address_id)
		.first<RuleRow>();

	return { destination, rule: rule ? mapRule(rule) : null };
}

export async function setForwardingRuleEnabled(
	db: D1Database,
	userId: string,
	ruleId: string,
	enabled: boolean,
	now = new Date()
): Promise<ForwardingRule | null> {
	const rule = await getForwardingRuleForUser(db, userId, ruleId);
	if (!rule) return null;

	if (enabled) {
		const destination = await getDestinationByIdForUser(db, userId, rule.destination_id);
		if (!destination || destination.status !== 'verified') {
			throw new ForwardingStateError('Verify the forwarding destination before enabling it');
		}
		const sourceAddress = await getAddressForUser(db, userId, rule.source_address_id);
		if (!sourceAddress) {
			throw new ForwardingStateError('Source address not found');
		}
		if (sourceAddress.can_send === false) {
			throw new ForwardingStateError('Source address is receive-only');
		}
		const currentDestination = normalizeForwardingDestination(destination.destination_address);
		await ensureExternalDestination(db, userId, sourceAddress, currentDestination);
		const result = await db
			.prepare(
				`UPDATE forwarding_rules
				 SET status = 'enabled', enabled_at = COALESCE(enabled_at, ?), updated_at = ?
				 WHERE id = ? AND user_id = ?
				   AND EXISTS (
					   SELECT 1 FROM forwarding_destinations d
					   WHERE d.id = forwarding_rules.destination_id
					     AND d.user_id = forwarding_rules.user_id
					     AND d.status = 'verified'
				   )`
			)
			.bind(now.toISOString(), now.toISOString(), ruleId, userId)
			.run();
		if ((result.meta.changes ?? 0) === 0) {
			throw new ForwardingStateError('Verify the forwarding destination before enabling it');
		}
		return getForwardingRuleForUser(db, userId, ruleId);
	}

	await db
		.prepare(
			"UPDATE forwarding_rules SET status = 'disabled', enabled_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?"
		)
		.bind(now.toISOString(), ruleId, userId)
		.run();

	return getForwardingRuleForUser(db, userId, ruleId);
}

export async function disableForwardingRule(
	db: D1Database,
	userId: string,
	ruleId: string,
	now = new Date()
): Promise<ForwardingRule | null> {
	return setForwardingRuleEnabled(db, userId, ruleId, false, now);
}

export async function listForwardingForUser(
	db: D1Database,
	userId: string
): Promise<ForwardingOverview[]> {
	const { results } = await db
		.prepare(
			`SELECT a.id, a.user_id, a.domain_id, d.name AS domain_name, a.address,
			        d.sending_enabled AS can_send,
			        a.label, a.is_default, a.signature, a.created_at,
			        fd.id AS destination_id, fd.user_id AS destination_user_id,
			        fd.source_address_id AS destination_source_address_id,
			        fd.destination_address, fd.status AS destination_status,
			        fd.verification_expires_at, fd.verification_used_at, fd.verified_at,
			        fd.created_at AS destination_created_at, fd.updated_at AS destination_updated_at,
			        fr.id AS rule_id, fr.user_id AS rule_user_id, fr.source_address_id AS rule_source_address_id,
			        fr.destination_id AS rule_destination_id, fr.status AS rule_status,
			        fr.created_at AS rule_created_at, fr.updated_at AS rule_updated_at
			 FROM addresses a
			 JOIN domains d ON d.id = a.domain_id
			 LEFT JOIN forwarding_destinations fd
			   ON fd.user_id = a.user_id AND fd.source_address_id = a.id
			 LEFT JOIN forwarding_rules fr
			   ON fr.user_id = a.user_id AND fr.source_address_id = a.id
			 WHERE a.user_id = ?
			 ORDER BY a.is_default DESC, a.address ASC`
		)
		.bind(userId)
		.all<
			ForwardingAddressRow & {
				destination_id: string | null;
				destination_user_id: string | null;
				destination_source_address_id: string | null;
				destination_address: string | null;
				destination_status: ForwardingDestinationStatus | null;
				verification_expires_at: string | null;
				verification_used_at: string | null;
				verified_at: string | null;
				destination_created_at: string | null;
				destination_updated_at: string | null;
				rule_id: string | null;
				rule_user_id: string | null;
				rule_source_address_id: string | null;
				rule_destination_id: string | null;
				rule_status: ForwardingRuleStatus | null;
				rule_created_at: string | null;
				rule_updated_at: string | null;
			}
		>();

	return Promise.all(
		results.map(async (row) => {
			const destination = row.destination_id
				? ({
						id: row.destination_id,
						user_id: row.destination_user_id!,
						source_address_id: row.destination_source_address_id!,
						destination_address: row.destination_address!,
						status: row.destination_status!,
						verification_expires_at: row.verification_expires_at,
						verification_used_at: row.verification_used_at,
						verified_at: row.verified_at,
						created_at: row.destination_created_at!,
						updated_at: row.destination_updated_at!
					} satisfies ForwardingDestination)
				: null;
			const rule = row.rule_id
				? ({
						id: row.rule_id,
						user_id: row.rule_user_id!,
						source_address_id: row.rule_source_address_id!,
						destination_id: row.rule_destination_id!,
						status: row.rule_status!,
						created_at: row.rule_created_at!,
						updated_at: row.rule_updated_at!
					} satisfies ForwardingRule)
				: null;

			return {
				source_address: mapAddress(row),
				destination,
				rule,
				latest_attempt:
					rule && destination
						? await getLatestForwardingAttempt(
								db,
								rule.id,
								destination.id,
								destination.destination_address
							)
						: null
			};
		})
	);
}

async function getLatestForwardingAttempt(
	db: D1Database,
	ruleId: string,
	destinationId: string,
	destinationAddress: string
): Promise<ForwardingAttempt | null> {
	const row = await db
		.prepare(
			`SELECT * FROM forwarding_attempts
			 WHERE rule_id = ? AND destination_id = ? AND lower(destination_address) = lower(?)
			 ORDER BY created_at DESC LIMIT 1`
		)
		.bind(ruleId, destinationId, destinationAddress)
		.first<AttemptRow>();
	return row ? mapAttempt(row) : null;
}

export async function createForwardingAttempt(
	db: D1Database,
	input: { ruleId: string; emailId: string; providerId?: string | null; now?: Date }
): Promise<ForwardingAttempt> {
	const relation = await db
		.prepare(
			`SELECT r.id, r.destination_id, d.destination_address, COALESCE(e.forwarding_hop, 0) AS hop
			 FROM forwarding_rules r
			 JOIN forwarding_destinations d ON d.id = r.destination_id AND d.user_id = r.user_id
			 JOIN addresses a ON a.id = r.source_address_id AND a.user_id = r.user_id
			 JOIN emails e ON e.id = ? AND e.user_id = r.user_id
			 WHERE r.id = ?
			   AND e.direction = 'inbound'
			   AND lower(e.to_addr) = lower(a.address)`
		)
		.bind(input.emailId, input.ruleId)
		.first<{ id: string; destination_id: string; destination_address: string; hop: number }>();
	if (!relation) throw new ForwardingStateError('Forwarding rule and email must share an owner');

	const now = input.now ?? new Date();
	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO forwarding_attempts
			 (id, rule_id, email_id, provider_id, status, attempt_count,
			  next_attempt_at, last_attempt_at, error_code, lease_token, lease_expires_at,
			  hop, destination_id, destination_address, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)
			 ON CONFLICT(rule_id, email_id) DO NOTHING`
		)
		.bind(
			id,
			input.ruleId,
			input.emailId,
			input.providerId ?? null,
			now.toISOString(),
			relation.hop,
			relation.destination_id,
			relation.destination_address,
			now.toISOString(),
			now.toISOString()
		)
		.run();

	const attempt = await getForwardingAttempt(db, input.ruleId, input.emailId);
	if (!attempt) throw new Error('Failed to create forwarding attempt');
	return attempt;
}

export async function getForwardingAttempt(
	db: D1Database,
	ruleId: string,
	emailId: string
): Promise<ForwardingAttempt | null> {
	const row = await db
		.prepare('SELECT * FROM forwarding_attempts WHERE rule_id = ? AND email_id = ?')
		.bind(ruleId, emailId)
		.first<AttemptRow>();
	return row ? mapAttempt(row) : null;
}

export async function listDueForwardingAttempts(
	db: D1Database,
	now = new Date(),
	limit = MAX_FORWARDING_ATTEMPTS_PER_PAGE
): Promise<ForwardingAttempt[]> {
	const boundedLimit = Math.max(1, Math.min(MAX_FORWARDING_ATTEMPTS_PER_PAGE, Math.floor(limit)));
	const { results } = await db
		.prepare(
			`SELECT a.*
			 FROM forwarding_attempts a
			 JOIN forwarding_rules r ON r.id = a.rule_id
			 WHERE r.status = 'enabled'
			   AND (
			     (a.attempt_count < 4 AND (
			       (a.status IN ('queued', 'failed') AND a.next_attempt_at IS NOT NULL AND a.next_attempt_at <= ?1)
			       OR (a.status = 'processing' AND a.lease_expires_at IS NOT NULL AND a.lease_expires_at <= ?1)
			     ))
			     OR (a.attempt_count >= 4 AND a.status = 'processing'
			         AND a.lease_expires_at IS NOT NULL AND a.lease_expires_at <= ?1)
			   )
			 ORDER BY a.next_attempt_at ASC
			 LIMIT ?2`
		)
		.bind(now.toISOString(), boundedLimit)
		.all<AttemptRow>();
	return results.map(mapAttempt);
}

export const MAX_FORWARDING_CLAIMS = 4;
export const DEFAULT_FORWARDING_LEASE_MS = 5 * 60 * 1000;

export type ForwardingClaim = ForwardingAttempt & {
	lease_token: string;
	lease_expires_at: string;
};

/** One conditional UPDATE is the whole ownership transition. */
export async function claimForwardingAttempt(
	db: D1Database,
	input: { id: string; leaseToken?: string; now?: Date; leaseMs?: number }
): Promise<ForwardingClaim | null> {
	const now = input.now ?? new Date();
	const leaseToken = input.leaseToken ?? crypto.randomUUID();
	const leaseMs =
		Number.isInteger(input.leaseMs) && (input.leaseMs ?? 0) >= 30_000
			? input.leaseMs!
			: DEFAULT_FORWARDING_LEASE_MS;
	const nowIso = now.toISOString();
	const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
	const result = await db
		.prepare(
			`UPDATE forwarding_attempts
			 SET status = 'processing', lease_token = ?, lease_expires_at = ?,
			     attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
			 WHERE id = ? AND attempt_count < ?
			   AND (
			     (status IN ('queued', 'failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
			     OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
			   )`
		)
		.bind(
			leaseToken,
			leaseExpiresAt,
			nowIso,
			nowIso,
			input.id,
			MAX_FORWARDING_CLAIMS,
			nowIso,
			nowIso
		)
		.run();
	if ((result.meta.changes ?? 0) !== 1) {
		// A fourth claim that crashed before finish must not look "processing"
		// forever. This is terminal cleanup, not another ownership claim.
		await db
			.prepare(
				`UPDATE forwarding_attempts
				 SET status = 'failed', next_attempt_at = NULL, lease_token = NULL,
				     lease_expires_at = NULL, error_code = 'lease_expired', updated_at = ?
				 WHERE id = ? AND status = 'processing' AND attempt_count >= ?
				   AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
			)
			.bind(nowIso, input.id, MAX_FORWARDING_CLAIMS, nowIso)
			.run();
		return null;
	}
	const row = await db
		.prepare('SELECT * FROM forwarding_attempts WHERE id = ? AND lease_token = ?')
		.bind(input.id, leaseToken)
		.first<AttemptRow>();
	if (!row) return null;
	return { ...mapAttempt(row), lease_token: leaseToken, lease_expires_at: leaseExpiresAt };
}

export async function finishForwardingAttempt(
	db: D1Database,
	input: {
		id: string;
		leaseToken: string;
		status: ForwardingAttemptStatus;
		providerId?: string | null;
		nextAttemptAt?: string | null;
		errorCode?: string | null;
		now?: Date;
	}
): Promise<ForwardingAttempt | null> {
	await db
		.prepare(
			`UPDATE forwarding_attempts
			 SET status = ?, provider_id = COALESCE(?, provider_id), next_attempt_at = ?,
			     lease_token = NULL, lease_expires_at = NULL, error_code = ?, updated_at = ?
			 WHERE id = ? AND status = 'processing' AND lease_token = ?`
		)
		.bind(
			input.status,
			input.providerId ?? null,
			input.nextAttemptAt ?? null,
			input.errorCode ?? null,
			(input.now ?? new Date()).toISOString(),
			input.id,
			input.leaseToken
		)
		.run();
	const row = await db
		.prepare('SELECT * FROM forwarding_attempts WHERE id = ?')
		.bind(input.id)
		.first<AttemptRow>();
	return row ? mapAttempt(row) : null;
}

export async function terminalizeExhaustedForwardingAttempts(
	db: D1Database,
	now = new Date()
): Promise<number> {
	const timestamp = now.toISOString();
	const result = await db
		.prepare(
			`UPDATE forwarding_attempts
			 SET status = 'failed', next_attempt_at = NULL, lease_token = NULL,
			     lease_expires_at = NULL, error_code = 'lease_expired', updated_at = ?
			 WHERE status = 'processing' AND attempt_count >= ?
			   AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
		)
		.bind(timestamp, MAX_FORWARDING_CLAIMS, timestamp)
		.run();
	return result.meta.changes ?? 0;
}

export async function updateForwardingAttempt(
	db: D1Database,
	input: {
		id: string;
		status: ForwardingAttemptStatus;
		attemptCount: number;
		providerId?: string | null;
		nextAttemptAt?: string | null;
		errorCode?: string | null;
		now?: Date;
	}
): Promise<ForwardingAttempt | null> {
	if (!Number.isInteger(input.attemptCount) || input.attemptCount < 0) {
		throw new ForwardingValidationError('Attempt count must be a non-negative integer');
	}
	const now = input.now ?? new Date();
	await db
		.prepare(
			`UPDATE forwarding_attempts
			 SET status = ?, attempt_count = ?, provider_id = COALESCE(?, provider_id), next_attempt_at = ?,
			     last_attempt_at = ?, error_code = ?, updated_at = ?
			 WHERE id = ?`
		)
		.bind(
			input.status,
			input.attemptCount,
			input.providerId ?? null,
			input.nextAttemptAt ?? null,
			now.toISOString(),
			input.errorCode ?? null,
			now.toISOString(),
			input.id
		)
		.run();

	const row = await db
		.prepare('SELECT * FROM forwarding_attempts WHERE id = ?')
		.bind(input.id)
		.first<AttemptRow>();
	return row ? mapAttempt(row) : null;
}

export async function getForwardingAttemptByProviderId(
	db: D1Database,
	providerId: string
): Promise<ForwardingAttempt | null> {
	const row = await db
		.prepare('SELECT * FROM forwarding_attempts WHERE provider_id = ?')
		.bind(providerId)
		.first<AttemptRow>();
	return row ? mapAttempt(row) : null;
}
