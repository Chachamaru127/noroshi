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
	readBoundedBody,
	readJsonBody
} from './request-security';

export async function readMailRequest<T extends { attachments?: OutboundAttachmentInput[] }>(
	request: Request
): Promise<T> {
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
		const body = await readJsonBody<T>(request, MAX_JSON_REQUEST_BYTES);
		validateMailPayloadObject(body);
		validateAttachmentMetadata(body, 'JSON attachments require multipart/form-data');
		validateMailRequestBody(body);
		return body;
	}
	const boundedBody = await readBoundedBody(request, MAX_MAIL_MULTIPART_BYTES);
	let form: FormData;
	try {
		form = await new Request(request, { body: boundedBody }).formData();
	} catch {
		throw new RequestBodyError('Invalid multipart body', 400);
	}
	const payload = form.get('payload');
	const maximumPayloadBytes = MAX_BODY_BYTES * 2 * 4 + 128 * 1024;
	if (
		typeof payload !== 'string' ||
		new TextEncoder().encode(payload).byteLength > maximumPayloadBytes
	)
		throw new RequestBodyError('Invalid mail payload', 400);
	let body: T;
	try {
		body = JSON.parse(payload) as T;
	} catch {
		throw new RequestBodyError('Invalid mail payload', 400);
	}
	validateMailPayloadObject(body);
	validateAttachmentMetadata(body, 'Attachment metadata must be omitted from multipart payload');
	validateMailRequestBody(body);
	const values = form.getAll('attachment');
	if (!values.every((value): value is File => value instanceof File))
		throw new RequestBodyError('Invalid attachment', 400);
	const files = values;
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

export function validateMailRequestBody(input: {
	text?: unknown;
	html?: unknown;
	attachments?: unknown;
}): void {
	for (const value of [input.text, input.html]) {
		if (value !== undefined && value !== null && typeof value !== 'string') {
			throw new RequestBodyError('Message body must be text', 400);
		}
		if (
			typeof value === 'string' &&
			(value.length > MAX_BODY_BYTES ||
				new TextEncoder().encode(value).byteLength > MAX_BODY_BYTES * 4)
		) {
			throw new RequestBodyError('Message body is too large', 413);
		}
	}
}

function validateAttachmentMetadata(input: { attachments?: unknown }, errorMessage: string): void {
	if (input.attachments === undefined) return;
	if (!Array.isArray(input.attachments)) {
		throw new RequestBodyError('Invalid attachments', 400);
	}
	if (input.attachments.length > 0) throw new RequestBodyError(errorMessage, 400);
}

function validateMailPayloadObject(input: unknown): asserts input is Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new RequestBodyError('Invalid mail payload', 400);
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}
