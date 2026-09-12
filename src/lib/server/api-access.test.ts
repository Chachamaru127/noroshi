import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { POST as createForwardingDestination } from '../../routes/api/forwarding/destinations/+server';
import { GET as getMailThread } from '../../routes/api/mail/[id]/+server';
import * as legacyForwardingRoute from '../../routes/api/forwarding/+server';
import { authorizeApiRequest, authorizeMailAction, authorizeManualForward } from './api-access';
import { parseScopes } from './api-tokens';

function unreadThreadDatabase() {
	let isRead = 0;
	const email = {
		id: 'message-1',
		user_id: 'user-1',
		direction: 'inbound',
		from_addr: 'sender@example.test',
		from_name: null,
		to_addr: 'owner@example.test',
		cc_addr: null,
		bcc_addr: null,
		subject: 'Unread subject',
		body_text: 'Unread body',
		body_html: null,
		message_id: null,
		in_reply_to: null,
		references_header: null,
		reply_to_email_id: null,
		thread_id: 'thread-1',
		thread_key: 'unread subject',
		domain_id: 'domain-1',
		address_id: 'address-1',
		provider_id: null,
		status: null,
		status_at: null,
		status_detail: null,
		is_starred: 0,
		deleted_at: null,
		created_at: '2026-09-12T00:00:00.000Z'
	};
	const db = {
		prepare(sql: string) {
			const statement = {
				bind() {
					return statement;
				},
				async first() {
					assert.match(sql, /SELECT \* FROM emails/u);
					return { ...email, is_read: isRead };
				},
				async all() {
					if (/FROM emails e/u.test(sql)) {
						return { results: [{ ...email, is_read: isRead }] };
					}
					assert.match(sql, /FROM email_attachments/u);
					return { results: [] };
				},
				async run() {
					assert.match(sql, /UPDATE emails SET is_read = 1/u);
					isRead = 1;
					return { meta: { changes: 1 } };
				}
			};
			return statement;
		}
	};
	return { db, readState: () => isRead };
}

