import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isPreviewableInline, mailMultipartBody, remainingAttachmentSlots } from './attachments';
import { readMailRequest } from '$lib/server/mail-request';
import type { OutboundAttachmentInput } from '$lib/types';

test('counts forwarded and newly uploaded files against one attachment limit', () => {
	assert.equal(remainingAttachmentSlots(0, 5), 0);
	assert.equal(remainingAttachmentSlots(0, 4), 1);
	assert.equal(remainingAttachmentSlots(1, 4), 0);
	assert.equal(remainingAttachmentSlots(0, 3), 2);
});

test('only safe raster images are previewed inline', () => {
	assert.equal(isPreviewableInline('image/png'), true);
	assert.equal(isPreviewableInline('image/jpeg; charset=binary'), true);
	assert.equal(isPreviewableInline('image/svg+xml'), false);
	assert.equal(isPreviewableInline('text/html'), false);
	assert.equal(isPreviewableInline('application/pdf'), false);
});

test('moves attachment bytes out of the JSON payload into multipart files', async () => {
	const form = mailMultipartBody({ subject: 'hello' }, [
		{ filename: 'a.txt', type: 'text/plain', content: btoa('hello') }
	]);
	assert.equal(form.get('payload'), JSON.stringify({ subject: 'hello' }));
	const file = form.get('attachment') as File;
	assert.equal(file.name, 'a.txt');
	assert.equal(await file.text(), 'hello');
});

test('accepts browser multipart requests when Content-Length is omitted', async () => {
	const form = mailMultipartBody({ subject: 'browser upload' }, [
		{ filename: 'a.txt', type: 'text/plain', content: btoa('hello') }
	]);
	const request = new Request('https://mail.example/api/mail', {
		method: 'POST',
		body: form
	});
	assert.equal(request.headers.has('content-length'), false);
	const parsed = await readMailRequest<{
		subject: string;
		attachments?: OutboundAttachmentInput[];
	}>(request);
	assert.equal(parsed.subject, 'browser upload');
	assert.equal(parsed.attachments?.[0]?.content, btoa('hello'));
});

test('does not silently replace multipart attachment metadata with files', async () => {
	const form = mailMultipartBody(
		{
			subject: 'invalid',
			attachments: [{ filename: 'hidden', type: 'text/plain', content: 'YQ==' }]
		},
		[{ filename: 'actual.txt', type: 'text/plain', content: btoa('hello') }]
	);
	await assert.rejects(
		() =>
			readMailRequest(new Request('https://mail.example/api/mail', { method: 'POST', body: form })),
		(error: unknown) => error instanceof Error && error.message.includes('omitted from multipart')
	);
});

test('maps malformed multipart form data to a bounded request error', async () => {
	await assert.rejects(
		() =>
			readMailRequest(
				new Request('https://mail.example/api/mail', {
					method: 'POST',
					headers: { 'content-type': 'multipart/form-data; boundary=missing' },
					body: 'not a multipart body'
				})
			),
		(error: unknown) => error instanceof Error && error.message === 'Invalid multipart body'
	);
});

test('keeps every repository mail caller off JSON attachment content', () => {
	for (const path of ['../../routes/compose/+page.svelte', '../../routes/mail/[id]/+page.svelte']) {
		const source = readFileSync(new URL(path, import.meta.url), 'utf8');
		assert.match(source, /mailMultipartBody/u, path);
	}
	const client = readFileSync(new URL('../../../cli/client.ts', import.meta.url), 'utf8');
	const sendMethods = client.slice(
		client.indexOf('async sendMessage'),
		client.indexOf('async listAddresses')
	);
	assert.doesNotMatch(sendMethods, /attachments/u);
});

test('accepts the full five by five MiB attachment contract through bounded multipart', async () => {
	const form = new FormData();
	form.set('payload', JSON.stringify({ subject: 'large' }));
	for (let index = 0; index < 5; index += 1) {
		form.append(
			'attachment',
			new File([new Uint8Array(5 * 1024 * 1024)], `file-${index}.bin`),
			`file-${index}.bin`
		);
	}
	const request = new Request('https://mail.example/api/mail', {
		method: 'POST',
		headers: { 'content-length': String(26 * 1024 * 1024) },
		body: form
	});
	const parsed = await readMailRequest<{
		subject: string;
		attachments?: OutboundAttachmentInput[];
	}>(request);
	assert.equal(parsed.attachments?.length, 5);
	assert.equal(
		parsed.attachments?.every((item) => item.content.length > 6 * 1024 * 1024),
		true
	);
});

test('preserves near-limit HTML and plain-text metadata in multipart', async () => {
	const body = 'x'.repeat(250_000);
	const form = new FormData();
	form.set('payload', JSON.stringify({ html: body, text: body }));
	const request = new Request('https://mail.example/api/mail', {
		method: 'POST',
		headers: { 'content-length': String(1024 * 1024) },
		body: form
	});
	const parsed = await readMailRequest<{
		html: string;
		text: string;
		attachments?: OutboundAttachmentInput[];
	}>(request);
	assert.equal(parsed.html.length, 250_000);
	assert.equal(parsed.text.length, 250_000);
});
