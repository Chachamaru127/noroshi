import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import {
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENTS_PER_EMAIL,
	MAX_TOTAL_ATTACHMENT_BYTES
} from '$lib/constants';
import type { EmailAttachmentMeta, EmailRow, OutboundAttachmentInput } from '$lib/types';
import { base64ByteLength, getAttachmentForUser, readAttachmentBytes } from './attachments';
import { stripHtml } from './html';
import { getEmailForUser } from './mail-store';
import { escapeHtml } from './send-mail';

export type ManualForwardDraft = {
	id: string;
	subject: string;
	text: string;
	html: string;
	attachments: EmailAttachmentMeta[];
};

export class ManualForwardError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'ManualForwardError';
	}
}

function headerValue(value: string): string {
	const [firstLine = ''] = value.split(/[\r\n]/, 1);
	return firstLine
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function forwardSubject(subject: string): string {
	const value = headerValue(subject) || '（件名なし）';
	return `Fwd: ${value}`;
}

function forwardDate(value: string): string {
	const trimmed = value.trim();
	const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
		? `${trimmed.replace(' ', 'T')}Z`
		: trimmed;
	const date = new Date(normalized);
	return Number.isNaN(date.getTime()) ? headerValue(value) : date.toUTCString();
}

function messageText(email: EmailRow): string {
	const text = email.body_text?.trim() || (email.body_html ? stripHtml(email.body_html) : '');
	return text || '（本文なし）';
}

/** Build a browser-safe editable quote without copying inbound HTML or headers. */
export function buildManualForwardDraft(
	email: EmailRow,
	attachments: EmailAttachmentMeta[]
): ManualForwardDraft {
	const subject = forwardSubject(email.subject);
	const text = `\n\n---------- 転送メッセージ ----------
差出人: ${headerValue(email.from_addr)}
日付: ${forwardDate(email.created_at)}
件名: ${headerValue(email.subject) || '（件名なし）'}
宛先: ${headerValue(email.to_addr)}

${messageText(email)}`;

	return {
		id: email.id,
		subject,
		text,
		html: escapeHtml(text).replaceAll('\n', '<br>\n'),
		attachments
	};
}

function safeFilename(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]+/g, '').trim() || 'attachment';
}

function safeContentType(value: string): string {
	const type = value.replace(/[\u0000-\u001f\u007f]+/g, '').trim();
	return type.includes('/') ? type : 'application/octet-stream';
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

function validateUploadedAttachments(attachments: OutboundAttachmentInput[]): number {
	let total = 0;
	for (const attachment of attachments) {
		if (
			!attachment ||
			typeof attachment !== 'object' ||
			typeof attachment.filename !== 'string' ||
			typeof attachment.type !== 'string'
		) {
			throw new ManualForwardError('Invalid attachment content', 400);
		}
		const content = attachment.content;
		if (typeof content !== 'string') {
			throw new ManualForwardError('Invalid attachment content', 400);
		}

		const maxEncodedLength = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
		if (content.length > maxEncodedLength) {
			throw new ManualForwardError('An attachment exceeds the size limit', 400);
		}
		if (
			content.length % 4 !== 0 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
		) {
			throw new ManualForwardError('Invalid attachment content', 400);
		}

		const decodedLength = base64ByteLength(content);
		if (decodedLength > MAX_ATTACHMENT_BYTES) {
			throw new ManualForwardError('An attachment exceeds the size limit', 400);
		}
		total += decodedLength;
		if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
			throw new ManualForwardError('Attachments exceed the total size limit', 400);
		}
	}
	return total;
}

/** Re-read selected originals under the current owner and email before sending. */
export async function materializeManualForwardAttachments(
	db: D1Database,
	bucket: R2Bucket,
	userId: string,
	emailId: string,
	attachmentIds: string[],
	uploaded: OutboundAttachmentInput[]
): Promise<OutboundAttachmentInput[]> {
	if (attachmentIds.length + uploaded.length > MAX_ATTACHMENTS_PER_EMAIL) {
		throw new ManualForwardError(`Maximum ${MAX_ATTACHMENTS_PER_EMAIL} attachments allowed`, 400);
	}

	const uniqueIds = new Set(attachmentIds);
	if (uniqueIds.size !== attachmentIds.length || attachmentIds.some((id) => !id.trim())) {
		throw new ManualForwardError('Invalid forwarded attachment selection', 400);
	}

	let totalBytes = validateUploadedAttachments(uploaded);
	const forwarded: OutboundAttachmentInput[] = [];

	for (const attachmentId of attachmentIds) {
		const attachment = await getAttachmentForUser(db, userId, emailId, attachmentId);
		if (!attachment) {
			throw new ManualForwardError('Forward source not found', 404);
		}

		const bytes = await readAttachmentBytes(bucket, attachment);
		if (!bytes) {
			throw new ManualForwardError('A forwarded attachment is unavailable', 409);
		}
		if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
			throw new ManualForwardError('An attachment exceeds the size limit', 400);
		}

		totalBytes += bytes.byteLength;
		if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
			throw new ManualForwardError('Attachments exceed the total size limit', 400);
		}

		forwarded.push({
			filename: safeFilename(attachment.filename),
			type: safeContentType(attachment.content_type),
			content: bytesToBase64(bytes)
		});
	}

	if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
		throw new ManualForwardError('Attachments exceed the total size limit', 400);
	}

	return [...uploaded, ...forwarded];
}

/** Authorize the selected source again at send time, then materialize its selected files. */
export async function prepareManualForward(
	db: D1Database,
	bucket: R2Bucket,
	userId: string,
	emailId: string,
	attachmentIds: string[],
	uploaded: OutboundAttachmentInput[]
): Promise<{ source: EmailRow; attachments: OutboundAttachmentInput[] }> {
	const source = await getEmailForUser(db, userId, emailId);
	if (!source) {
		throw new ManualForwardError('Forward source not found', 404);
	}

	return {
		source,
		attachments: await materializeManualForwardAttachments(
			db,
			bucket,
			userId,
			source.id,
			attachmentIds,
			uploaded
		)
	};
}
