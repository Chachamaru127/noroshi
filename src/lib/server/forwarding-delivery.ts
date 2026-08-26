import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { MailAddress, OutboundAttachmentInput } from '$lib/types';
import { listAttachmentsForUser, readAttachmentBytes } from './attachments';
import { parseEmailAddress } from './email-address';
import { ProviderError, type EmailProvider } from './email-provider';
import {
	claimForwardingAttempt,
	createForwardingAttempt,
	finishForwardingAttempt,
	listDueForwardingAttempts,
	terminalizeExhaustedForwardingAttempts,
	type ForwardingAttempt
} from './forwarding';
import { createResendProvider } from './providers/resend-provider';
import type { OutboundMailInput } from './send-mail';
import { stripHtml } from './html';

export const MAX_FORWARDING_CLAIMS = 4;
export const FORWARDING_HOP_LIMIT = 1;
export const DEFAULT_FORWARDING_LEASE_MS = 5 * 60 * 1000;

export type ForwardingDeliveryEnv = {
	DB: D1Database;
	ATTACHMENTS: R2Bucket;
	EMAIL_PROVIDER?: string;
	RESEND_API_KEY?: string;
	FORWARDING_KILL_SWITCH?: string;
	FORWARDING_LEASE_MS?: string;
	waitUntil?: (promise: Promise<void>) => void;
};

export type ForwardingOriginal = {
	from: string;
	to: string;
	subject: string;
	bodyText?: string | null;
	bodyHtml?: string | null;
	createdAt: string;
};

export type ForwardingPayloadInput = {
	ruleId: string;
	emailId: string;
	source: MailAddress;
	destination: string;
	original: ForwardingOriginal;
	attachments?: OutboundAttachmentInput[];
};

function sanitizeHeader(value: string | null | undefined): string {
	return (value ?? '')
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function sanitizeBody(value: string | null | undefined): string {
	return (value ?? '').replace(/\u0000/g, '').trim();
}

export function forwardingIdempotencyKey(ruleId: string, emailId: string): string {
	return `quickmail-forward:${ruleId}:${emailId}`;
}

export function buildForwardingPayload(input: ForwardingPayloadInput): OutboundMailInput {
	const subject = sanitizeHeader(input.original.subject) || '(no subject)';
	const bodyText =
		input.original.bodyText?.trim() ||
		(input.original.bodyHtml ? stripHtml(input.original.bodyHtml) : '');
	return {
		from: input.source,
		senderName: input.source.label?.trim() || input.source.address,
		to: [input.destination],
		replyTo: parseEmailAddress(input.original.from),
		subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
		text: [
			'---------- Forwarded message ----------',
			`From: ${sanitizeHeader(parseEmailAddress(input.original.from))}`,
			`To: ${sanitizeHeader(input.original.to)}`,
			`Date: ${sanitizeHeader(input.original.createdAt)}`,
			`Subject: ${subject}`,
			'',
			sanitizeBody(bodyText)
		]
			.join('\n')
			.trim(),
		headers: { 'X-QuickMail-Forwarded': '1' },
		attachments: input.attachments,
		idempotencyKey: forwardingIdempotencyKey(input.ruleId, input.emailId)
	};
}

export function isForwardedHop(headers: unknown): boolean {
	if (!headers) return false;
	let value: unknown;
	if (headers instanceof Headers) value = headers.get('X-QuickMail-Forwarded');
	else if (Array.isArray(headers)) {
		const match = headers.find(
			(item) =>
				item &&
				typeof item === 'object' &&
				'key' in item &&
				typeof item.key === 'string' &&
				item.key.toLowerCase() === 'x-quickmail-forwarded'
		);
		value = match && typeof match === 'object' && 'value' in match ? match.value : undefined;
	} else if (typeof headers === 'object') {
		value = Object.entries(headers as Record<string, unknown>).find(
			([key]) => key.toLowerCase() === 'x-quickmail-forwarded'
		)?.[1];
	}
	return typeof value === 'string' && value.trim() === '1';
}

export function nextForwardingRetryAt(claimCount: number, now = new Date()): Date | null {
	if (claimCount >= MAX_FORWARDING_CLAIMS) return null;
	const minutes = claimCount === 1 ? 1 : claimCount === 2 ? 5 : 15;
	return new Date(now.getTime() + minutes * 60 * 1000);
}

function forwardingEnabled(env: ForwardingDeliveryEnv): boolean {
	return !['1', 'true', 'on', 'yes', 'disabled'].includes(
		env.FORWARDING_KILL_SWITCH?.trim().toLowerCase() ?? ''
	);
}

function leaseMs(value: string | undefined): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 30_000 ? parsed : DEFAULT_FORWARDING_LEASE_MS;
}

function errorCode(error: unknown): string {
	if (error instanceof ProviderError) {
		return (
			error.code
				.toLowerCase()
				.replace(/[^a-z0-9_-]+/g, '_')
				.slice(0, 64) || 'provider_error'
		);
	}
	if (error instanceof Error) {
		return (
			error.message
				.toLowerCase()
				.replace(/[^a-z0-9_-]+/g, '_')
				.slice(0, 64) || 'delivery_error'
		);
	}
	return 'delivery_error';
}

