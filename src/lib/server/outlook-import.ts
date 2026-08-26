import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import PostalMime, { type Address, type Attachment } from 'postal-mime';
import { insertHistoricalAttachmentBytes } from './attachments';
import { deleteEmailsPermanently, insertEmail } from './mail-store';
import { normalizeMessageId } from './send-mail';

export const OUTLOOK_IMPORT_PREFIX = 'outlook-import-v1-';
export const MAX_HISTORICAL_EML_BYTES = 50 * 1024 * 1024;

export type OutlookImportDirection = 'inbound' | 'outbound';

export type OutlookImportResult = {
	imported: boolean;
	emailId: string;
	attachments: number;
};

export async function importOutlookEml(
	env: { DB: D1Database; ATTACHMENTS: R2Bucket },
	input: {
		userId: string;
		domainId: string;
		mailboxAddress: string;
		direction: OutlookImportDirection;
		raw: ArrayBuffer;
	}
): Promise<OutlookImportResult> {
	if (input.raw.byteLength === 0 || input.raw.byteLength > MAX_HISTORICAL_EML_BYTES) {
		throw new Error('EML size is outside the historical import limit');
	}

	const providerId = `${OUTLOOK_IMPORT_PREFIX}${await sha256Hex(input.raw)}`;
	const existing = await env.DB.prepare(
		'SELECT id, attachments_ready FROM emails WHERE user_id = ? AND provider_id = ? LIMIT 1'
	)
		.bind(input.userId, providerId)
		.first<{ id: string; attachments_ready: number }>();

	if (existing?.attachments_ready === 1) {
		const count = await attachmentCount(env.DB, existing.id);
		return { imported: false, emailId: existing.id, attachments: count };
	}
	if (existing) {
		await deleteEmailsPermanently(env.DB, env.ATTACHMENTS, input.userId, [existing.id]);
	}

	const parsed = await PostalMime.parse(input.raw, { attachmentEncoding: 'arraybuffer' });
	const parsedFrom = mailboxAddresses(parsed.from);
	const parsedTo = mailboxAddresses(parsed.to);
	const from =
		parsedFrom.join(', ') || (input.direction === 'outbound' ? input.mailboxAddress : '(unknown)');
	const to =
		parsedTo.join(', ') || (input.direction === 'inbound' ? input.mailboxAddress : '(unknown)');
	const createdAt = validDate(parsed.date) ?? new Date();
	let emailId: string | null = null;

	try {
		emailId = await insertEmail(env.DB, {
			userId: input.userId,
			direction: input.direction,
			from,
			to,
			cc: mailboxAddresses(parsed.cc).join(', ') || null,
			bcc: mailboxAddresses(parsed.bcc).join(', ') || null,
			subject: parsed.subject?.trim() || '(no subject)',
			bodyText: parsed.text ?? null,
			bodyHtml: parsed.html ?? null,
			messageId: normalizeMessageId(parsed.messageId),
			inReplyTo: normalizeMessageId(parsed.inReplyTo),
			references: parsed.references ?? null,
			domainId: input.domainId,
			status: input.direction === 'outbound' ? 'sent' : null,
			attachmentsReady: parsed.attachments.length === 0,
			isRead: true,
			createdAt,
			preserveBody: true
		});

		for (const attachment of parsed.attachments) {
			await insertHistoricalAttachmentBytes(env.DB, env.ATTACHMENTS, emailId, {
				filename: attachment.filename || 'attachment',
				type: attachment.mimeType || 'application/octet-stream',
				bytes: attachmentBytes(attachment.content)
			});
		}

		await env.DB.prepare(
			'UPDATE emails SET provider_id = ?, attachments_ready = 1 WHERE id = ? AND user_id = ?'
		)
			.bind(providerId, emailId, input.userId)
			.run();

		return { imported: true, emailId, attachments: parsed.attachments.length };
	} catch (error) {
		if (emailId) {
			await deleteEmailsPermanently(env.DB, env.ATTACHMENTS, input.userId, [emailId]).catch(
				() => undefined
			);
		}
		throw error;
	}
}

async function attachmentCount(db: D1Database, emailId: string): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS count FROM email_attachments WHERE email_id = ?')
		.bind(emailId)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

function mailboxAddresses(value: Address | Address[] | undefined): string[] {
	if (!value) return [];
	const list = Array.isArray(value) ? value : [value];
	const addresses: string[] = [];
	for (const item of list) {
		if (item.address) addresses.push(item.address);
		for (const member of item.group ?? []) if (member.address) addresses.push(member.address);
	}
	return addresses;
}

function attachmentBytes(content: Attachment['content']): Uint8Array {
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	if (ArrayBuffer.isView(content)) {
		return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	}
	if (typeof content === 'string') return new TextEncoder().encode(content);
	return new Uint8Array();
}

function validDate(value: string | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', value);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
