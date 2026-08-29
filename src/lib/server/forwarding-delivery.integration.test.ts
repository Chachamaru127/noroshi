import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { Database } from 'bun:sqlite';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { EmailProvider } from './email-provider';
import { ProviderError } from './email-provider';
import {
	claimForwardingAttempt,
	createForwardingAttempt,
	finishForwardingAttempt
} from './forwarding';
import {
	deliverForwardingAttempt,
	enqueueAndScheduleForwarding,
	enqueueForwardingForStoredEmail,
	reconcileSavedForwardingEmails,
	runScheduledForwarding,
	type ForwardingDeliveryEnv
} from './forwarding-delivery';
import { createResendWebhookInboundEnv } from './inbound';
import { emailExistsByProviderId, insertEmail } from './mail-store';

class SqliteD1 {
	readonly db = new Database(':memory:');
	failNextFinish = false;

	constructor(untilMigration?: string) {
		const directory = new URL('../../../migrations/', import.meta.url);
		for (const name of readdirSync(directory)
			.filter((name) => name.endsWith('.sql'))
			.filter((name) => !untilMigration || name < untilMigration)
			.sort()) {
			this.db.exec(readFileSync(new URL(name, directory), 'utf8'));
		}
	}

	applyMigration(name: string) {
		this.db.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'));
	}

	prepare(sql: string) {
		return new SqliteStatement(this, sql);
	}
}

class SqliteStatement {
	private args: unknown[] = [];
	constructor(
		private readonly owner: SqliteD1,
		private readonly sql: string
	) {}
	bind(...args: unknown[]) {
		this.args = args;
		return this;
	}
	async first<T>(): Promise<T | null> {
		return (this.owner.db.query(this.sql).get(...this.args) as T | undefined) ?? null;
	}
	async all<T>(): Promise<{ results: T[] }> {
		return { results: this.owner.db.query(this.sql).all(...this.args) as T[] };
	}
	async run(): Promise<{ meta: { changes: number } }> {
		if (
			this.owner.failNextFinish &&
			this.sql.includes('UPDATE forwarding_attempts') &&
			this.sql.includes("status = 'processing' AND lease_token")
		) {
			this.owner.failNextFinish = false;
			throw new Error('finish_write_failed');
		}
		const result = this.owner.db.query(this.sql).run(...this.args);
		return { meta: { changes: result.changes ?? 0 } };
	}
}

function d1(db: SqliteD1): D1Database {
	return db as unknown as D1Database;
}

function seed(options: { attempt?: boolean; attachmentsReady?: boolean; hop?: number } = {}) {
	const db = new SqliteD1();
	const now = '2026-08-25T01:00:00.000Z';
	db.db.exec(`
		PRAGMA foreign_keys=ON;
		INSERT INTO users (id,email,name,password_hash) VALUES ('u','owner@example.net','Owner','hash');
		INSERT INTO domains (id,name,status,sending_enabled,receiving_enabled)
		VALUES ('domain','quickmail.example','verified',1,1);
		INSERT INTO addresses (id,user_id,domain_id,address,is_default,created_at)
		VALUES ('address','u','domain','info@quickmail.example',1,'${now}');
		INSERT INTO forwarding_destinations
		(id,user_id,source_address_id,destination_address,status,created_at,updated_at)
		VALUES ('destination','u','address','archive@outside.example','verified','${now}','${now}');
		INSERT INTO forwarding_rules
		(id,user_id,source_address_id,destination_id,status,enabled_at,created_at,updated_at)
		VALUES ('rule','u','address','destination','enabled','${now}','${now}','${now}');
		INSERT INTO emails
		(id,user_id,direction,from_addr,to_addr,subject,body_text,forwarding_hop,attachments_ready,created_at)
		VALUES ('email','u','inbound','sender@example.net','info@quickmail.example','Hello','Body',${options.hop ?? 0},${options.attachmentsReady === false ? 0 : 1},'${now}');
	`);
	if (options.attempt !== false) {
		db.db.exec(`
			INSERT INTO forwarding_attempts
			(id,rule_id,email_id,status,attempt_count,next_attempt_at,hop,destination_id,destination_address,created_at,updated_at)
			VALUES ('attempt','rule','email','queued',0,'${now}',${options.hop ?? 0},'destination','archive@outside.example','${now}','${now}');
		`);
	}
	return db;
}

