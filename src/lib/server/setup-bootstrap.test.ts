import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { _createSetupPostHandler, POST } from '../../routes/api/setup/+server';

function setupEvent(options: { configuredSecret?: string; providedSecret?: string }) {
	let queryCount = 0;
	let cookieWrites = 0;
	const db = {
		prepare(sql: string) {
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
			platform: { env: { DB: db, BOOTSTRAP_SECRET: options.configuredSecret } }
		},
		observed: () => ({ queryCount, cookieWrites })
	};
}

describe('first-run bootstrap secret gate', () => {
	test('fails closed with 503 when BOOTSTRAP_SECRET is missing', async () => {
		const { event, observed } = setupEvent({ providedSecret: 'provided-key' });
		const response = await POST(event as never);
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), { error: 'Setup protection is not configured' });
		assert.deepEqual(observed(), { queryCount: 1, cookieWrites: 0 });
	});

	test('rejects a wrong setup key before provider or mutation work', async () => {
		const { event, observed } = setupEvent({
			configuredSecret: 'correct-bootstrap-secret-value',
			providedSecret: 'wrong-bootstrap-secret-value'
		});
		const response = await POST(event as never);
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
			upsertDomain: async (_db, domain) =>
				({
					...domain,
					sending_enabled: true,
					receiving_enabled: true,
					catchall_user_id: null,
					created_at: '2026-01-01T00:00:00.000Z',
					synced_at: null
				}) as never,
			bootstrapAdmin: async () => ({ id: 'user-1' }) as never,
			createAddress: async () => ({}) as never,
			setCatchallUser: async () => undefined,
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
});
