import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { _createSetupPostHandler } from '../../routes/api/setup/+server';
import { resolveAuthRateLimitSecret, resolveBootstrapSecret } from './bootstrap-secret';
import { getSetupEmailProvider } from './context';

const childEnvironment = {
	BOOTSTRAP_SECRET: 'correct-bootstrap-secret-value',
	AUTH_RATE_LIMIT_SECRET: 'test-rate-limit-secret-at-least-32-bytes'
};

const setupPost = _createSetupPostHandler({
	resolveBootstrapSecret: (platform) =>
		resolveBootstrapSecret(platform, { isDev: true, privateEnvironment: childEnvironment }),
	resolveAuthRateLimitSecret: (platform) =>
		resolveAuthRateLimitSecret(platform, { isDev: true, privateEnvironment: childEnvironment })
});

function setupEvent(options: { configuredSecret?: string; providedSecret?: string }) {
	let queryCount = 0;
	let cookieWrites = 0;
	const db = {
		prepare(sql: string) {
			if (/auth_rate_limits/i.test(sql)) {
				return {
					bind: () => ({
						first: async () => ({ attempts: 1, window_started_at: new Date().toISOString() }),
						run: async () => ({ meta: { changes: 0 } })
					})
				};
			}
			assert.match(sql, /COUNT\(\*\).*users/i);
			queryCount += 1;
			return { first: async () => ({ count: 0 }) };
		}
	};
	const request = new Request('https://mail.example.com/api/setup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ bootstrapSecret: options.providedSecret })
	});
	return {
		event: {
			request,
			cookies: { set: () => (cookieWrites += 1) },
			platform: {
				env: {
					DB: db,
					BOOTSTRAP_SECRET: options.configuredSecret
				}
			}
		},
		observed: () => ({ queryCount, cookieWrites })
	};
}

