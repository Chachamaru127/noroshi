import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { POST as createForwardingDestinationRoute } from '../../routes/api/forwarding/destinations/+server';
import { PATCH as patchForwardingRule } from '../../routes/api/forwarding/rules/[id]/+server';
import { hashToken } from './crypto';
import {
	FORWARDING_VERIFICATION_TTL_MS,
	createVerificationToken,
	normalizeForwardingDestination
} from './forwarding-contract';
import {
	createForwardingAttempt,
	createOrResetForwardingDestination,
	ForwardingStateError,
	ForwardingValidationError,
	getForwardingDestinationForUser,
	getForwardingRuleForUser,
	getForwardingAttemptByProviderId,
	listDueForwardingAttempts,
	setForwardingRuleEnabled,
	updateForwardingAttempt,
	verifyForwardingDestination
} from './forwarding';

type UserRow = { id: string; email: string };
type DomainRow = {
	id: string;
	name: string;
	status: string;
	region: string | null;
	sending_enabled: number;
	receiving_enabled: number;
	catchall_user_id: string | null;
	created_at: string;
	synced_at: string | null;
};
type AddressRow = {
	id: string;
	user_id: string;
	domain_id: string;
	domain_name: string;
	address: string;
	label: string | null;
	is_default: number;
	signature: string | null;
	created_at: string;
};
type EmailRow = {
	id: string;
	user_id: string;
	provider_id: string | null;
	direction?: 'inbound' | 'outbound';
	to_addr?: string;
};

class MemoryD1 {
	readonly users = new Map<string, UserRow>();
	readonly domains = new Map<string, DomainRow>();
	readonly addresses = new Map<string, AddressRow>();
	readonly destinations = new Map<string, Record<string, unknown>>();
	readonly rules = new Map<string, Record<string, unknown>>();
	readonly attempts = new Map<string, Record<string, unknown>>();
	readonly emails = new Map<string, EmailRow>();

	prepare(sql: string) {
		return {
			bind: (...args: unknown[]) => ({
				all: async <T>() => ({ results: this.all<T>(sql, args) }),
				first: async <T>() => this.first<T>(sql, args),
				run: async () => ({ meta: { changes: this.run(sql, args) } })
			})
		};
	}

