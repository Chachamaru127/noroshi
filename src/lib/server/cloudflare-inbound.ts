import type { R2Bucket } from '@cloudflare/workers-types';
import PostalMime, { type Address, type Attachment } from 'postal-mime';
import { insertAttachmentBytes } from './attachments';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_EMAIL } from './constants';
import { recordUnroutedEmail, resolveInboundRoute } from './domains';
import { collectInboundRecipients, parseEmailAddress } from './email-address';
import { parseMailDomains } from './email-provider';
import {
	emailExistsByProviderId,
	insertEmail,
	markInboundAttachmentsReady,
	ProviderDeliveryAlreadyClaimedError
} from './mail-store';
import { scheduleNewMailNotification, type PushNotificationEnv } from './push-notifications';
import { normalizeMessageId } from './send-mail';
import { enqueueAndScheduleForwarding, isForwardedHop } from './forwarding-delivery';

export type CloudflareInboundMessage = {
	readonly from: string;
	readonly to: string;
	readonly headers: Headers;
	readonly raw: ReadableStream<Uint8Array>;
	setReject(reason: string): void;
};

export type CloudflareInboundEnv = PushNotificationEnv & {
	ATTACHMENTS: R2Bucket;
	EMAIL_PROVIDER?: string;
	RESEND_API_KEY?: string;
	FORWARDING_KILL_SWITCH?: string;
	FORWARDING_LEASE_MS?: string;
};

export function isAllowedCloudflareRecipient(
	recipient: string,
	configuredDomains: string | undefined | null
): boolean {
	const address = parseEmailAddress(recipient);
	const separator = address.lastIndexOf('@');
	if (separator < 1) return false;
	const domain = address.slice(separator + 1).toLowerCase();
	return parseMailDomains(configuredDomains).includes(domain);
}

/**
 * Email Routing delivers the full MIME on `message.raw`. Parse once, then reuse
 * the same mailbox routing and D1/R2 store as the Resend webhook path.
 */
export async function handleCloudflareInbound(
	message: CloudflareInboundMessage,
	env: CloudflareInboundEnv
): Promise<void> {
	const raw = await new Response(message.raw).arrayBuffer();
	const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });

	const envelopeTo = parseEmailAddress(message.to);
	const recipients = envelopeTo.includes('@')
		? collectInboundRecipients({ received_for: [envelopeTo] })
		: [];

	const from = parseEmailAddress(message.from || mailboxAddresses(parsed.from)[0] || '');
	const subject = parsed.subject?.trim() || message.headers.get('subject')?.trim() || '(no subject)';
	const messageId =
		normalizeMessageId(parsed.messageId ?? message.headers.get('message-id')) ?? null;
	const inReplyTo =
		normalizeMessageId(parsed.inReplyTo ?? message.headers.get('in-reply-to')) ?? null;
	const references = parsed.references ?? message.headers.get('references') ?? null;
	const providerId = await cloudflareProviderId(raw, envelopeTo);

	if (await emailExistsByProviderId(env.DB, providerId, envelopeTo)) {
		return;
	}

	const route = await resolveInboundRoute(env.DB, recipients);

	if (!route) {
		await recordUnroutedEmail(env.DB, {
			providerId,
			from,
			to: recipients.join(', ') || envelopeTo || '(unknown)',
			subject,
			reason: 'No matching address and no catch-all for this domain'
		});
		return;
	}

	let emailId: string;
	try {
		emailId = await insertEmail(env.DB, {
			userId: route.userId,
			direction: 'inbound',
			from,
			to: route.address,
			cc: mailboxAddresses(parsed.cc).join(', ') || null,
			subject,
			bodyText: parsed.text ?? null,
			bodyHtml: parsed.html ?? null,
			messageId,
			inReplyTo,
			references,
			domainId: route.domainId,
			providerId,
			forwardingHop: isForwardedHop(parsed.headers) ? 1 : 0,
			attachmentsReady: parsed.attachments.length === 0
		});
	} catch (error) {
		if (error instanceof ProviderDeliveryAlreadyClaimedError) return;
		throw error;
	}

	const attachmentsReady = await storeInboundAttachments(env, emailId, parsed.attachments);
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
}

async function storeInboundAttachments(
	env: CloudflareInboundEnv,
	emailId: string,
	attachments: Attachment[]
): Promise<boolean> {
	let ready = true;
	for (const attachment of attachments.slice(0, MAX_ATTACHMENTS_PER_EMAIL)) {
		const bytes = attachmentBytes(attachment.content);
		if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
			ready = false;
			continue;
		}

		try {
			await insertAttachmentBytes(env.DB, env.ATTACHMENTS, emailId, {
				filename: attachment.filename || 'attachment',
				type: attachment.mimeType || 'application/octet-stream',
				bytes
			});
		} catch {
			ready = false;
			console.error('inbound_attachment_store_failed');
		}
	}
	if (attachments.length > MAX_ATTACHMENTS_PER_EMAIL) ready = false;
	return ready;
}

function mailboxAddresses(value: Address | Address[] | undefined): string[] {
	if (!value) return [];
	const list = Array.isArray(value) ? value : [value];
	const addresses: string[] = [];

	for (const item of list) {
		if (item.address) addresses.push(item.address);
		if (item.group) {
			for (const member of item.group) {
				if (member.address) addresses.push(member.address);
			}
		}
	}

	return addresses;
}

function attachmentBytes(content: Attachment['content']): Uint8Array | null {
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	if (ArrayBuffer.isView(content)) {
		return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	}
	if (typeof content === 'string' && content.length > 0) {
		return new TextEncoder().encode(content);
	}
	return null;
}

export async function cloudflareProviderId(raw: ArrayBuffer, _envelopeRecipient = ''): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', raw);
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `cf-${hex}`;
}
