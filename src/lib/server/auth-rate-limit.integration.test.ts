import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { Database } from 'bun:sqlite';
import type { D1Database } from '@cloudflare/workers-types';
import {
	claimSetupBootstrap,
	consumeAuthRateLimit,
	pruneAuthRateLimits,
	releaseSetupBootstrap,
	resetAuthRateLimit
} from './auth-rate-limit';
import { finalizeSetup } from './setup-finalize';

class SqliteD1 {
	readonly db = new Database(':memory:');
	expireBeforeStatement: number | null = null;
	constructor() {
		const directory = new URL('../../../migrations/', import.meta.url);
		for (const name of readdirSync(directory)
			.filter((name) => name.endsWith('.sql'))
			.sort()) {
			this.db.exec(readFileSync(new URL(name, directory), 'utf8'));
		}
	}
	prepare(sql: string) {
		return new SqliteStatement(this.db, sql);
	}
	async batch(statements: SqliteStatement[]) {
		const transaction = (
			this.db as unknown as { transaction<T>(callback: () => T): () => T }
		).transaction(() =>
			statements.map((statement, index) => {
				if (this.expireBeforeStatement === index) {
					this.db.query("UPDATE setup_bootstrap_claim SET expires_at='2000-01-01'").run();
				}
				return statement.execute();
			})
		);
		return transaction();
	}
}

class SqliteStatement {
	private args: unknown[] = [];
	constructor(
		private readonly db: Database,
		private readonly sql: string
	) {}
	bind(...args: unknown[]) {
		this.args = args;
		return this;
	}
	async first<T>(): Promise<T | null> {
		return (this.db.query(this.sql).get(...this.args) as T | undefined) ?? null;
	}
	async run(): Promise<{ meta: { changes: number } }> {
		return this.execute();
	}
	execute(): { meta: { changes: number } } {
		const result = this.db.query(this.sql).run(...this.args);
		return { meta: { changes: result.changes ?? 0 } };
	}
}

function d1(value: SqliteD1): D1Database {
	return value as unknown as D1Database;
}