	private async first<T>(sql: string, args: unknown[]): Promise<T | null> {
		if (sql.includes('FROM addresses a JOIN domains d')) {
			const address = this.addresses.get(String(args[0]));
			const domain = address ? this.domains.get(address.domain_id) : null;
			return address && address.user_id === String(args[1])
				? ({ ...address, can_send: domain?.sending_enabled ?? 0 } as T)
				: null;
		}
		if (sql.includes('SELECT id FROM addresses WHERE user_id')) {
			const match = [...this.addresses.values()].find(
				(row) => row.user_id === String(args[0]) && row.address.toLowerCase() === String(args[1])
			);
			return (match ? { id: match.id } : null) as T | null;
		}
		if (sql.includes('SELECT id FROM users WHERE id')) {
			const user = this.users.get(String(args[0]));
			return (
				user && user.email.toLowerCase() === String(args[1]) ? { id: user.id } : null
			) as T | null;
		}
		if (sql.includes('FROM domains WHERE name')) {
			const match = [...this.domains.values()].find((row) => row.name === String(args[0]));
			return (match ?? null) as T | null;
		}
		if (sql.includes('FROM forwarding_destinations WHERE verification_token_hash')) {
			const match = [...this.destinations.values()].find(
				(row) => row.verification_token_hash === args[0]
			);
			return (match ?? null) as T | null;
		}
		if (sql.includes('FROM forwarding_destinations WHERE user_id = ? AND source_address_id')) {
			const match = [...this.destinations.values()].find(
				(row) => row.user_id === args[0] && row.source_address_id === args[1]
			);
			return (match ?? null) as T | null;
		}
		if (sql.includes('FROM forwarding_destinations WHERE user_id = ? AND id')) {
			const row = this.destinations.get(String(args[1]));
			return (row && row.user_id === args[0] ? row : null) as T | null;
		}
		if (sql.includes('FROM forwarding_rules WHERE user_id = ? AND id')) {
			const row = this.rules.get(String(args[1]));
			return (row && row.user_id === args[0] ? row : null) as T | null;
		}
		if (sql.includes('FROM forwarding_rules WHERE user_id = ? AND source_address_id')) {
			const row = [...this.rules.values()].find(
				(value) => value.user_id === args[0] && value.source_address_id === args[1]
			);
			return (row ?? null) as T | null;
		}
		if (
			sql.includes('FROM forwarding_rules r') &&
			sql.includes('JOIN addresses a') &&
			sql.includes("e.direction = 'inbound'")
		) {
			const rule = this.rules.get(String(args[1]));
			const email = this.emails.get(String(args[0]));
			const address = rule ? this.addresses.get(String(rule.source_address_id)) : null;
			return (
				rule &&
				email &&
				address &&
				rule.user_id === email.user_id &&
				rule.user_id === address.user_id &&
				email.direction === 'inbound' &&
				email.to_addr?.toLowerCase() === address.address.toLowerCase()
					? {
							id: rule.id,
							destination_id: rule.destination_id,
							destination_address: this.destinations.get(String(rule.destination_id))
								?.destination_address,
							hop: 0
						}
					: null
			) as T | null;
		}
		if (sql.includes('FROM forwarding_rules r') && sql.includes('JOIN emails')) {
			const rule = this.rules.get(String(args[1]));
			const email = this.emails.get(String(args[0]));
			return (rule && email && rule.user_id === email.user_id ? { id: rule.id } : null) as T | null;
		}
		if (sql.includes('FROM forwarding_attempts WHERE provider_id')) {
			const row = [...this.attempts.values()].find((value) => value.provider_id === args[0]);
			return (row ?? null) as T | null;
		}
		if (sql.includes('FROM forwarding_attempts WHERE rule_id = ? AND email_id')) {
			const row = this.attempts.get(`${args[0]}:${args[1]}`);
			return (row ?? null) as T | null;
		}
		if (sql.includes('FROM forwarding_attempts WHERE id')) {
			const row = [...this.attempts.values()].find((value) => value.id === args[0]);
			return (row ?? null) as T | null;
		}
		return null;
	}

	private all<T>(sql: string, args: unknown[]): T[] {
		if (sql.includes('FROM addresses a') && sql.includes('LEFT JOIN forwarding_destinations')) {
			return [...this.addresses.values()]
				.filter((row) => row.user_id === args[0])
				.map((address) => {
					const domain = this.domains.get(address.domain_id);
					const destination = [...this.destinations.values()].find(
						(value) => value.user_id === address.user_id && value.source_address_id === address.id
					);
					const rule = [...this.rules.values()].find(
						(value) => value.user_id === address.user_id && value.source_address_id === address.id
					);
					return {
						...address,
						can_send: domain?.sending_enabled ?? 0,
						destination_id: destination?.id ?? null,
						destination_user_id: destination?.user_id ?? null,
						destination_source_address_id: destination?.source_address_id ?? null,
						destination_address: destination?.destination_address ?? null,
						destination_status: destination?.status ?? null,
						verification_expires_at: destination?.verification_expires_at ?? null,
						verification_used_at: destination?.verification_used_at ?? null,
						verified_at: destination?.verified_at ?? null,
						destination_created_at: destination?.created_at ?? null,
						destination_updated_at: destination?.updated_at ?? null,
						rule_id: rule?.id ?? null,
						rule_user_id: rule?.user_id ?? null,
						rule_source_address_id: rule?.source_address_id ?? null,
						rule_destination_id: rule?.destination_id ?? null,
						rule_status: rule?.status ?? null,
						rule_created_at: rule?.created_at ?? null,
						rule_updated_at: rule?.updated_at ?? null
					};
				}) as T[];
		}
		if (sql.includes('FROM forwarding_attempts a') && sql.includes('status IN')) {
			const cutoff = String(args[0]);
			const limit = Number(args[1]);
			return [...this.attempts.values()]
				.filter((row) => {
					const rule = this.rules.get(String(row.rule_id));
					return (
						rule?.status === 'enabled' &&
						(row.status === 'queued' || row.status === 'failed') &&
						Number(row.attempt_count) < 4 &&
						typeof row.next_attempt_at === 'string' &&
						row.next_attempt_at <= cutoff
					);
				})
				.sort((left, right) =>
					String(left.next_attempt_at).localeCompare(String(right.next_attempt_at))
				)
				.slice(0, limit) as T[];
		}
		return [];
	}

