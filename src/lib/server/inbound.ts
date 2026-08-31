import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { DeliveryStatus } from '$lib/types';
import { insertAttachmentBytes } from './attachments';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_EMAIL, MAX_BODY_BYTES } from './constants';
import { collectInboundRecipients, parseEmailAddress } from './email-address';
import { recordUnroutedEmail, resolveInboundRoute } from './domains';
import {
	emailExistsByProviderId,
	insertEmail,
	markInboundAttachmentsReady,
	ProviderDeliveryAlreadyClaimedError,
	updateEmailStatusByProviderId
} from './mail-store';
import { scheduleNewMailNotification, type PushNotificationEnv } from './push-notifications';
import type { ResendClient } from './resend';
import { enqueueAndScheduleForwarding, isForwardedHop } from './forwarding-delivery';

export type ResendWebhookEvent = {
	type: string;
	created_at?: string;
	data?: Record<string, unknown>;
};

export type WebhookOutcome = {
	handled: boolean;
	note: string;
};

export type InboundEnv = PushNotificationEnv & {
	ATTACHMENTS: R2Bucket;
	EMAIL_PROVIDER?: string;
	RESEND_API_KEY?: string;
	RESEND_SEND_DOMAINS?: string;
	/** Local-only loopback FakeProvider seam; omit in production. */
	QMJ_FAKE_RESEND_ORIGIN?: string;
	FORWARDING_KILL_SWITCH?: string;
	FORWARDING_LEASE_MS?: string;
};

export function createResendWebhookInboundEnv(platform: App.Platform): InboundEnv {
	return {
		DB: platform.env.DB,
		ATTACHMENTS: platform.env.ATTACHMENTS,
		EMAIL_PROVIDER: platform.env.EMAIL_PROVIDER,
		RESEND_API_KEY: platform.env.RESEND_API_KEY,
		RESEND_SEND_DOMAINS: platform.env.RESEND_SEND_DOMAINS,
		QMJ_FAKE_RESEND_ORIGIN: platform.env.QMJ_FAKE_RESEND_ORIGIN,
		FORWARDING_KILL_SWITCH: platform.env.FORWARDING_KILL_SWITCH,
		FORWARDING_LEASE_MS: platform.env.FORWARDING_LEASE_MS,
		VAPID_PUBLIC_KEY: platform.env.VAPID_PUBLIC_KEY,
		VAPID_PRIVATE_KEY: platform.env.VAPID_PRIVATE_KEY,
		VAPID_SUBJECT: platform.env.VAPID_SUBJECT,
		waitUntil: (promise) => platform.ctx.waitUntil(promise)
	};
}

/** Resend delivery events → the status we display on a sent message. */
const STATUS_BY_EVENT: Record<string, DeliveryStatus> = {
	'email.sent': 'sent',
	'email.delivered': 'delivered',
	'email.delivery_delayed': 'delayed',
	'email.bounced': 'bounced',
	'email.complained': 'complained',
	'email.failed': 'failed'
};

export async function handleResendWebhook(
	event: ResendWebhookEvent,
	env: InboundEnv,
	client: ResendClient
): Promise<WebhookOutcome> {
	if (event.type === 'email.received') {
		return handleInboundEmail(event, env, client);
	}

	const status = STATUS_BY_EVENT[event.type];
	if (status) {
		return handleDeliveryStatus(event, env.DB, status);
	}

	return { handled: false, note: `Ignored event type ${event.type}` };
}

async function handleDeliveryStatus(
	event: ResendWebhookEvent,
	db: D1Database,
	status: DeliveryStatus
): Promise<WebhookOutcome> {
	const providerId = readString(event.data?.email_id);
	if (!providerId) {
		return { handled: false, note: 'Delivery event without email_id' };
	}

	const detail =
		readString((event.data?.bounce as Record<string, unknown> | undefined)?.message) ??
		readString((event.data?.bounce as Record<string, unknown> | undefined)?.subType) ??
		readString(event.data?.reason) ??
		null;

	await updateEmailStatusByProviderId(db, providerId, status, detail);
	return { handled: true, note: `Marked ${providerId} as ${status}` };
}

