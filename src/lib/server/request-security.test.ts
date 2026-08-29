import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { redirect } from '@sveltejs/kit';
import {
	MAX_JSON_REQUEST_BYTES,
	MAX_WEBHOOK_BYTES,
	RequestBodyError,
	applySecurityHeaders,
	rejectCrossOriginMutation,
	readJsonBody,
	readTextBody
} from './request-security';
import { POST as importOutlook } from '../../routes/api/admin/import-outlook/+server';
import { handle } from '../../hooks.server';

describe('runtime request security', () => {
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
