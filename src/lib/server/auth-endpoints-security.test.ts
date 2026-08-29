import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { _createLoginPostHandler } from '../../routes/api/auth/login/+server';
import { _createSetupPostHandler } from '../../routes/api/setup/+server';

const limited = async () => ({
	allowed: false,
	attempts: 6,
	retryAfterSeconds: 120,
	keyHash: 'hash'
});

function platform() {
	return {
		env: { DB: {}, AUTH_RATE_LIMIT_SECRET: 'test-rate-limit-secret-at-least-32-bytes' },
		ctx: { waitUntil: () => undefined }
	};
}

describe('public authentication endpoint throttling', () => {
	test('fails closed before login work when the HMAC pepper is unavailable', async () => {
		let limiterCalls = 0;
		const handler = _createLoginPostHandler({
			consumeAuthRateLimit: async (...args) => {
				limiterCalls += 1;
				return limited();
			}
		});
		const response = await handler({
			request: new Request('https://mail.example/api/auth/login', {
				method: 'POST',
				body: JSON.stringify({ email: 'owner@example.net', password: 'secret-password' })
			}),
			cookies: {},
			platform: { env: { DB: {} } }
		} as never);
		assert.equal(response.status, 503);
		assert.equal(limiterCalls, 0);
	});
	test('blocks a limited login before password verification', async () => {
		let loginCalls = 0;
		const handler = _createLoginPostHandler({
			consumeAuthRateLimit: limited,
			pruneAuthRateLimits: async () => undefined,
			login: async () => {
				loginCalls += 1;
				return null;
			}
		});
		const response = await handler({
			request: new Request('https://mail.example/api/auth/login', {
				method: 'POST',
				body: JSON.stringify({ email: 'owner@example.net', password: 'secret-password' })
			}),
			cookies: {},
			platform: platform()
		} as never);
		assert.equal(response.status, 429);
		assert.equal(response.headers.get('retry-after'), '120');
		assert.equal(loginCalls, 0);
	});

	test('blocks a limited setup before user/provider inspection', async () => {
		let countCalls = 0;
		const handler = _createSetupPostHandler({
			consumeAuthRateLimit: limited,
			pruneAuthRateLimits: async () => undefined,
			countUsers: async () => {
				countCalls += 1;
				return 0;
			}
		});
		const response = await handler({
			request: new Request('https://mail.example/api/setup', {
				method: 'POST',
				body: JSON.stringify({ bootstrapSecret: 'never-read' })
			}),
			cookies: {},
			platform: platform()
		} as never);
		assert.equal(response.status, 429);
		assert.equal(response.headers.get('retry-after'), '120');
		assert.equal(countCalls, 0);
	});
});