function retryable(error: unknown): boolean {
	return (
		!(error instanceof ProviderError) ||
		error.status >= 500 ||
		error.status === 408 ||
		error.status === 429
	);
}

type StoredJob = {
	id: string;
	rule_id: string;
	email_id: string;
	user_id: string;
	source_address_id: string;
	source_address: string;
	source_label: string | null;
	destination_address: string;
	hop: number;
	attachments_ready: number;
	from_addr: string;
	to_addr: string;
	subject: string;
	body_text: string | null;
	body_html: string | null;
	created_at: string;
};

async function getCurrentStoredJob(db: D1Database, attemptId: string): Promise<StoredJob | null> {
	return db
		.prepare(
			`SELECT fa.id, fa.rule_id, fa.email_id, r.user_id, r.source_address_id,
			        a.address AS source_address, a.label AS source_label,
			        d.destination_address, fa.hop, e.attachments_ready,
			        e.from_addr, e.to_addr, e.subject, e.body_text, e.body_html, e.created_at
			 FROM forwarding_attempts fa
			 JOIN forwarding_rules r
			   ON r.id = fa.rule_id AND r.status = 'enabled' AND r.destination_id = fa.destination_id
			  AND r.enabled_at IS NOT NULL
			 JOIN forwarding_destinations d
			   ON d.id = fa.destination_id AND d.user_id = r.user_id AND d.status = 'verified'
			  AND lower(d.destination_address) = lower(fa.destination_address)
			 JOIN addresses a ON a.id = r.source_address_id AND a.user_id = r.user_id
			 JOIN emails e
			   ON e.id = fa.email_id AND e.user_id = r.user_id AND e.direction = 'inbound'
			 WHERE fa.id = ? AND fa.hop = 0 AND e.forwarding_hop = 0
			   AND julianday(e.created_at) >= julianday(r.enabled_at)
			   AND lower(e.to_addr) = lower(a.address)`
		)
		.bind(attemptId)
		.first<StoredJob>();
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function loadAttachments(
	db: D1Database,
	bucket: R2Bucket,
	userId: string,
	emailId: string
): Promise<OutboundAttachmentInput[]> {
	const rows = await listAttachmentsForUser(db, userId, emailId);
	const output: OutboundAttachmentInput[] = [];
	for (const row of rows) {
		const bytes = await readAttachmentBytes(bucket, row);
		if (!bytes) throw new Error('attachment_unavailable');
		output.push({ filename: row.filename, type: row.content_type, content: bytesToBase64(bytes) });
	}
	return output;
}

export async function enqueueForwardingForStoredEmail(
	env: Pick<ForwardingDeliveryEnv, 'DB'>,
	input: { userId: string; sourceAddressId: string; emailId: string; now?: Date }
): Promise<ForwardingAttempt | null> {
	try {
		const row = await env.DB.prepare(
			`SELECT r.id AS rule_id
				 FROM forwarding_rules r
				 JOIN forwarding_destinations d
				   ON d.id = r.destination_id AND d.user_id = r.user_id AND d.status = 'verified'
				 JOIN addresses a ON a.id = r.source_address_id AND a.user_id = r.user_id
				 JOIN emails e
				   ON e.id = ? AND e.user_id = r.user_id AND e.direction = 'inbound'
				 WHERE r.user_id = ? AND r.source_address_id = ? AND r.status = 'enabled'
				   AND r.enabled_at IS NOT NULL AND e.attachments_ready = 1
				   AND julianday(e.created_at) >= julianday(r.enabled_at)
				   AND e.forwarding_hop = 0 AND lower(e.to_addr) = lower(a.address)`
		)
			.bind(input.emailId, input.userId, input.sourceAddressId)
			.first<{ rule_id: string }>();
		if (!row) return null;
		return createForwardingAttempt(env.DB, {
			ruleId: row.rule_id,
			emailId: input.emailId,
			now: input.now
		});
	} catch (error) {
		console.error('Automatic forwarding enqueue failed', errorCode(error));
		return null;
	}
}

/** Recover saved inbound mail when storage committed but enqueue was interrupted. */
export async function reconcileSavedForwardingEmails(
	db: D1Database,
	now = new Date()
): Promise<number> {
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO forwarding_attempts
			 (id, rule_id, email_id, status, attempt_count, next_attempt_at, hop,
			  destination_id, destination_address, created_at, updated_at)
			 SELECT lower(hex(randomblob(16))), r.id, e.id, 'queued', 0, ?, 0,
			        r.destination_id, d.destination_address, ?, ?
			 FROM emails e
			 JOIN addresses a ON a.user_id = e.user_id AND lower(a.address) = lower(e.to_addr)
			 JOIN forwarding_rules r ON r.user_id = e.user_id AND r.source_address_id = a.id
			 JOIN forwarding_destinations d ON d.id = r.destination_id AND d.user_id = r.user_id
			 WHERE e.direction = 'inbound' AND e.forwarding_hop = 0
			   AND e.attachments_ready = 1
			   AND r.status = 'enabled' AND r.enabled_at IS NOT NULL
			   AND julianday(e.created_at) >= julianday(r.enabled_at)
			   AND d.status = 'verified'`
		)
		.bind(now.toISOString(), now.toISOString(), now.toISOString())
		.run();
	return result.meta.changes ?? 0;
}

export async function deliverForwardingAttempt(
	env: ForwardingDeliveryEnv,
	provider: EmailProvider,
	attemptId: string,
	now = new Date()
): Promise<ForwardingAttempt | null> {
	if (!forwardingEnabled(env) || provider.kind !== 'resend') return null;
	const claim = await claimForwardingAttempt(env.DB, {
		id: attemptId,
		now,
		leaseMs: leaseMs(env.FORWARDING_LEASE_MS)
	});
	if (!claim) return null;

	let job = await getCurrentStoredJob(env.DB, attemptId);
	if (!job || job.hop >= FORWARDING_HOP_LIMIT) {
		return await finishForwardingAttempt(env.DB, {
			id: attemptId,
			leaseToken: claim.lease_token,
			status: 'failed',
			errorCode: 'stale_rule',
			now
		});
	}
	try {
		if (job.attachments_ready !== 1) throw new Error('attachments_not_ready');
		const attachments = await loadAttachments(env.DB, env.ATTACHMENTS, job.user_id, job.email_id);
		// The user can disable or replace the destination while R2 is loading.
		job = await getCurrentStoredJob(env.DB, attemptId);
		if (!job || job.attachments_ready !== 1) {
			return await finishForwardingAttempt(env.DB, {
				id: attemptId,
				leaseToken: claim.lease_token,
				status: 'failed',
				errorCode: 'stale_rule',
				now
			});
		}

		const result = await provider.send(
			buildForwardingPayload({
				ruleId: job.rule_id,
				emailId: job.email_id,
				source: {
					id: job.source_address_id,
					user_id: job.user_id,
					domain_id: '',
					domain_name: job.source_address.slice(job.source_address.lastIndexOf('@') + 1),
					address: job.source_address,
					label: job.source_label,
					is_default: false,
					signature: null,
					created_at: now.toISOString()
				},
				destination: job.destination_address,
				original: {
					from: job.from_addr,
					to: job.to_addr,
					subject: job.subject,
					bodyText: job.body_text,
					bodyHtml: job.body_html,
					createdAt: job.created_at
				},
				attachments
			})
		);
		return await finishForwardingAttempt(env.DB, {
			id: attemptId,
			leaseToken: claim.lease_token,
			status: 'sent',
			providerId: result.providerId,
			now
		});
	} catch (error) {
		const retryAt = retryable(error) ? nextForwardingRetryAt(claim.attempt_count, now) : null;
		const code = errorCode(error);
		const finished = await finishForwardingAttempt(env.DB, {
			id: attemptId,
			leaseToken: claim.lease_token,
			status: 'failed',
			nextAttemptAt: retryAt?.toISOString() ?? null,
			errorCode: code,
			now
		});
		return finished;
	}
}

export async function enqueueAndScheduleForwarding(
	env: ForwardingDeliveryEnv,
	input: { userId: string; sourceAddressId: string; emailId: string; now?: Date }
): Promise<ForwardingAttempt | null> {
	const attempt = await enqueueForwardingForStoredEmail(env, input);
	if (!attempt || !forwardingEnabled(env)) return attempt;
	if ((env.EMAIL_PROVIDER ?? 'resend').trim().toLowerCase() !== 'resend' || !env.RESEND_API_KEY) {
		return attempt;
	}
	try {
		const work = deliverForwardingAttempt(
			env,
			createResendProvider(env.RESEND_API_KEY),
			attempt.id,
			input.now ?? new Date()
		);
		if (env.waitUntil) {
			env.waitUntil(work.then(() => undefined).catch(() => undefined));
			return attempt;
		}
		return await work;
	} catch (error) {
		console.error('Automatic forwarding scheduling failed', errorCode(error));
		return attempt;
	}
}

export async function runScheduledForwarding(
	env: ForwardingDeliveryEnv,
	now = new Date(),
	clock: () => Date = () => new Date()
): Promise<{ processed: number; skipped: boolean }> {
	await terminalizeExhaustedForwardingAttempts(env.DB, clock());
	if (!forwardingEnabled(env)) return { processed: 0, skipped: true };
	if ((env.EMAIL_PROVIDER ?? 'resend').trim().toLowerCase() !== 'resend' || !env.RESEND_API_KEY) {
		return { processed: 0, skipped: true };
	}
	await reconcileSavedForwardingEmails(env.DB, now);
	const provider = createResendProvider(env.RESEND_API_KEY);
	const due = await listDueForwardingAttempts(env.DB, now);
	let processed = 0;
	for (const attempt of due) {
		try {
			await deliverForwardingAttempt(env, provider, attempt.id, clock());
		} catch (error) {
			console.error('Scheduled forwarding failed', errorCode(error));
		}
		processed += 1;
	}
	return { processed, skipped: false };
}