describe('API key access', () => {
	test('manual forward needs both read and send scopes while sessions stay allowed', () => {
		assert.deepEqual(authorizeManualForward({ authMethod: 'session', scopes: [] }), { ok: true });
		assert.equal(
			authorizeManualForward({ authMethod: 'api_token', scopes: ['mail:read'] }).ok,
			false
		);
		assert.equal(
			authorizeManualForward({ authMethod: 'api_token', scopes: ['mail:send'] }).ok,
			false
		);
		assert.deepEqual(
			authorizeManualForward({
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}),
			{ ok: true }
		);
	});
	test('sessions are unrestricted', () => {
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/apikeys',
				method: 'POST',
				authMethod: 'session',
				scopes: []
			}),
			{ ok: true }
		);
	});

	test('a read key cannot send or manage keys', () => {
		assert.equal(
			authorizeApiRequest({
				pathname: '/api/mail',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['mail:read']
			}).ok,
			false
		);
		assert.equal(
			authorizeApiRequest({
				pathname: '/api/apikeys',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}).ok,
			false
		);
		assert.equal(
			authorizeApiRequest({
				pathname: '/api/push/subscriptions',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}).ok,
			false
		);
		assert.equal(
			authorizeApiRequest({
				pathname: '/api/push/subscriptions',
				method: 'GET',
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}).ok,
			false
		);
	});

	test('a read key can list and open threads', () => {
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/mail',
				method: 'GET',
				authMethod: 'api_token',
				scopes: ['mail:read']
			}),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/mail/abc',
				method: 'GET',
				authMethod: 'api_token',
				scopes: ['mail:read']
			}),
			{ ok: true }
		);
	});

	test('the MCP no-mark thread read preserves unread state while the existing default marks read', async () => {
		const fixture = unreadThreadDatabase();
		const event = (url: string) =>
			({
				params: { id: 'message-1' },
				url: new URL(url),
				locals: {
					user: {
						id: 'user-1',
						email: 'owner@example.test',
						name: 'Owner',
						is_admin: false,
						created_at: '2026-09-12T00:00:00.000Z'
					}
				},
				platform: { env: { DB: fixture.db } }
			}) as never;

		const readOnlyResponse = await getMailThread(
			event('https://mail.example.test/api/mail/message-1?markRead=false')
		);
		assert.equal(readOnlyResponse.status, 200);
		assert.equal(fixture.readState(), 0);

		const defaultResponse = await getMailThread(
			event('https://mail.example.test/api/mail/message-1')
		);
		assert.equal(defaultResponse.status, 200);
		assert.equal(fixture.readState(), 1);
	});

	test('admin routes stay off mail keys', () => {
		assert.equal(
			authorizeApiRequest({
				pathname: '/api/admin/users',
				method: 'GET',
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}).ok,
			false
		);
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/admin/users',
				method: 'GET',
				authMethod: 'api_token',
				scopes: ['admin']
			}),
			{ ok: true }
		);
	});

	test('parseScopes rejects admin unless allowed', () => {
		assert.equal(parseScopes(['mail:read', 'admin'], false), null);
		assert.deepEqual(parseScopes(['mail:read', 'admin'], true), ['mail:read', 'admin']);
		assert.equal(parseScopes(['mail:write'], true), null);
	});

	test('POST /api/mail/actions is allowed for read or send keys', () => {
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/mail/actions',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['mail:read']
			}),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/mail/actions',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['mail:send']
			}),
			{ ok: true }
		);
		assert.equal(
			authorizeApiRequest({
				pathname: '/api/mail/actions',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['admin']
			}).ok,
			false
		);
	});

	test('creating an address stays admin-only for API keys', () => {
		assert.equal(
			authorizeApiRequest({
				pathname: '/api/addresses',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['mail:send']
			}).ok,
			false
		);
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/addresses',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['admin']
			}),
			{ ok: true }
		);
	});

	test('forwarding settings require both mailbox scopes for API keys', () => {
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/forwarding/destinations',
				method: 'POST',
				authMethod: 'session',
				scopes: []
			}),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/forwarding',
				method: 'GET',
				authMethod: 'api_token',
				scopes: ['mail:read']
			}),
			{ ok: true }
		);
		assert.equal(
			authorizeApiRequest({
				pathname: '/api/forwarding/destinations',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['mail:read']
			}).ok,
			false
		);
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/forwarding/destinations',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['mail:read']
			}),
			{
				ok: false,
				status: 403,
				error: 'This API key needs mail:read and mail:send.'
			}
		);
		assert.equal(
			authorizeApiRequest({
				pathname: '/api/forwarding/rules/rule-1',
				method: 'PATCH',
				authMethod: 'api_token',
				scopes: ['mail:send']
			}).ok,
			false
		);
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/forwarding/destinations',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeApiRequest({
				pathname: '/api/forwarding',
				method: 'POST',
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}),
			{
				ok: false,
				status: 403,
				error: 'This API key cannot access that endpoint.'
			}
		);
	});

	test('forwarding creation is mounted only at the destinations route', async () => {
		assert.equal('POST' in legacyForwardingRoute, false);
		assert.equal(typeof createForwardingDestination, 'function');

		const response = await createForwardingDestination({
			request: new Request('https://noroshi.example/api/forwarding/destinations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({})
			}),
			locals: { user: { id: 'user-1', name: 'Owner' } },
			platform: { env: { DB: {} } },
			url: new URL('https://noroshi.example/api/forwarding/destinations')
		} as Parameters<typeof createForwardingDestination>[0]);

		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), {
			error: 'Source address and destination are required'
		});
	});

	test('mailbox flag actions need mail:read; destructive actions need both scopes', () => {
		assert.deepEqual(
			authorizeMailAction({ action: 'star', authMethod: 'session', scopes: [] }),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeMailAction({ action: 'empty-trash', authMethod: 'session', scopes: [] }),
			{ ok: true }
		);

		assert.deepEqual(
			authorizeMailAction({ action: 'read', authMethod: 'api_token', scopes: ['mail:read'] }),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeMailAction({ action: 'unread', authMethod: 'api_token', scopes: ['mail:read'] }),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeMailAction({ action: 'star', authMethod: 'api_token', scopes: ['mail:read'] }),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeMailAction({ action: 'unstar', authMethod: 'api_token', scopes: ['mail:read'] }),
			{ ok: true }
		);

		assert.equal(
			authorizeMailAction({ action: 'star', authMethod: 'api_token', scopes: ['mail:send'] }).ok,
			false
		);
		assert.equal(
			authorizeMailAction({ action: 'trash', authMethod: 'api_token', scopes: ['mail:read'] }).ok,
			false
		);
		assert.equal(
			authorizeMailAction({ action: 'delete', authMethod: 'api_token', scopes: ['mail:send'] }).ok,
			false
		);
		assert.equal(
			authorizeMailAction({
				action: 'empty-trash',
				authMethod: 'api_token',
				scopes: ['mail:send']
			}).ok,
			false
		);
		assert.equal(
			authorizeMailAction({
				action: 'read-all',
				authMethod: 'api_token',
				scopes: ['mail:read']
			}).ok,
			false
		);

		assert.deepEqual(
			authorizeMailAction({
				action: 'trash',
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeMailAction({
				action: 'restore',
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeMailAction({
				action: 'delete',
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeMailAction({
				action: 'read-all',
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}),
			{ ok: true }
		);
		assert.deepEqual(
			authorizeMailAction({
				action: 'empty-trash',
				authMethod: 'api_token',
				scopes: ['mail:read', 'mail:send']
			}),
			{ ok: true }
		);
	});
});