	private run(sql: string, args: unknown[]): number {
		if (sql.includes('INSERT INTO forwarding_destinations')) {
			const row = {
				id: args[0],
				user_id: args[1],
				source_address_id: args[2],
				destination_address: args[3],
				status: 'pending',
				verification_token_hash: args[4],
				verification_expires_at: args[5],
				verification_used_at: null,
				verified_at: null,
				created_at: args[6],
				updated_at: args[7]
			};
			this.destinations.set(String(row.id), row);
			return 1;
		}
		if (sql.includes('UPDATE forwarding_destinations') && sql.includes('destination_address')) {
			const row = this.destinations.get(String(args[4]));
			if (!row || row.user_id !== args[5]) return 0;
			Object.assign(row, {
				destination_address: args[0],
				status: 'pending',
				verification_token_hash: args[1],
				verification_expires_at: args[2],
				verification_used_at: null,
				verified_at: null,
				updated_at: args[3]
			});
			return 1;
		}
		if (sql.includes('UPDATE forwarding_destinations') && sql.includes("status = 'verified'")) {
			const row = this.destinations.get(String(args[3]));
			if (!row || row.verification_token_hash !== args[4] || row.status !== 'pending') return 0;
			Object.assign(row, {
				status: 'verified',
				verified_at: args[0],
				verification_used_at: args[1],
				updated_at: args[2]
			});
			return 1;
		}
		if (sql.includes('INSERT INTO forwarding_rules')) {
			const row = {
				id: args[0],
				user_id: args[1],
				source_address_id: args[2],
				destination_id: args[3],
				status: 'disabled',
				created_at: args[4],
				updated_at: args[5]
			};
			this.rules.set(String(row.id), row);
			return 1;
		}
		if (sql.includes('UPDATE forwarding_rules') && sql.includes('SET destination_id')) {
			const row = this.rules.get(String(args[2]));
			if (!row || row.user_id !== args[3]) return 0;
			Object.assign(row, {
				destination_id: args[0],
				status: 'disabled',
				enabled_at: null,
				updated_at: args[1]
			});
			return 1;
		}
		if (sql.includes('UPDATE forwarding_rules') && sql.includes('SET status')) {
			const enabling = sql.includes("status = 'enabled'");
			const row = this.rules.get(String(args[enabling ? 2 : 1]));
			if (!row || row.user_id !== args[enabling ? 3 : 2]) return 0;
			Object.assign(row, {
				status: enabling ? 'enabled' : 'disabled',
				enabled_at: enabling ? (row.enabled_at ?? args[0]) : null,
				updated_at: args[enabling ? 1 : 0]
			});
			return 1;
		}
		if (sql.includes('UPDATE forwarding_attempts')) {
			const row = [...this.attempts.values()].find((value) => value.id === args[7]);
			if (!row) return 0;
			Object.assign(row, {
				status: args[0],
				attempt_count: args[1],
				provider_id: args[2] ?? row.provider_id,
				next_attempt_at: args[3],
				last_attempt_at: args[4],
				error_code: args[5],
				updated_at: args[6]
			});
			return 1;
		}
		if (sql.includes('INSERT INTO forwarding_attempts')) {
			const key = `${args[1]}:${args[2]}`;
			if (this.attempts.has(key)) return 0;
			const row = {
				id: args[0],
				rule_id: args[1],
				email_id: args[2],
				provider_id: args[3],
				status: 'queued',
				attempt_count: 0,
				next_attempt_at: args[4],
				last_attempt_at: null,
				error_code: null,
				hop: args[5],
				destination_id: args[6],
				destination_address: args[7],
				created_at: args[8],
				updated_at: args[9]
			};
			this.attempts.set(key, row);
			return 1;
		}
		return 0;
	}

