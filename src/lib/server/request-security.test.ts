import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { redirect } from '@sveltejs/kit';
import { MAX_BODY_BYTES } from './constants';
import { readMailRequest, validateMailRequestBody } from './mail-request';
import {
	MAX_JSON_REQUEST_BYTES,
	MAX_WEBHOOK_BYTES,
	RequestBodyError,
	applySecurityHeaders,
	rejectCrossOriginMutation,
	readJsonBody,
	readEndpointJsonBody,
	withRequestBodyErrors,
	readTextBody
} from './request-security';
import { POST as importOutlook } from '../../routes/api/admin/import-outlook/+server';
import { handle } from '../../hooks.server';

describe('runtime request security', () => {
	test('keeps inbound diagnostics free of message and attachment identifiers', () => {
		for (const path of [
			'cloudflare-inbound.ts',
			'inbound.ts',
			'../../routes/api/webhooks/resend/+server.ts'
		]) {
			const source = readFileSync(new URL(path, import.meta.url), 'utf8');
			assert.doesNotMatch(
				source,
				/console\.(?:error|warn)\([^\n]*(?:filename|providerId|attachment\.id|event\.type|,\s*error)/u
			);
		}
	});
	test('rejects cross-origin browser mutations but permits same-origin and bearer API calls', () => {
		const crossOrigin = new Request('https://mail.example/api/auth/login', {
			method: 'POST',
			headers: { Origin: 'https://evil.example' }
		});
		assert.equal(rejectCrossOriginMutation(crossOrigin, new URL(crossOrigin.url)), true);

		const sameOrigin = new Request('https://mail.example/api/auth/login', {
			method: 'POST',
			headers: { Origin: 'https://mail.example' }
		});
		assert.equal(rejectCrossOriginMutation(sameOrigin, new URL(sameOrigin.url)), false);

		const bearer = new Request('https://mail.example/api/mail', {
			method: 'POST',
			headers: { Authorization: 'Bearer qm_token' }
		});
		assert.equal(rejectCrossOriginMutation(bearer, new URL(bearer.url)), false);
	});

	test('adds browser security headers and HSTS only on HTTPS', () => {
		const response = applySecurityHeaders(
			new Response('ok'),
			new URL('https://mail.example/inbox')
		);
		assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
		assert.equal(response.headers.get('x-frame-options'), 'DENY');
		assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
		assert.match(response.headers.get('permissions-policy') ?? '', /camera=\(\)/);
		assert.match(response.headers.get('strict-transport-security') ?? '', /max-age=31536000/);

		const local = applySecurityHeaders(new Response('ok'), new URL('http://localhost:5173/'));
		assert.equal(local.headers.has('strict-transport-security'), false);
	});

	test('stops oversized JSON while streaming before JSON parsing', async () => {
		const request = new Request('https://mail.example/api/mail', {
			method: 'POST',
			body: JSON.stringify({ value: 'x'.repeat(MAX_JSON_REQUEST_BYTES) })
		});
		await assert.rejects(
			() => readJsonBody(request, 128),
			(error: unknown) => {
				assert.ok(error instanceof RequestBodyError);
				assert.equal(error.status, 413);
				return true;
			}
		);
	});

	test('rejects malformed Content-Length but accepts a streamed JSON body without it', async () => {
		await assert.rejects(
			() =>
				readJsonBody(
					new Request('https://mail.example/api/mail', {
						method: 'POST',
						headers: { 'content-length': 'not-a-number' },
						body: '{}'
					})
				),
			(error: unknown) => error instanceof RequestBodyError && error.status === 400
		);
		await assert.doesNotReject(() =>
			readJsonBody(
				new Request('https://mail.example/api/mail', {
					method: 'POST',
					body: JSON.stringify({ ok: true })
				})
			)
		);
	});

	test('bounds attachment-free multilingual JSON and rejects one byte over', async () => {
		const legacyEnvelope = MAX_BODY_BYTES * 2 * 4 + 256 * 1024;
		assert.equal(MAX_JSON_REQUEST_BYTES, legacyEnvelope);
		const multilingualBodies =
			new TextEncoder().encode('😀'.repeat(MAX_BODY_BYTES / 2)).byteLength +
			new TextEncoder().encode('あ'.repeat(MAX_BODY_BYTES)).byteLength;
		assert.ok(multilingualBodies + 256 * 1024 <= legacyEnvelope);
		await assert.doesNotReject(() =>
			readEndpointJsonBody(
				new Request('https://mail.example/api/mail', {
					method: 'POST',
					headers: { 'content-length': String(legacyEnvelope) },
					body: '{}'
				})
			)
		);
		const oversizedHandler = withRequestBodyErrors(
			async ({ request }) =>
				new Response(JSON.stringify(await readEndpointJsonBody(request, MAX_JSON_REQUEST_BYTES)))
		);
		const oversized = await oversizedHandler({
			request: new Request('https://mail.example/api/mail', {
				method: 'POST',
				headers: { 'content-length': String(legacyEnvelope + 1) },
				body: '{}'
			})
		} as never);
		assert.equal(oversized.status, 413);
	});

	test('accepts bounded multilingual bodies but rejects JSON attachment content and null', async () => {
		assert.doesNotThrow(() =>
			validateMailRequestBody({
				text: '😀'.repeat(MAX_BODY_BYTES / 2),
				html: 'あ'.repeat(MAX_BODY_BYTES)
			})
		);
		await assert.rejects(
			() =>
				readMailRequest(
					new Request('https://mail.example/api/mail', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							attachments: [{ filename: 'a.txt', type: 'text/plain', content: 'YQ==' }]
						})
					})
				),
			(error: unknown) => error instanceof RequestBodyError && error.status === 400
		);
		await assert.rejects(
			() =>
				readMailRequest(
					new Request('https://mail.example/api/mail', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ text: { invalid: true } })
					})
				),
			(error: unknown) => error instanceof RequestBodyError && error.status === 400
		);
		await assert.rejects(
			() =>
				readMailRequest(
					new Request('https://mail.example/api/mail', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: 'null'
					})
				),
			(error: unknown) => error instanceof RequestBodyError && error.status === 400
		);
	});

	test('stops a webhook stream that exceeds its real byte limit without Content-Length', async () => {
		const request = new Request('https://mail.example/api/webhooks/resend', {
			method: 'POST',
			body: 'x'.repeat(129)
		});
		await assert.rejects(
			() => readTextBody(request, 128),
			(error: unknown) => {
				assert.ok(error instanceof RequestBodyError);
				assert.equal(error.status, 413);
				return true;
			}
		);
		assert.equal(MAX_WEBHOOK_BYTES, 2 * 1024 * 1024);
	});

	test('keeps the runtime shell free of external font requests', () => {
		const layout = readFileSync(new URL('../../routes/+layout.svelte', import.meta.url), 'utf8');
		assert.doesNotMatch(layout, /fonts\.(?:googleapis|gstatic)\.com/);
	});

	test('uses the bounded JSON reader for reply payloads', () => {
		const route = readFileSync(
			new URL('../../routes/api/mail/[id]/+server.ts', import.meta.url),
			'utf8'
		);
		const replyPost = route.slice(route.indexOf('export const POST'));
		assert.match(replyPost, /readMailRequest<ReplyBody>\(request\)/);
		assert.doesNotMatch(replyPost, /request\.json\(\)/);
	});

	test('keeps every route mutation free of raw Request JSON buffering', () => {
		const routes = new URL('../../routes/', import.meta.url);
		for (const path of readdirSync(routes, { recursive: true, encoding: 'utf8' })) {
			if (!path.endsWith('+server.ts')) continue;
			const source = readFileSync(new URL(path, routes), 'utf8');
			assert.doesNotMatch(source, /request\.(?:json|text|arrayBuffer)\s*\(/, path);
		}
	});

	test('maps every bounded JSON and mail endpoint body error at the endpoint boundary', () => {
		const routes = new URL('../../routes/api/', import.meta.url);
		for (const path of readdirSync(routes, { recursive: true, encoding: 'utf8' })) {
			if (!path.endsWith('+server.ts')) continue;
			const source = readFileSync(new URL(path, routes), 'utf8');
			if (source.includes('readJsonBody(')) {
				assert.match(source, /error instanceof RequestBodyError/u, path);
				assert.match(source, /status:\s*error\.status/u, path);
			}
			if (source.includes('readEndpointJsonBody(')) {
				assert.match(source, /withRequestBodyErrors/u, path);
			}
			if (source.includes('readMailRequest<')) {
				assert.match(source, /error instanceof RequestBodyError/u, path);
				assert.match(source, /status:\s*error\.status/u, path);
			}
		}
	});

	test('rejects an oversized EML request before multipart buffering', async () => {
		const response = await importOutlook({
			request: new Request('https://mail.example/api/admin/import-outlook', {
				method: 'POST',
				headers: {
					'content-type': 'multipart/form-data; boundary=test',
					'content-length': String(52 * 1024 * 1024)
				},
				body: '--test--'
			}),
			locals: { user: { id: 'admin', is_admin: true }, authMethod: 'session' },
			platform: { env: { DB: {}, ATTACHMENTS: {} } }
		} as never);
		assert.equal(response.status, 413);
	});

	test('enforces origin and headers through the SvelteKit hook', async () => {
		const locals = {};
		const blocked = await handle({
			event: {
				request: new Request('https://mail.example/api/auth/login', {
					method: 'POST',
					headers: { Origin: 'https://evil.example' }
				}),
				url: new URL('https://mail.example/api/auth/login'),
				locals,
				cookies: { get: () => undefined }
			},
			resolve: async () => new Response('should not run')
		} as never);
		assert.equal(blocked.status, 403);
		assert.equal(blocked.headers.get('x-frame-options'), 'DENY');

		const allowed = await handle({
			event: {
				request: new Request('https://mail.example/login'),
				url: new URL('https://mail.example/login'),
				locals: {},
				cookies: { get: () => undefined }
			},
			resolve: async () => new Response('ok')
		} as never);
		assert.equal(allowed.status, 200);
		assert.match(allowed.headers.get('content-security-policy') ?? '', /default-src 'self'/);

		const redirected = await handle({
			event: {
				request: new Request('https://mail.example/inbox'),
				url: new URL('https://mail.example/inbox'),
				locals: {},
				cookies: { get: () => undefined },
				platform: {
					env: {
						DB: {
							prepare: () => ({ first: async () => ({ count: 0 }) })
						}
					}
				}
			},
			resolve: async () => new Response('should not run')
		} as never);
		assert.equal(redirected.status, 303);
		assert.equal(redirected.headers.get('location'), '/setup');
		assert.match(redirected.headers.get('strict-transport-security') ?? '', /max-age/);

		const bodyError = await handle({
			event: {
				request: new Request('https://mail.example/api/webhooks/resend', {
					method: 'POST',
					headers: { Origin: 'https://mail.example' }
				}),
				url: new URL('https://mail.example/api/webhooks/resend'),
				locals: {},
				cookies: { get: () => undefined }
			},
			resolve: async () => {
				throw new RequestBodyError('Request body is too large', 413);
			}
		} as never);
		assert.equal(bodyError.status, 413);
		assert.equal(bodyError.headers.get('x-frame-options'), 'DENY');

		const dependencyError = await handle({
			event: {
				request: new Request('https://mail.example/inbox'),
				url: new URL('https://mail.example/inbox'),
				locals: {},
				cookies: { get: () => undefined },
				platform: {
					env: {
						DB: {
							prepare: () => ({
								first: async () => {
									throw new Error('private detail');
								}
							})
						}
					}
				}
			},
			resolve: async () => new Response('should not run')
		} as never);
		assert.equal(dependencyError.status, 500);
		assert.equal(dependencyError.headers.get('x-frame-options'), 'DENY');
		assert.doesNotMatch(await dependencyError.text(), /private detail/);

		await assert.rejects(
			async () =>
				await handle({
					event: {
						request: new Request('https://mail.example/api/webhooks/resend', { method: 'POST' }),
						url: new URL('https://mail.example/api/webhooks/resend'),
						locals: {},
						cookies: { get: () => undefined }
					},
					resolve: async () => {
						throw redirect(303, '/login');
					}
				} as never),
			(error: unknown) =>
				Boolean(error && typeof error === 'object' && 'status' in error && error.status === 303)
		);
	});
});