function bucket(value: Uint8Array | null, onGet?: () => void): R2Bucket {
	return {
		get: async () => {
			onGet?.();
			return value ? ({ arrayBuffer: async () => value.buffer.slice(0) } as never) : null;
		}
	} as unknown as R2Bucket;
}

function provider(send: EmailProvider['send']): EmailProvider {
	return {
		kind: 'resend',
		send,
		listDomains: async () => [],
		getDomain: async () => ({
			id: 'domain',
			name: 'quickmail.example',
			status: 'verified',
			region: null,
			sendingEnabled: true,
			receivingEnabled: false
		})
	};
}

function env(db: SqliteD1, attachments = bucket(null)): ForwardingDeliveryEnv {
	return { DB: d1(db), ATTACHMENTS: attachments, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'test' };
}

describe('automatic forwarding MVP D1 integration', () => {
	test('Resend webhook env schedules the immediate forwarding attempt', async () => {
		const db = seed({ attempt: false });
		const scheduled: Promise<unknown>[] = [];
		const mapped = createResendWebhookInboundEnv({
			env: {
				DB: d1(db),
				ATTACHMENTS: bucket(null),
				EMAIL_PROVIDER: 'resend',
				RESEND_API_KEY: 'test-key',
				RESEND_SEND_DOMAINS: 'quickmail.example',
				FORWARDING_KILL_SWITCH: '0',
				FORWARDING_LEASE_MS: '30000'
			},
			ctx: { waitUntil: (promise: Promise<unknown>) => scheduled.push(promise) }
		} as unknown as App.Platform);
		const originalFetch = globalThis.fetch;
		let providerCalls = 0;
		globalThis.fetch = (async (input) => {
			assert.equal(String(input), 'https://api.resend.com/emails');
			providerCalls += 1;
			return new Response(JSON.stringify({ id: 're_immediate' }), { status: 200 });
		}) as typeof fetch;

		try {
			await enqueueAndScheduleForwarding(mapped, {
				userId: 'u',
				sourceAddressId: 'address',
				emailId: 'email',
				now: new Date('2026-08-25T01:00:00.000Z')
			});
			await Promise.all(scheduled);
			assert.equal(providerCalls, 1);
			assert.equal(
				db.db.query("SELECT status FROM forwarding_attempts WHERE email_id='email'").get<{
					status: string;
				}>()?.status,
				'sent'
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('backfills legacy Cloudflare raw delivery ids and scopes redelivery by recipient', async () => {
		const db = new SqliteD1('0014_provider_delivery_claims_mvp.sql');
		const raw = new TextEncoder().encode('Message-ID: legacy\r\n\r\nBody').buffer;
		const digest = await crypto.subtle.digest('SHA-256', raw);
		const providerId = `cf-${[...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')}`;
		db.db.exec(`
			INSERT INTO users (id,email,name,password_hash) VALUES ('u','owner@example.net','Owner','hash');
			INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,provider_id)
			VALUES ('legacy','u','inbound','sender@example.net','first@example.net','Legacy','${providerId}');
		`);
		db.applyMigration('0014_provider_delivery_claims_mvp.sql');

		assert.equal(await emailExistsByProviderId(d1(db), providerId, 'FIRST@example.net'), true);
		assert.equal(await emailExistsByProviderId(d1(db), providerId, 'second@example.net'), false);
	});

	test('fresh migrations contain only the lean schema and recipient-scoped inbound identity', () => {
		const db = new SqliteD1();
		const tables = db.db
			.query("SELECT name FROM sqlite_master WHERE type='table'")
			.all<{ name: string }>()
			.map((row) => row.name);
		assert.equal(tables.includes('provider_delivery_claims'), true);
		assert.equal(
			tables.some((name) => name.includes('quota')),
			false
		);
		const columns = db.db
			.query('PRAGMA table_info(forwarding_attempts)')
			.all<{ name: string }>()
			.map((row) => row.name);
		for (const forbidden of ['provider_calls', 'provider_started_at', 'pre_provider_failures']) {
			assert.equal(columns.includes(forbidden), false);
		}

		db.db.exec(`
			INSERT INTO users (id,email,name,password_hash) VALUES ('u','owner@example.net','Owner','hash');
			INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,provider_id)
			VALUES ('one','u','inbound','sender@example.net','first@example.net','One','provider-1');
		`);
		const duplicate = db.db
			.query(
				`INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,provider_id)
			        VALUES ('duplicate','u','inbound','sender@example.net','FIRST@example.net','Dup','provider-1')`
			)
			.run();
		const distinctRecipient = db.db
			.query(
				`INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,provider_id)
			        VALUES ('two','u','inbound','sender@example.net','second@example.net','Two','provider-1')`
			)
			.run();
		assert.equal(duplicate.changes, 0);
		assert.equal((distinctRecipient.changes ?? 0) > 0, true);
		assert.equal(
			db.db
				.query("SELECT count(*) AS n FROM emails WHERE provider_id='provider-1'")
				.get<{ n: number }>()?.n,
			2
		);
	});

	test('recipient-scoped provider precheck accepts the same delivery id for another recipient', async () => {
		const db = new SqliteD1();
		db.db.exec(`
			INSERT INTO users (id,email,name,password_hash) VALUES ('u','owner@example.net','Owner','hash');
			INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,provider_id)
			VALUES ('one','u','inbound','sender@example.net','first@example.net','One','provider-1');
		`);
		assert.equal(await emailExistsByProviderId(d1(db), 'provider-1', 'first@example.net'), true);
		assert.equal(await emailExistsByProviderId(d1(db), 'provider-1', 'second@example.net'), false);
		db.db.exec(`
			INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,provider_id)
			VALUES ('two','u','inbound','sender@example.net','second@example.net','Two','provider-1');
		`);
		assert.equal(await emailExistsByProviderId(d1(db), 'provider-1', 'second@example.net'), true);
	});

	test('enabling a rule never forwards historical mail and reconciliation starts at enabled_at', async () => {
		const db = seed({ attempt: false });
		db.db.exec(`
			UPDATE forwarding_rules SET enabled_at='2026-08-25T01:00:00.800Z' WHERE id='rule';
			DELETE FROM emails WHERE id='email';
		`);
		const historicalId = await insertEmail(d1(db), {
			userId: 'u',
			direction: 'inbound',
			from: 'sender@example.net',
			to: 'info@quickmail.example',
			subject: 'Historical',
			createdAt: new Date('2026-08-25T01:00:00.700Z')
		});
		assert.deepEqual(
			db.db.query('SELECT created_at FROM emails WHERE id=?').get(historicalId) as {
				created_at: string;
			},
			{ created_at: '2026-08-25T01:00:00.700Z' }
		);
		assert.equal(await reconcileSavedForwardingEmails(d1(db)), 0);
		assert.equal(
			await enqueueForwardingForStoredEmail(env(db), {
				userId: 'u',
				sourceAddressId: 'address',
				emailId: historicalId
			}),
			null
		);

		const newEmailId = await insertEmail(d1(db), {
			userId: 'u',
			direction: 'inbound',
			from: 'sender@example.net',
			to: 'info@quickmail.example',
			subject: 'New',
			createdAt: new Date('2026-08-25T01:00:00.900Z')
		});
		assert.deepEqual(
			db.db.query('SELECT created_at FROM emails WHERE id=?').get(newEmailId) as {
				created_at: string;
			},
			{ created_at: '2026-08-25T01:00:00.900Z' }
		);
		assert.equal(await reconcileSavedForwardingEmails(d1(db)), 1);
		assert.deepEqual(
			db.db
				.query('SELECT email_id FROM forwarding_attempts ORDER BY email_id')
				.all<{ email_id: string }>(),
			[{ email_id: newEmailId }]
		);
	});

	test('enqueue and cron reconciliation create one tenant-scoped job and skip loop markers', async () => {
		const db = seed({ attempt: false });
		const first = await enqueueForwardingForStoredEmail(env(db), {
			userId: 'u',
			sourceAddressId: 'address',
			emailId: 'email'
		});
		const second = await enqueueForwardingForStoredEmail(env(db), {
			userId: 'u',
			sourceAddressId: 'address',
			emailId: 'email'
		});
		assert.equal(first?.id, second?.id);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM forwarding_attempts').get<{ n: number }>()?.n,
			1
		);

		db.db.exec(
			"DELETE FROM forwarding_attempts; UPDATE emails SET forwarding_hop=1 WHERE id='email'"
		);
		assert.equal(await reconcileSavedForwardingEmails(d1(db)), 0);
		db.db.exec("UPDATE emails SET forwarding_hop=0 WHERE id='email'");
		assert.equal(await reconcileSavedForwardingEmails(d1(db)), 1);

		db.db.exec(`
			INSERT INTO users (id,email,name,password_hash) VALUES ('other','other@example.net','Other','hash');
			INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject)
			VALUES ('foreign','other','inbound','sender@example.net','info@quickmail.example','Foreign');
		`);
		await assert.rejects(
			createForwardingAttempt(d1(db), { ruleId: 'rule', emailId: 'foreign' }),
			/owner/
		);
	});

	test('one worker wins, stale finish is a no-op, and an expired lease consumes the next claim', async () => {
		const db = seed();
		const now = new Date('2026-08-25T01:00:00.000Z');
		const [one, two] = await Promise.all([
			claimForwardingAttempt(d1(db), { id: 'attempt', leaseToken: 'one', now }),
			claimForwardingAttempt(d1(db), { id: 'attempt', leaseToken: 'two', now })
		]);
		assert.equal([one, two].filter(Boolean).length, 1);
		const winner = one ?? two!;
		await finishForwardingAttempt(d1(db), {
			id: 'attempt',
			leaseToken: 'stale',
			status: 'sent',
			now
		});
		assert.equal(
			db.db
				.query("SELECT status FROM forwarding_attempts WHERE id='attempt'")
				.get<{ status: string }>()?.status,
			'processing'
		);
		db.db.exec(
			"UPDATE forwarding_attempts SET lease_expires_at='2026-08-25T00:59:00.000Z' WHERE id='attempt'"
		);
		const reclaimed = await claimForwardingAttempt(d1(db), {
			id: 'attempt',
			leaseToken: 'reclaimed',
			now
		});
		assert.equal(winner.attempt_count, 1);
		assert.equal(reclaimed?.attempt_count, 2);
	});

	test('permits four total claims and refuses a fifth', async () => {
		const db = seed();
		for (let claimNo = 1; claimNo <= 4; claimNo += 1) {
			const now = new Date(`2026-08-25T01:0${claimNo}:00.000Z`);
			const claim = await claimForwardingAttempt(d1(db), {
				id: 'attempt',
				leaseToken: `lease-${claimNo}`,
				now
			});
			assert.equal(claim?.attempt_count, claimNo);
			db.db.exec(
				`UPDATE forwarding_attempts SET lease_expires_at='2026-08-25T00:00:00.000Z' WHERE id='attempt'`
			);
		}
		assert.equal(
			await claimForwardingAttempt(d1(db), {
				id: 'attempt',
				leaseToken: 'lease-5',
				now: new Date('2026-08-25T02:00:00.000Z')
			}),
			null
		);
		assert.deepEqual(
			db.db
				.query(
					"SELECT status, attempt_count, error_code FROM forwarding_attempts WHERE id='attempt'"
				)
				.get<{ status: string; attempt_count: number; error_code: string }>(),
			{ status: 'failed', attempt_count: 4, error_code: 'lease_expired' }
		);
	});

	for (const mode of ['disabled', 'replaced'] as const) {
		test(`cron terminalizes an exhausted lease after the rule is ${mode}`, async () => {
			const db = seed();
			db.db.exec(`
				UPDATE forwarding_attempts
				SET status='processing', attempt_count=4, lease_token='dead', lease_expires_at='2026-08-25T00:59:00.000Z'
				WHERE id='attempt';
			`);
			if (mode === 'disabled') {
				db.db.exec(
					"UPDATE forwarding_rules SET status='disabled', enabled_at=NULL WHERE id='rule'"
				);
			} else {
				db.db.exec(`
					INSERT INTO forwarding_destinations
					(id,user_id,source_address_id,destination_address,status,created_at,updated_at)
					VALUES ('new-destination','u','address','new@outside.example','verified','2026-08-25T01:00:00.000Z','2026-08-25T01:00:00.000Z');
					UPDATE forwarding_rules SET destination_id='new-destination' WHERE id='rule';
				`);
			}
			await runScheduledForwarding(
				{ ...env(db), FORWARDING_KILL_SWITCH: '1' },
				new Date('2026-08-25T01:01:00.000Z'),
				() => new Date('2026-08-25T01:01:00.000Z')
			);
			assert.deepEqual(
				db.db
					.query("SELECT status,error_code,lease_token FROM forwarding_attempts WHERE id='attempt'")
					.get<{ status: string; error_code: string; lease_token: string | null }>(),
				{ status: 'failed', error_code: 'lease_expired', lease_token: null }
			);
		});
	}

	test('scheduled delivery takes a fresh clock value for each claim', async () => {
		const db = seed();
		db.db.exec(`
			INSERT INTO emails
			(id,user_id,direction,from_addr,to_addr,subject,body_text,forwarding_hop,attachments_ready,created_at)
			VALUES ('email-two','u','inbound','sender@example.net','info@quickmail.example','Second','Body',0,1,'2026-08-25T01:00:00.100Z');
			INSERT INTO forwarding_attempts
			(id,rule_id,email_id,status,attempt_count,next_attempt_at,hop,destination_id,destination_address,created_at,updated_at)
			VALUES ('attempt-two','rule','email-two','queued',0,'2026-08-25T01:00:00.100Z',0,'destination','archive@outside.example','2026-08-25T01:00:00.100Z','2026-08-25T01:00:00.100Z');
		`);
		const times = [
			new Date('2026-08-25T01:02:00.000Z'),
			new Date('2026-08-25T01:02:01.000Z'),
			new Date('2026-08-25T01:02:02.000Z')
		];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ id: crypto.randomUUID() }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})) as typeof fetch;
		try {
			const result = await runScheduledForwarding(
				env(db),
				new Date('2026-08-25T01:02:00.000Z'),
				() => times.shift()!
			);
			assert.equal(result.processed, 2);
			assert.deepEqual(
				db.db
					.query('SELECT updated_at FROM forwarding_attempts ORDER BY updated_at')
					.all<{ updated_at: string }>(),
				[{ updated_at: '2026-08-25T01:02:01.000Z' }, { updated_at: '2026-08-25T01:02:02.000Z' }]
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('sends saved attachments with a stable key and reuses it after finish failure', async () => {
		const db = seed();
		db.db.exec(`INSERT INTO email_attachments
			(id,email_id,filename,content_type,size_bytes,content_base64,storage_key)
			VALUES ('attachment','email','note.txt','text/plain',5,'','email/attachment/note.txt')`);
		const keys: (string | undefined)[] = [];
		const sends = provider(async (payload) => {
			keys.push(payload.idempotencyKey);
			assert.equal(payload.replyTo, 'sender@example.net');
			assert.equal(payload.bcc, undefined);
			assert.equal(payload.attachments?.length, 1);
			return { providerId: 'provider-forward' };
		});
		db.failNextFinish = true;
		await deliverForwardingAttempt(
			env(db, bucket(new TextEncoder().encode('hello'))),
			sends,
			'attempt',
			new Date('2026-08-25T01:00:00.000Z')
		);
		db.db.exec(
			"UPDATE forwarding_attempts SET next_attempt_at='2026-08-25T01:01:00.000Z' WHERE id='attempt'"
		);
		await deliverForwardingAttempt(
			env(db, bucket(new TextEncoder().encode('hello'))),
			sends,
			'attempt',
			new Date('2026-08-25T01:02:00.000Z')
		);
		assert.deepEqual(keys, ['quickmail-forward:rule:email', 'quickmail-forward:rule:email']);
	});

	test('loads HTML-only inbound content as safe forwarded plain text', async () => {
		const db = seed();
		db.db.exec(
			`UPDATE emails SET body_text=NULL,
			 body_html='<p>Stored &amp; visible</p><script>hidden()</script>' WHERE id='email'`
		);
		await deliverForwardingAttempt(
			env(db),
			provider(async (payload) => {
				assert.match(payload.text ?? '', /Stored & visible/);
				assert.doesNotMatch(payload.text ?? '', /<p>|<script>|hidden\(\)/);
				return { providerId: 'provider-html' };
			}),
			'attempt',
			new Date('2026-08-25T01:00:00.000Z')
		);
	});

	test('does not call the provider for incomplete attachments, disabled rules, or changed destinations', async () => {
		for (const mode of ['attachment', 'disabled', 'changed'] as const) {
			const db = seed({ attachmentsReady: mode !== 'attachment' });
			if (mode === 'disabled')
				db.db.exec("UPDATE forwarding_rules SET status='disabled' WHERE id='rule'");
			if (mode === 'changed')
				db.db.exec(
					"UPDATE forwarding_destinations SET destination_address='new@outside.example' WHERE id='destination'"
				);
			let calls = 0;
			await deliverForwardingAttempt(
				env(db),
				provider(async () => {
					calls += 1;
					return { providerId: 'unexpected' };
				}),
				'attempt',
				new Date('2026-08-25T01:00:00.000Z')
			);
			assert.equal(calls, 0, mode);
		}
	});

	test('retries temporary failures and terminalizes permanent provider errors', async () => {
		const temporary = seed();
		await deliverForwardingAttempt(
			env(temporary),
			provider(async () => {
				throw new ProviderError(503, 'temporarily_unavailable', 'try later');
			}),
			'attempt',
			new Date('2026-08-25T01:00:00.000Z')
		);
		assert.notEqual(
			temporary.db
				.query("SELECT next_attempt_at FROM forwarding_attempts WHERE id='attempt'")
				.get<{ next_attempt_at: string | null }>()?.next_attempt_at,
			null
		);

		const permanent = seed();
		await deliverForwardingAttempt(
			env(permanent),
			provider(async () => {
				throw new ProviderError(400, 'invalid_recipient', 'bad');
			}),
			'attempt',
			new Date('2026-08-25T01:00:00.000Z')
		);
		assert.equal(
			permanent.db
				.query("SELECT next_attempt_at FROM forwarding_attempts WHERE id='attempt'")
				.get<{ next_attempt_at: string | null }>()?.next_attempt_at,
			null
		);
		assert.equal(
			permanent.db
				.query("SELECT status FROM forwarding_rules WHERE id='rule'")
				.get<{ status: string }>()?.status,
			'enabled'
		);
	});

	test('automatic delivery files exclude deferred complaint, bounce, and rule-failed state', () => {
		const directory = new URL('../../../', import.meta.url);
		const delivery = readFileSync(
			new URL('src/lib/server/forwarding-delivery.ts', directory),
			'utf8'
		);
		const contract = readFileSync(
			new URL('src/lib/server/forwarding-contract.ts', directory),
			'utf8'
		);
		const migration = readFileSync(
			new URL('migrations/0015_forwarding_delivery.sql', directory),
			'utf8'
		);
		for (const forbidden of ['markForwardingRuleFailed', 'failure_code', 'complained', 'bounced']) {
			assert.equal(delivery.includes(forbidden), false, forbidden);
			assert.equal(contract.includes(forbidden), false, forbidden);
			assert.equal(migration.includes(forbidden), false, forbidden);
		}
	});
});