	db(): D1Database {
		return this as unknown as D1Database;
	}
}

function seedDb() {
	const db = new MemoryD1();
	const createdAt = '2026-08-24T00:00:00.000Z';
	db.users.set('user-1', { id: 'user-1', email: 'owner@outside.example' });
	db.users.set('user-2', { id: 'user-2', email: 'other@outside.example' });
	db.domains.set('domain-1', {
		id: 'domain-1',
		name: 'quickmail.example',
		status: 'verified',
		region: null,
		sending_enabled: 1,
		receiving_enabled: 1,
		catchall_user_id: null,
		created_at: createdAt,
		synced_at: null
	});
	db.addresses.set('address-1', {
		id: 'address-1',
		user_id: 'user-1',
		domain_id: 'domain-1',
		domain_name: 'quickmail.example',
		address: 'info@quickmail.example',
		label: null,
		is_default: 1,
		signature: null,
		created_at: createdAt
	});
	db.addresses.set('address-2', {
		id: 'address-2',
		user_id: 'user-2',
		domain_id: 'domain-1',
		domain_name: 'quickmail.example',
		address: 'other@quickmail.example',
		label: null,
		is_default: 1,
		signature: null,
		created_at: createdAt
	});
	return db;
}

describe('automatic forwarding data contract', () => {
	test('rejects a receive-only source before creating an automatic forwarding destination', async () => {
		const db = seedDb();
		db.domains.get('domain-1')!.sending_enabled = 0;
		await assert.rejects(
			() =>
				createOrResetForwardingDestination(db.db(), 'user-1', {
					sourceAddressId: 'address-1',
					destination: 'outside@external.example'
				}),
			/receive-only/i
		);
	});
	test('normalizes a strict external email address', () => {
		assert.equal(
			normalizeForwardingDestination('  Destination@Example.com  '),
			'destination@example.com'
		);
	});

	test('rejects control characters and malformed destinations', () => {
		for (const value of [
			'destination@example.com\r\nBcc: attacker@example.net',
			'\ndestination@example.com',
			'destination@example.com\t',
			'destination\u0000@example.com',
			'not-an-address',
			'one@@example.com',
			'.local@example.com',
			'local.@example.com',
			'local..part@example.com'
		]) {
			assert.throws(() => normalizeForwardingDestination(value), /valid external email address/);
		}
	});

	test('rejects an overlong destination', () => {
		const local = 'a'.repeat(65);
		assert.throws(
			() => normalizeForwardingDestination(`${local}@example.com`),
			/valid external email address/
		);
	});

	test('verification token is random, hashable, and time-bounded', async () => {
		const first = await createVerificationToken();
		const second = await createVerificationToken();

		assert.notEqual(first.token, second.token);
		assert.equal(first.token.length > 32, true);
		assert.equal(first.tokenHash, await hashToken(first.token));
		assert.equal(first.expiresAt - first.createdAt, FORWARDING_VERIFICATION_TTL_MS);
		assert.equal(first.tokenHash.includes(first.token), false);
	});

	test('creates a pending destination and disabled rule for the owning address', async () => {
		const db = seedDb();
		const now = new Date('2026-08-24T01:00:00.000Z');
		const result = await createOrResetForwardingDestination(
			db.db(),
			'user-1',
			{ sourceAddressId: 'address-1', destination: '  inbox@outside.example ' },
			now
		);

		assert.equal(result.destination.destination_address, 'inbox@outside.example');
		assert.equal(result.destination.status, 'pending');
		assert.equal(result.rule.status, 'disabled');
		assert.ok(result.verificationToken);
		assert.equal(result.verificationTokenHash, await hashToken(result.verificationToken!));
		assert.equal(result.destination.verification_used_at, null);
	});

	test('verification is single-use and enabling requires verified destination', async () => {
		const db = seedDb();
		const result = await createOrResetForwardingDestination(
			db.db(),
			'user-1',
			{ sourceAddressId: 'address-1', destination: 'inbox@outside.example' },
			new Date('2026-08-24T01:00:00.000Z')
		);
		assert.ok(result.verificationToken);

		await assert.rejects(
			() => setForwardingRuleEnabled(db.db(), 'user-1', result.rule.id, true),
			ForwardingStateError
		);
		const verified = await verifyForwardingDestination(
			db.db(),
			result.verificationToken!,
			new Date('2026-08-24T02:00:00.000Z')
		);
		assert.equal(verified.destination.status, 'verified');
		assert.equal(verified.rule?.status, 'disabled');

		const enabled = await setForwardingRuleEnabled(db.db(), 'user-1', result.rule.id, true);
		assert.equal(enabled?.status, 'enabled');
		await assert.rejects(
			() => verifyForwardingDestination(db.db(), result.verificationToken!),
			(error: unknown) => error instanceof Error && error.message.includes('already used')
		);
	});

	test('expired verification tokens cannot enable a rule', async () => {
		const db = seedDb();
		const created = new Date('2026-08-24T01:00:00.000Z');
		const result = await createOrResetForwardingDestination(
			db.db(),
			'user-1',
			{ sourceAddressId: 'address-1', destination: 'expired@outside.example' },
			created
		);

		await assert.rejects(
			() =>
				verifyForwardingDestination(
					db.db(),
					result.verificationToken!,
					new Date(created.getTime() + FORWARDING_VERIFICATION_TTL_MS)
				),
			(error: unknown) => error instanceof Error && error.message.includes('expired')
		);
	});

	test('changing a destination invalidates verification and disables the rule', async () => {
		const db = seedDb();
		const first = await createOrResetForwardingDestination(db.db(), 'user-1', {
			sourceAddressId: 'address-1',
			destination: 'first@outside.example'
		});
		await verifyForwardingDestination(db.db(), first.verificationToken!);
		await setForwardingRuleEnabled(db.db(), 'user-1', first.rule.id, true);

		const changed = await createOrResetForwardingDestination(db.db(), 'user-1', {
			sourceAddressId: 'address-1',
			destination: 'second@outside.example'
		});
		assert.equal(changed.destination.status, 'pending');
		assert.equal(changed.rule.status, 'disabled');
		assert.notEqual(changed.verificationToken, first.verificationToken);
	});

	test('rule PATCH applies destination and enabled together, including enabled false', async () => {
		const db = seedDb();
		const initial = await createOrResetForwardingDestination(db.db(), 'user-1', {
			sourceAddressId: 'address-1',
			destination: 'same@outside.example'
		});
		await verifyForwardingDestination(db.db(), initial.verificationToken!);
		await setForwardingRuleEnabled(db.db(), 'user-1', initial.rule.id, true);

		const disabledResponse = await patchForwardingRule({
			params: { id: initial.rule.id },
			request: new Request('https://quickmail.example/api/forwarding/rules/rule-1', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ destination: 'same@outside.example', enabled: false })
			}),
			locals: { user: { id: 'user-1', name: 'Owner' } },
			platform: { env: { DB: db.db() } },
			url: new URL('https://quickmail.example/api/forwarding/rules/rule-1')
		} as Parameters<typeof patchForwardingRule>[0]);
		assert.equal(disabledResponse.status, 200);
		assert.equal((await disabledResponse.json()).rule.status, 'disabled');

		const enabledResponse = await patchForwardingRule({
			params: { id: initial.rule.id },
			request: new Request('https://quickmail.example/api/forwarding/rules/rule-1', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ destination: 'same@outside.example', enabled: true })
			}),
			locals: { user: { id: 'user-1', name: 'Owner' } },
			platform: { env: { DB: db.db() } },
			url: new URL('https://quickmail.example/api/forwarding/rules/rule-1')
		} as Parameters<typeof patchForwardingRule>[0]);
		assert.equal(enabledResponse.status, 200);
		assert.equal((await enabledResponse.json()).rule.status, 'enabled');
	});

	test('verification sends use token-specific idempotency keys on both routes', async () => {
		const db = seedDb();
		const keys: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input, init) => {
			keys.push(new Headers(init?.headers).get('Idempotency-Key') ?? '');
			return new Response(JSON.stringify({ id: `resend-${keys.length}` }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as typeof fetch;

		try {
			const postResponse = await createForwardingDestinationRoute({
				request: new Request('https://quickmail.example/api/forwarding/destinations', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						sourceAddressId: 'address-1',
						destination: 'first@outside.example'
					})
				}),
				locals: { user: { id: 'user-1', name: 'Owner' } },
				platform: {
					env: { DB: db.db(), RESEND_API_KEY: 're_test', RESEND_SEND_DOMAINS: 'quickmail.example' }
				},
				url: new URL('https://quickmail.example/api/forwarding/destinations')
			} as Parameters<typeof createForwardingDestinationRoute>[0]);
			assert.equal(postResponse.status, 201);

			const ruleId = String([...db.rules.values()][0].id);
			const patchResponse = await patchForwardingRule({
				params: { id: ruleId },
				request: new Request(`https://quickmail.example/api/forwarding/rules/${ruleId}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ destination: 'second@outside.example' })
				}),
				locals: { user: { id: 'user-1', name: 'Owner' } },
				platform: {
					env: { DB: db.db(), RESEND_API_KEY: 're_test', RESEND_SEND_DOMAINS: 'quickmail.example' }
				},
				url: new URL(`https://quickmail.example/api/forwarding/rules/${ruleId}`)
			} as Parameters<typeof patchForwardingRule>[0]);
			assert.equal(patchResponse.status, 200);
			assert.equal(keys.length, 2);
			assert.notEqual(keys[0], keys[1]);
			assert.match(keys[0], /^forwarding-verification:[^:]+:[A-Za-z0-9+/=]{40,}$/);
			assert.match(keys[1], /^forwarding-verification:[^:]+:[A-Za-z0-9+/=]{40,}$/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('revalidates a managed domain added after destination verification', async () => {
		const db = seedDb();
		const result = await createOrResetForwardingDestination(db.db(), 'user-1', {
			sourceAddressId: 'address-1',
			destination: 'later@outside.example'
		});
		await verifyForwardingDestination(db.db(), result.verificationToken!);
		db.domains.set('domain-later', {
			id: 'domain-later',
			name: 'outside.example',
			status: 'verified',
			region: null,
			sending_enabled: 1,
			receiving_enabled: 1,
			catchall_user_id: null,
			created_at: '2026-08-24T00:00:00.000Z',
			synced_at: null
		});

		await assert.rejects(
			() => setForwardingRuleEnabled(db.db(), 'user-1', result.rule.id, true),
			(error: unknown) =>
				error instanceof ForwardingValidationError &&
				error.message === 'Destination must be outside Noroshi domains'
		);
		assert.equal(
			(await getForwardingRuleForUser(db.db(), 'user-1', result.rule.id))?.status,
			'disabled'
		);
	});

	test('revalidates an owned address added after destination verification', async () => {
		const db = seedDb();
		const result = await createOrResetForwardingDestination(db.db(), 'user-1', {
			sourceAddressId: 'address-1',
			destination: 'later@another.example'
		});
		await verifyForwardingDestination(db.db(), result.verificationToken!);
		db.addresses.set('address-later', {
			id: 'address-later',
			user_id: 'user-1',
			domain_id: 'domain-later',
			domain_name: 'another.example',
			address: 'later@another.example',
			label: null,
			is_default: 0,
			signature: null,
			created_at: '2026-08-24T00:00:00.000Z'
		});

		await assert.rejects(
			() => setForwardingRuleEnabled(db.db(), 'user-1', result.rule.id, true),
			(error: unknown) =>
				error instanceof ForwardingValidationError &&
				error.message === 'Destination must be outside Noroshi domains'
		);
		assert.equal(
			(await getForwardingRuleForUser(db.db(), 'user-1', result.rule.id))?.status,
			'disabled'
		);
	});

	test('rejects managed-domain and self destinations and keeps tenants isolated', async () => {
		const db = seedDb();
		await assert.rejects(
			() =>
				createOrResetForwardingDestination(db.db(), 'user-1', {
					sourceAddressId: 'address-1',
					destination: 'other@quickmail.example'
				}),
			ForwardingValidationError
		);
		await assert.rejects(
			() =>
				createOrResetForwardingDestination(db.db(), 'user-2', {
					sourceAddressId: 'address-2',
					destination: 'other@outside.example'
				}),
			ForwardingValidationError
		);
		assert.equal(await getForwardingDestinationForUser(db.db(), 'user-2', 'address-1'), null);
		assert.equal(await getForwardingRuleForUser(db.db(), 'user-2', 'rule-unknown'), null);
	});

	test('attempts are unique per rule and email and enforce shared ownership', async () => {
		const db = seedDb();
		const result = await createOrResetForwardingDestination(db.db(), 'user-1', {
			sourceAddressId: 'address-1',
			destination: 'inbox@outside.example'
		});
		db.emails.set('email-1', {
			id: 'email-1',
			user_id: 'user-1',
			provider_id: 'cf-1',
			direction: 'inbound',
			to_addr: 'info@quickmail.example'
		});
		db.emails.set('email-2', {
			id: 'email-2',
			user_id: 'user-2',
			provider_id: 'cf-2',
			direction: 'inbound',
			to_addr: 'other@quickmail.example'
		});

		const first = await createForwardingAttempt(db.db(), {
			ruleId: result.rule.id,
			emailId: 'email-1',
			providerId: 'cf-1'
		});
		const retry = await createForwardingAttempt(db.db(), {
			ruleId: result.rule.id,
			emailId: 'email-1',
			providerId: 'cf-1'
		});
		assert.equal(first.id, retry.id);
		await assert.rejects(
			() =>
				createForwardingAttempt(db.db(), {
					ruleId: result.rule.id,
					emailId: 'email-2'
				}),
			ForwardingStateError
		);
		db.emails.set('email-outbound', {
			id: 'email-outbound',
			user_id: 'user-1',
			provider_id: 'outbound-1',
			direction: 'outbound',
			to_addr: 'info@quickmail.example'
		});
		db.emails.set('email-wrong-recipient', {
			id: 'email-wrong-recipient',
			user_id: 'user-1',
			provider_id: 'inbound-2',
			direction: 'inbound',
			to_addr: 'other@quickmail.example'
		});
		await assert.rejects(
			() =>
				createForwardingAttempt(db.db(), {
					ruleId: result.rule.id,
					emailId: 'email-outbound'
				}),
			ForwardingStateError
		);
		await assert.rejects(
			() =>
				createForwardingAttempt(db.db(), {
					ruleId: result.rule.id,
					emailId: 'email-wrong-recipient'
				}),
			ForwardingStateError
		);
	});

	test('due attempts require enabled rules, a schedule, and fewer than four claims', async () => {
		const db = seedDb();
		const createdAt = new Date('2026-08-24T01:00:00.000Z');
		const result = await createOrResetForwardingDestination(db.db(), 'user-1', {
			sourceAddressId: 'address-1',
			destination: 'inbox@outside.example'
		});
		db.emails.set('email-due', {
			id: 'email-due',
			user_id: 'user-1',
			provider_id: 'inbound-due',
			direction: 'inbound',
			to_addr: 'info@quickmail.example'
		});
		const attempt = await createForwardingAttempt(db.db(), {
			ruleId: result.rule.id,
			emailId: 'email-due',
			now: createdAt
		});

		assert.deepEqual(
			await listDueForwardingAttempts(db.db(), new Date('2026-08-24T02:00:00.000Z')),
			[]
		);
		await verifyForwardingDestination(db.db(), result.verificationToken!, createdAt);
		await setForwardingRuleEnabled(db.db(), 'user-1', result.rule.id, true, createdAt);
		assert.deepEqual(
			(await listDueForwardingAttempts(db.db(), new Date('2026-08-24T02:00:00.000Z'))).map(
				(value) => value.id
			),
			[attempt.id]
		);
		await updateForwardingAttempt(db.db(), {
			id: attempt.id,
			status: 'sent',
			attemptCount: 0,
			nextAttemptAt: '2026-08-24T01:30:00.000Z',
			now: createdAt
		});
		assert.deepEqual(
			await listDueForwardingAttempts(db.db(), new Date('2026-08-24T02:00:00.000Z')),
			[]
		);
		await updateForwardingAttempt(db.db(), {
			id: attempt.id,
			status: 'failed',
			attemptCount: 0,
			nextAttemptAt: '2026-08-24T01:30:00.000Z',
			now: createdAt
		});

		await setForwardingRuleEnabled(db.db(), 'user-1', result.rule.id, false, createdAt);
		assert.deepEqual(
			await listDueForwardingAttempts(db.db(), new Date('2026-08-24T02:00:00.000Z')),
			[]
		);

		await setForwardingRuleEnabled(db.db(), 'user-1', result.rule.id, true, createdAt);
		await updateForwardingAttempt(db.db(), {
			id: attempt.id,
			status: 'failed',
			attemptCount: 3,
			nextAttemptAt: '2026-08-24T01:30:00.000Z',
			now: createdAt
		});
		assert.deepEqual(
			(await listDueForwardingAttempts(db.db(), new Date('2026-08-24T02:00:00.000Z'))).map(
				(value) => value.id
			),
			[attempt.id]
		);

		await updateForwardingAttempt(db.db(), {
			id: attempt.id,
			status: 'failed',
			attemptCount: 4,
			nextAttemptAt: '2026-08-24T01:30:00.000Z',
			now: createdAt
		});
		assert.deepEqual(
			await listDueForwardingAttempts(db.db(), new Date('2026-08-24T02:00:00.000Z')),
			[]
		);

		await updateForwardingAttempt(db.db(), {
			id: attempt.id,
			status: 'failed',
			attemptCount: 2,
			nextAttemptAt: null,
			now: createdAt
		});
		assert.deepEqual(
			await listDueForwardingAttempts(db.db(), new Date('2026-08-24T02:00:00.000Z')),
			[]
		);
	});

	test('attempt updates retain provider ids for webhook correlation', async () => {
		const db = seedDb();
		const result = await createOrResetForwardingDestination(db.db(), 'user-1', {
			sourceAddressId: 'address-1',
			destination: 'inbox@outside.example'
		});
		db.emails.set('email-provider', {
			id: 'email-provider',
			user_id: 'user-1',
			provider_id: 'inbound-provider',
			direction: 'inbound',
			to_addr: 'info@quickmail.example'
		});
		const attempt = await createForwardingAttempt(db.db(), {
			ruleId: result.rule.id,
			emailId: 'email-provider'
		});

		const updated = await updateForwardingAttempt(db.db(), {
			id: attempt.id,
			status: 'sent',
			attemptCount: 1,
			providerId: 'resend-forward-123',
			nextAttemptAt: null
		});
		assert.equal(updated?.provider_id, 'resend-forward-123');
		assert.equal(
			(await getForwardingAttemptByProviderId(db.db(), 'resend-forward-123'))?.id,
			attempt.id
		);
		const retained = await updateForwardingAttempt(db.db(), {
			id: attempt.id,
			status: 'sent',
			attemptCount: 1,
			nextAttemptAt: null
		});
		assert.equal(retained?.provider_id, 'resend-forward-123');
	});
});
