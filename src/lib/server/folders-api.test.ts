import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { POST as createFolder } from '../../routes/api/folders/+server';
import { PATCH as renameFolder } from '../../routes/api/folders/[id]/+server';
import { POST as assignFolder } from '../../routes/api/folders/assign/+server';

function event(request: Request, authMethod: 'session' | 'api_token' = 'session') {
	return {
		request,
		locals: {
			user: { id: 'u1', email: 'one@example.net', name: 'One', is_admin: false },
			authMethod,
			apiScopes: ['mail:read', 'mail:send', 'admin'],
			activeDomainId: null
		},
		platform: { env: { DB: {} as D1Database } },
		params: { id: 'folder' }
	} as never;
}

describe('folder API request boundaries', () => {
	test('rejects invalid JSON and malformed bodies as 400 instead of throwing', async () => {
		const invalid = new Request('https://example.test/api/folders', {
			method: 'POST',
			body: '{'
		});
		const createResponse = await createFolder(event(invalid));
		assert.equal(createResponse.status, 400);

		const renameResponse = await renameFolder(
			event(
				new Request('https://example.test/api/folders/folder', {
					method: 'PATCH',
					body: 'null'
				})
			)
		);
		assert.equal(renameResponse.status, 400);

		const assignResponse = await assignFolder(
			event(
				new Request('https://example.test/api/folders/assign', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ids: 'not-an-array', folderId: 'folder' })
				})
			)
		);
		assert.equal(assignResponse.status, 400);
	});

	test('direct route invocation still rejects API tokens', async () => {
		const response = await createFolder(
			event(
				new Request('https://example.test/api/folders', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ name: 'Private' })
				}),
				'api_token'
			)
		);
		assert.equal(response.status, 403);
	});
});