describe('first-run bootstrap secret gate', () => {
	test('binds receive-only local state to explicit Japanese setup copy', () => {
		const load = readFileSync(
			new URL('../../routes/setup/+page.server.ts', import.meta.url),
			'utf8'
		);
		const page = readFileSync(new URL('../../routes/setup/+page.svelte', import.meta.url), 'utf8');
		assert.match(load, /available\.every\(\(domain\) => !domain\.can_send\)/u);
		assert.match(page, /data\.receiveOnlyLocal/u);
		assert.match(page, /ローカル確認用です。受信ドメインだけを使用します。送信はResend設定後/u);
	});
	test('uses only the exact dev private secret and ignores process-style env in production', () => {
		const privateEnvironment = {
			BOOTSTRAP_SECRET: 'exact-child-secret',
			OTHER_SECRET: 'never-read'
		};
		assert.equal(
			resolveBootstrapSecret(undefined, { isDev: true, privateEnvironment }),
			'exact-child-secret'
		);
		assert.equal(resolveBootstrapSecret(undefined, { isDev: false, privateEnvironment }), null);
		assert.equal(
			resolveBootstrapSecret(
				{ env: { BOOTSTRAP_SECRET: 'platform-secret' } },
				{ isDev: false, privateEnvironment }
			),
			'platform-secret'
		);
	});

	test('passes the child OS bootstrap secret through the actual setup endpoint adapter', async () => {
		const handler = _createSetupPostHandler({
			resolveAuthRateLimitSecret: (platform) =>
				resolveAuthRateLimitSecret(platform, {
					isDev: true,
					privateEnvironment: childEnvironment
				}),
			resolveBootstrapSecret: (platform) =>
				resolveBootstrapSecret(platform, {
					isDev: true,
					privateEnvironment: { BOOTSTRAP_SECRET: 'exact-child-secret' }
				}),
			consumeAuthRateLimit: async () => ({
				allowed: true,
				attempts: 1,
				retryAfterSeconds: 1,
				keyHash: 'test'
			}),
			pruneAuthRateLimits: async () => undefined,
			countUsers: async () => 0
		});
		const response = await handler({
			request: new Request('https://mail.example/api/setup', {
				method: 'POST',
				body: JSON.stringify({ bootstrapSecret: 'exact-child-secret' })
			}),
			cookies: {},
			platform: {
				env: { DB: {} },
				ctx: { waitUntil: () => undefined }
			}
		} as never);
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: 'Choose a domain first' });
	});
	test('fails closed with 503 when BOOTSTRAP_SECRET is missing', async () => {
		const { event, observed } = setupEvent({ providedSecret: 'provided-key' });
		const productionPost = _createSetupPostHandler({
			resolveAuthRateLimitSecret: (platform) =>
				resolveAuthRateLimitSecret(platform, {
					isDev: true,
					privateEnvironment: childEnvironment
				}),
			resolveBootstrapSecret: (platform) =>
				resolveBootstrapSecret(platform, {
					isDev: false,
					privateEnvironment: childEnvironment
				})
		});
		const response = await productionPost(event as never);
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), { error: 'Setup protection is not configured' });
		assert.deepEqual(observed(), { queryCount: 1, cookieWrites: 0 });
	});

	test('rejects a wrong setup key before provider or mutation work', async () => {
		const { event, observed } = setupEvent({
			configuredSecret: 'correct-bootstrap-secret-value',
			providedSecret: 'wrong-bootstrap-secret-value'
		});
		const response = await setupPost(event as never);
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: 'Invalid setup key' });
		assert.deepEqual(observed(), { queryCount: 1, cookieWrites: 0 });
	});

	test('allows the correct key through a fully mocked setup path without external actions', async () => {
		const { event, observed } = setupEvent({
			configuredSecret: 'correct-bootstrap-secret-value',
			providedSecret: 'correct-bootstrap-secret-value'
		});
		const calls: string[] = [];
		const handler = _createSetupPostHandler({
			resolveAuthRateLimitSecret: (platform) =>
				resolveAuthRateLimitSecret(platform, {
					isDev: true,
					privateEnvironment: childEnvironment
				}),
			consumeAuthRateLimit: async () => ({
				allowed: true,
				attempts: 1,
				retryAfterSeconds: 1,
				keyHash: 'test'
			}),
			pruneAuthRateLimits: async () => undefined,
			countUsers: async () => {
				calls.push('countUsers');
				return 0;
			},
			getEmailProvider: () =>
				({
					getDomain: async () => ({
						id: 'domain-1',
						name: 'example.com',
						status: 'verified',
						region: null,
						sendingEnabled: true,
						receivingEnabled: true
					})
				}) as never,
			claimSetupBootstrap: async () => 'claim-token',
			releaseSetupBootstrap: async () => undefined,
			renewSetupBootstrap: async () => true,
			finalizeSetup: async () => ({ userId: 'user-1', address: 'info@example.com' }),
			login: async () => null
		});
		event.request = new Request('https://mail.example.com/api/setup', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				bootstrapSecret: 'correct-bootstrap-secret-value',
				domainId: 'domain-1',
				localPart: 'info',
				name: '管理者',
				password: 'long-password'
			})
		});
		const response = await handler(event as never);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			ok: true,
			email: 'info@example.com',
			signedIn: false
		});
		assert.deepEqual(calls, ['countUsers']);
		assert.deepEqual(observed(), { queryCount: 0, cookieWrites: 0 });
	});

	test('creates the local first admin from Cloudflare inbound metadata without a Resend key', async () => {
		const configuredSecret = 'correct-bootstrap-secret-value';
		let finalizedDomain = '';
		const handler = _createSetupPostHandler({
			resolveAuthRateLimitSecret: () => childEnvironment.AUTH_RATE_LIMIT_SECRET,
			resolveBootstrapSecret: () => configuredSecret,
			consumeAuthRateLimit: async () => ({
				allowed: true,
				attempts: 1,
				retryAfterSeconds: 1,
				keyHash: 'test'
			}),
			pruneAuthRateLimits: async () => undefined,
			countUsers: async () => 0,
			getEmailProvider: (platform) => getSetupEmailProvider(platform, true),
			claimSetupBootstrap: async () => 'claim-token',
			releaseSetupBootstrap: async () => undefined,
			renewSetupBootstrap: async () => true,
			finalizeSetup: async (_db, _claim, input) => {
				finalizedDomain = input.domain.name;
				return { userId: 'user-1', address: 'info@example.com' };
			},
			login: async () => null
		});
		const response = await handler({
			request: new Request('http://localhost:5173/api/setup', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					bootstrapSecret: configuredSecret,
					domainId: 'example.com',
					localPart: 'info',
					name: '管理者',
					password: 'long-password'
				})
			}),
			cookies: {},
			platform: {
				env: {
					DB: {},
					EMAIL_PROVIDER: 'resend',
					INBOUND_EMAIL_PROVIDER: 'cloudflare',
					CLOUDFLARE_MAIL_DOMAINS: 'example.com'
				},
				ctx: { waitUntil: () => undefined }
			}
		} as never);
		assert.equal(response.status, 200);
		assert.equal(finalizedDomain, 'example.com');
	});

	test('never returns or logs an unexpected setup error detail', async () => {
		const canary = 'secret-canary-internal-provider-detail';
		const logs: unknown[][] = [];
		const originalError = console.error;
		console.error = (...values: unknown[]) => logs.push(values);
		try {
			const handler = _createSetupPostHandler({
				resolveAuthRateLimitSecret: () => childEnvironment.AUTH_RATE_LIMIT_SECRET,
				resolveBootstrapSecret: () => childEnvironment.BOOTSTRAP_SECRET,
				consumeAuthRateLimit: async () => ({
					allowed: true,
					attempts: 1,
					retryAfterSeconds: 1,
					keyHash: 'test'
				}),
				pruneAuthRateLimits: async () => undefined,
				countUsers: async () => 0,
				getEmailProvider: () =>
					({ getDomain: async () => ({ id: 'example.com', name: 'example.com' }) }) as never,
				claimSetupBootstrap: async () => 'claim-token',
				releaseSetupBootstrap: async () => undefined,
				renewSetupBootstrap: async () => true,
				finalizeSetup: async () => {
					throw new Error(canary);
				}
			});
			const response = await handler({
				request: new Request('http://localhost:5173/api/setup', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						bootstrapSecret: childEnvironment.BOOTSTRAP_SECRET,
						domainId: 'example.com',
						localPart: 'info',
						name: '管理者',
						password: 'long-password'
					})
				}),
				cookies: {},
				platform: { env: { DB: {} }, ctx: { waitUntil: () => undefined } }
			} as never);
			assert.equal(response.status, 400);
			const body = JSON.stringify(await response.json());
			assert.match(body, /初期設定を完了できませんでした/u);
			assert.doesNotMatch(body, new RegExp(canary, 'u'));
			assert.doesNotMatch(JSON.stringify(logs), new RegExp(canary, 'u'));
		} finally {
			console.error = originalError;
		}
	});
});