async function handleInboundEmail(
	event: ResendWebhookEvent,
	env: InboundEnv,
	client: ResendClient
): Promise<WebhookOutcome> {
	const providerId = readString(event.data?.email_id);
	if (!providerId) {
		return { handled: false, note: 'email.received without email_id' };
	}

	// Webhooks carry metadata only — the body and attachments come from the API.
	let received = await client.getReceivedEmail(providerId, 'data_uri');

	// Inline images inflate data-URI HTML past what we store; fall back to `cid`
	// so the body stays intact and the images remain as attachments.
	if ((received.html?.length ?? 0) > MAX_BODY_BYTES) {
		received = await client.getReceivedEmail(providerId, 'cid');
	}

	const recipients = collectInboundRecipients({
		received_for: (event.data?.received_for as string[] | undefined) ?? received.received_for,
		to: received.to,
		cc: received.cc,
		bcc: received.bcc
	});

	const from = parseEmailAddress(received.from ?? '');
	const subject = received.subject?.trim() || '(no subject)';
	const route = await resolveInboundRoute(env.DB, recipients);

	if (!route) {
		await recordUnroutedEmail(env.DB, {
			providerId,
			from,
			to: recipients.join(', ') || '(unknown)',
			subject,
			reason: 'No matching address and no catch-all for this domain'
		});
		return { handled: true, note: `Stored ${providerId} as unrouted` };
	}
	if (await emailExistsByProviderId(env.DB, providerId, route.address)) {
		return { handled: true, note: `Already stored ${providerId}` };
	}

	let emailId: string;
	try {
		emailId = await insertEmail(env.DB, {
			userId: route.userId,
			direction: 'inbound',
			from,
			to: route.address,
			cc: received.cc?.join(', ') || null,
			subject,
			bodyText: received.text,
			bodyHtml: received.html,
			messageId: received.message_id ?? null,
			inReplyTo: received.headers?.['in-reply-to'] ?? null,
			// The whole chain, not just the direct parent: a reply to something we
			// sent references a Message-ID Resend never handed back to us, but the
			// chain still carries the message that started the conversation.
			references: received.headers?.['references'] ?? null,
			domainId: route.domainId,
			addressId: route.addressId,
			providerId,
			forwardingHop: isForwardedHop(received.headers) ? 1 : 0,
			attachmentsReady: false
		});
	} catch (error) {
		if (error instanceof ProviderDeliveryAlreadyClaimedError) {
			return { handled: true, note: `Already stored ${providerId}` };
		}
		throw error;
	}

	const attachmentsReady = await storeInboundAttachments(env, client, providerId, emailId);
	if (attachmentsReady) await markInboundAttachmentsReady(env.DB, emailId);
	if (attachmentsReady && route.addressId) {
		await enqueueAndScheduleForwarding(env, {
			userId: route.userId,
			sourceAddressId: route.addressId,
			emailId
		});
	}
	await scheduleNewMailNotification(env, {
		emailId,
		userId: route.userId,
		from,
		subject
	});

	return {
		handled: true,
		note: `Delivered ${providerId} to ${route.address}${route.viaCatchall ? ' (catch-all)' : ''}`
	};
}

async function storeInboundAttachments(
	env: InboundEnv,
	client: ResendClient,
	providerId: string,
	emailId: string
): Promise<boolean> {
	let attachments;
	try {
		attachments = await client.listReceivedAttachments(providerId);
	} catch {
		console.error('inbound_attachment_list_failed');
		return false;
	}

	let ready = true;
	for (const attachment of attachments.slice(0, MAX_ATTACHMENTS_PER_EMAIL)) {
		if (!attachment.download_url) {
			ready = false;
			continue;
		}
		if (attachment.size && attachment.size > MAX_ATTACHMENT_BYTES) {
			console.warn('inbound_attachment_oversized');
			ready = false;
			continue;
		}

		try {
			const bytes = await client.downloadAttachment(attachment.download_url);
			if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
				ready = false;
				continue;
			}

			await insertAttachmentBytes(env.DB, env.ATTACHMENTS, emailId, {
				filename: attachment.filename || 'attachment',
				type: attachment.content_type || 'application/octet-stream',
				bytes
			});
		} catch {
			ready = false;
			// One bad attachment shouldn't cost us the message.
			console.error('inbound_attachment_store_failed');
		}
	}
	if (attachments.length > MAX_ATTACHMENTS_PER_EMAIL) ready = false;
	return ready;
}

/** Resend retries on non-2xx, so record ids we've already processed. */
export async function claimWebhookEvent(
	db: D1Database,
	eventId: string,
	type: string
): Promise<boolean> {
	const result = await db
		.prepare('INSERT OR IGNORE INTO webhook_events (id, type) VALUES (?, ?)')
		.bind(eventId, type)
		.run();

	return (result.meta?.changes ?? 0) > 0;
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}