describe('D1 auth throttling', () => {
	const pepper = 'integration-rate-limit-secret-at-least-32-bytes';
	test('grants exactly one durable first-admin bootstrap claim', async () => {
		const sqlite = new SqliteD1();
		const results = await Promise.all(
			Array.from({ length: 5 }, () => claimSetupBootstrap(d1(sqlite)))
		);
		assert.equal(results.filter(Boolean).length, 1);
		await releaseSetupBootstrap(d1(sqlite), results.find(Boolean)!);
		assert.ok(await claimSetupBootstrap(d1(sqlite)));
	});

	test('reclaims only an expired bootstrap lease and rejects an old owner release', async () => {
		const sqlite = new SqliteD1();
		const first = await claimSetupBootstrap(d1(sqlite), new Date('2026-08-29T00:00:00Z'));
		assert.ok(first);
		assert.equal(await claimSetupBootstrap(d1(sqlite), new Date('2026-08-29T00:09:59Z')), null);
		const replacement = await claimSetupBootstrap(d1(sqlite), new Date('2026-08-29T00:10:00Z'));
		assert.ok(replacement);
		await releaseSetupBootstrap(d1(sqlite), first!);
		assert.equal(
			(
				sqlite.db.query('SELECT lease_token FROM setup_bootstrap_claim').get() as {
					lease_token: string;
				}
			).lease_token,
			replacement
		);
	});

	test('fences the complete setup mutation batch from a stale lease owner', async () => {
		const sqlite = new SqliteD1();
		const now = new Date();
		const old = await claimSetupBootstrap(d1(sqlite), new Date(now.getTime() - 11 * 60 * 1000));
		assert.ok(old);
		const current = await claimSetupBootstrap(d1(sqlite), now);
		assert.ok(current);
		await assert.rejects(() =>
			finalizeSetup(d1(sqlite), old!, {
				domain: {
					id: 'domain-1',
					name: 'example.com',
					status: 'verified',
					sendingEnabled: true,
					receivingEnabled: true
				},
				localPart: 'info',
				name: 'Owner',
				password: 'long-password'
			})
		);
		assert.equal(
			(sqlite.db.query('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count,
			0
		);
		assert.equal(
			(sqlite.db.query('SELECT COUNT(*) AS count FROM domains').get() as { count: number }).count,
			0
		);
	});

	test('rolls back earlier setup writes when the lease becomes stale inside the D1 batch', async () => {
		const sqlite = new SqliteD1();
		const token = await claimSetupBootstrap(d1(sqlite));
		assert.ok(token);
		sqlite.expireBeforeStatement = 3;
		await assert.rejects(() =>
			finalizeSetup(d1(sqlite), token!, {
				domain: {
					id: 'd',
					name: 'example.com',
					status: 'verified',
					sendingEnabled: true,
					receivingEnabled: true
				},
				localPart: 'info',
				name: 'Owner',
				password: 'long-password'
			})
		);
		for (const table of ['users', 'domains', 'addresses']) {
			assert.equal(
				(sqlite.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
					.count,
				0
			);
		}
	});

	test('reuses one exact partial domain row after a fenced failure and preserves its id', async () => {
		const sqlite = new SqliteD1();
		sqlite.db
			.query(
				`INSERT INTO domains (id,name,status,sending_enabled,receiving_enabled)
				 VALUES ('stored-domain-id','Example.COM','pending',0,1)`
			)
			.run();
		const now = new Date();
		const stale = await claimSetupBootstrap(d1(sqlite), new Date(now.getTime() - 11 * 60 * 1000));
		assert.ok(stale);
		const current = await claimSetupBootstrap(d1(sqlite), now);
		assert.ok(current);
		const input = {
			domain: {
				id: 'provider-domain-id',
				name: 'example.com',
				status: 'verified',
				sendingEnabled: true,
				receivingEnabled: true
			},
			localPart: 'info',
			name: 'Owner',
			password: 'long-password'
		};
		await assert.rejects(() => finalizeSetup(d1(sqlite), stale!, input));
		await finalizeSetup(d1(sqlite), current!, input);
		assert.deepEqual(sqlite.db.query('SELECT id,name FROM domains').all(), [
			{ id: 'stored-domain-id', name: 'example.com' }
		]);
		assert.equal(
			(sqlite.db.query('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count,
			1
		);
		assert.equal(
			(sqlite.db.query('SELECT domain_id FROM addresses').get() as { domain_id: string }).domain_id,
			'stored-domain-id'
		);
	});

	test('rejects a partial domain for another name before creating a user', async () => {
		const sqlite = new SqliteD1();
		sqlite.db
			.query(
				`INSERT INTO domains (id,name,status,sending_enabled,receiving_enabled)
				 VALUES ('domain-1','other.example','pending',0,1)`
			)
			.run();
		const token = await claimSetupBootstrap(d1(sqlite));
		assert.ok(token);
		await assert.rejects(
			() =>
				finalizeSetup(d1(sqlite), token!, {
					domain: {
						id: 'domain-2',
						name: 'example.com',
						status: 'verified',
						sendingEnabled: true,
						receivingEnabled: true
					},
					localPart: 'info',
					name: 'Owner',
					password: 'long-password'
				}),
			/does not match/
		);
		assert.equal(
			(sqlite.db.query('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count,
			0
		);
	});

	test('rejects ambiguous partial domains and an already-created user', async () => {
		const ambiguous = new SqliteD1();
		ambiguous.db.exec(`
			INSERT INTO domains (id,name,status,sending_enabled,receiving_enabled) VALUES
			 ('domain-1','example.com','pending',0,1),
			 ('domain-2','other.example','pending',0,1);
		`);
		const ambiguousToken = await claimSetupBootstrap(d1(ambiguous));
		assert.ok(ambiguousToken);
		const input = {
			domain: {
				id: 'domain-1',
				name: 'example.com',
				status: 'verified',
				sendingEnabled: true,
				receivingEnabled: true
			},
			localPart: 'info',
			name: 'Owner',
			password: 'long-password'
		};
		await assert.rejects(() => finalizeSetup(d1(ambiguous), ambiguousToken!, input));

		const completed = new SqliteD1();
		completed.db.exec(`
			INSERT INTO domains (id,name,status,sending_enabled,receiving_enabled)
			VALUES ('domain-1','example.com','verified',1,1);
			INSERT INTO users (id,email,name,password_hash,is_admin)
			VALUES ('user-1','owner@example.com','Owner','hash',1);
		`);
		const completedToken = await claimSetupBootstrap(d1(completed));
		assert.ok(completedToken);
		await assert.rejects(
			() => finalizeSetup(d1(completed), completedToken!, input),
			/already completed/
		);
		assert.equal(
			(completed.db.query('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count,
			1
		);
	});
	test('atomically bounds concurrent attempts without storing email or IP', async () => {
		const sqlite = new SqliteD1();
		const now = new Date('2026-08-29T00:00:00.000Z');
		const request = new Request('https://mail.example/api/auth/login', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': '203.0.113.4' }
		});
		const results = await Promise.all(
			Array.from({ length: 7 }, () =>
				consumeAuthRateLimit(d1(sqlite), 'login', request, 'owner@example.net', pepper, now)
			)
		);
		assert.equal(results.filter((result) => result.allowed).length, 5);
		assert.equal(results.filter((result) => !result.allowed).length, 2);
		const row = sqlite.db.query('SELECT key_hash, attempts FROM auth_rate_limits').get() as {
			key_hash: string;
			attempts: number;
		};
		assert.equal(row.attempts, 7);
		assert.doesNotMatch(row.key_hash, /owner|203\.0\.113\.4/);
		const otherPepper = await consumeAuthRateLimit(
			d1(sqlite),
			'login',
			request,
			'owner@example.net',
			'another-rate-limit-secret-at-least-32-bytes',
			now
		);
		assert.notEqual(otherPepper.keyHash, row.key_hash);
	});

	test('expires windows, supports success reset, and prunes retained hashes', async () => {
		const sqlite = new SqliteD1();
		const request = new Request('https://mail.example/api/setup', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': '198.51.100.2' }
		});
		const first = await consumeAuthRateLimit(
			d1(sqlite),
			'setup',
			request,
			'bootstrap',
			pepper,
			new Date('2026-08-29T00:00:00.000Z')
		);
		assert.equal(first.allowed, true);
		const expired = await consumeAuthRateLimit(
			d1(sqlite),
			'setup',
			request,
			'bootstrap',
			pepper,
			new Date('2026-08-29T00:31:00.000Z')
		);
		assert.equal(expired.attempts, 1);
		await resetAuthRateLimit(d1(sqlite), expired.keyHash);
		assert.equal(
			(sqlite.db.query('SELECT COUNT(*) AS count FROM auth_rate_limits').get() as { count: number })
				.count,
			0
		);

		await consumeAuthRateLimit(
			d1(sqlite),
			'login',
			request,
			'old@example.net',
			pepper,
			new Date('2026-08-27T00:00:00.000Z')
		);
		await pruneAuthRateLimits(d1(sqlite), new Date('2026-08-29T00:00:00.000Z'));
		assert.equal(
			(sqlite.db.query('SELECT COUNT(*) AS count FROM auth_rate_limits').get() as { count: number })
				.count,
			0
		);
	});
});
