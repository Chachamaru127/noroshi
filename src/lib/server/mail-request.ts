import type { OutboundAttachmentInput } from '$lib/types';
import {
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENTS_PER_EMAIL,
	MAX_BODY_BYTES,
	MAX_TOTAL_ATTACHMENT_BYTES
} from './constants';
import {
	MAX_JSON_REQUEST_BYTES,
	MAX_MAIL_MULTIPART_BYTES,
	RequestBodyError,
	readJsonBody,
	requireBoundedContentLength
} from './request-security';

export async function readMailRequest<T extends { attachments?: OutboundAttachmentInput[] }>(
	request: Request
): Promise<T> {
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data'))
		return readJsonBody<T>(request, MAX_JSON_REQUEST_BYTES);
	requireBoundedContentLength(request, MAX_MAIL_MULTIPART_BYTES);
	const form = await request.formData();
	const payload = form.get('payload');
	const maximumPayloadCharacters = MAX_BODY_BYTES * 2 + 128 * 1024;
	if (typeof payload !== 'string' || payload.length > maximumPayloadCharacters)
		throw new RequestBodyError('Invalid mail payload', 400);
	let body: T;
	try {
		body = JSON.parse(payload) as T;
	} catch {
		throw new RequestBodyError('Invalid mail payload', 400);
	}
	const files = form.getAll('attachment').filter((value): value is File => value instanceof File);
	if (files.length > MAX_ATTACHMENTS_PER_EMAIL)
		throw new RequestBodyError('Too many attachments', 413);
	let total = 0;
	const attachments: OutboundAttachmentInput[] = [];
	for (const file of files) {
		if (file.size > MAX_ATTACHMENT_BYTES)
			throw new RequestBodyError('Attachment is too large', 413);
		total += file.size;
		if (total > MAX_TOTAL_ATTACHMENT_BYTES)
			throw new RequestBodyError('Attachments are too large', 413);
		attachments.push({
			filename: file.name,
			type: file.type || 'application/octet-stream',
			content: bytesToBase64(new Uint8Array(await file.arrayBuffer()))
		});
	}
	body.attachments = attachments;
	return body;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}
