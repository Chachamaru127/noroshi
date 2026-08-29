import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findMatchingProviderDomain } from './domains';
import { PATCH as refreshDomain } from '../../routes/api/domains/[id]/+server';

describe('provider domain identity reconciliation', () => {
	test('matches an existing Resend UUID row by normalized domain name', () => {
		const remote = {
			id: 'example.com',
			name: 'EXAMPLE.COM',
			status: 'verified',
			sendingEnabled: true,
			receivingEnabled: true
		};
		assert.equal(
			findMatchingProviderDomain({ id: '4f56d06a-legacy-resend-uuid', name: 'example.com' }, [
				remote
			]),
			remote
		);
	});

	test('matches a newly configured name-based row by its provider id', () => {
		const remote = {
			id: 'example.com',
			name: 'example.com',
			status: 'verified',
			sendingEnabled: true,
			receivingEnabled: true
		};
		assert.equal(
			findMatchingProviderDomain({ id: 'example.com', name: 'example.com' }, [remote]),
			remote
		);
	});
});

test('refreshes a legacy Resend UUID row through the configured domain name', async () => {
	let row = {
		id: '4f56d06a-legacy-resend-uuid',
		name: 'example.com',
		status: 'pending',
		region: null,
		sending_enabled: 0,
		receiving_enabled: 1,
		catchall_user_id: null,
		created_at: '2026-08-01T00:00:00.000Z',
		synced_at: null
	};
	const db = {
		prepare(sql: string) {
			let args: unknown[] = [];
			return {
				bind(...values: unknown[]) {
					args = values;
					return this;
				},
				async first() {
					if (sql.includes('WHERE id = ?')) return args[0] === row.id ? row : null;
					if (sql.includes('WHERE name = ?')) return args[0] === row.name ? row : null;
					return null;
				},
				async run() {
					if (sql.includes('INSERT INTO domains')) {
						row = {
							...row,
							id: String(args[0]),
							name: String(args[1]),
							status: String(args[2]),
							sending_enabled: Number(args[4]),
							receiving_enabled: Number(args[5])
						};
					}
					return { meta: { changes: 1 } };
				}
			};
		}
	};
	const response = await refreshDomain({
		params: { id: row.id },
		request: new Request('https://mail.example/api/domains/legacy', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ refresh: true })
		}),
		locals: { user: { id: 'admin', is_admin: true } },
		platform: {
			env: {
				DB: db,
				EMAIL_PROVIDER: 'resend',
				INBOUND_EMAIL_PROVIDER: 'cloudflare',
				RESEND_API_KEY: 'test',
				CLOUDFLARE_MAIL_DOMAINS: 'example.com',
				RESEND_SEND_DOMAINS: 'example.com'
			}
		}
	} as never);
	assert.equal(response.status, 200);
	assert.equal((await response.json()).domain.id, '4f56d06a-legacy-resend-uuid');
	assert.equal(row.status, 'verified');
});
