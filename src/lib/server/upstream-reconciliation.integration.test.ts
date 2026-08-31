import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { Database } from 'bun:sqlite';
import type { D1Database, D1PreparedStatement, R2Bucket } from '@cloudflare/workers-types';
import type { EmailProvider } from './email-provider';
import { insertEmail, listMailbox, listThreadMessages, saveDraft } from './mail-store';
import { resolveReplyFromAddress, sendAndStore } from './outbox';
import { resolveThreadId } from './threads';
import { GET as getMailApi } from '../../routes/api/mail/+server';
import { POST as replyMailApi } from '../../routes/api/mail/[id]/+server';
import { handleCloudflareInbound } from './cloudflare-inbound';
import { handleResendWebhook } from './inbound';
import type { ResendClient } from './resend';

class SqliteD1 {
	readonly db = new Database(':memory:');

	constructor(maxMigration = '9999') {
		this.db.exec('PRAGMA foreign_keys=ON');
		const directory = new URL('../../../migrations/', import.meta.url);
		for (const name of readdirSync(directory)
			.filter((name) => name.endsWith('.sql') && name.slice(0, 4) <= maxMigration)
			.sort()) {
			this.db.exec(readFileSync(new URL(name, directory), 'utf8'));
		}
	}

	prepare(sql: string) {
		return new SqliteStatement(this.db, sql);
	}

	async batch<T = unknown>(statements: D1PreparedStatement[]) {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const results = statements.map((statement) =>
				(statement as unknown as SqliteStatement).execute()
			);
			this.db.exec('COMMIT');
			return results as T[];
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
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
	async all<T>(): Promise<{ results: T[] }> {
		return { results: this.db.query(this.sql).all(...this.args) as T[] };
	}
	async run(): Promise<{ meta: { changes: number } }> {
		return this.execute() as { meta: { changes: number } };
	}
	execute() {
		if (/^\s*SELECT\b/i.test(this.sql)) {
			return { results: this.db.query(this.sql).all(...this.args), meta: { changes: 0 } };
		}
		const result = this.db.query(this.sql).run(...this.args);
		return { meta: { changes: result.changes ?? 0 } };
	}
}

function d1(value: SqliteD1): D1Database {
	return value as unknown as D1Database;
}

function apply(db: SqliteD1, name: string) {
	db.db.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'));
}

function seedPrincipals(db: SqliteD1) {
	db.db.exec(`
		INSERT INTO users(id,email,name,password_hash) VALUES
			('u','owner@example.test','Owner','hash'),
			('other','other@example.test','Other','hash');
		INSERT INTO domains(id,name,status,sending_enabled,receiving_enabled) VALUES
			('d1','one.example','verified',1,1),
			('d2','two.example','verified',1,1);
		INSERT INTO addresses(id,user_id,domain_id,address,is_default) VALUES
			('a1','u','d1','info@one.example',1),
			('a2','u','d2','info@two.example',0),
			('other-a','other','d1','other@one.example',1);
	`);
}

const emptyBucket = {
	async put() {},
	async delete() {}
} as unknown as R2Bucket;

describe('0020 domain thread upgrade', () => {
	test('splits d1, d2 and NULL buckets while preserving folder metadata', () => {
		const db = new SqliteD1('0019');
		seedPrincipals(db);
		db.db.exec(`
			INSERT INTO mail_folders(id,user_id,name,name_key) VALUES ('folder','u','Archive','archive');
			INSERT INTO emails(id,user_id,direction,from_addr,to_addr,subject,thread_id,domain_id,created_at) VALUES
				('a-d1','u','inbound','a@outside.test','info@one.example','A','legacy-a','d1','2026-01-01T00:00:00Z'),
				('a-d1-2','u','outbound','info@one.example','a@outside.test','Re: A','legacy-a','d1','2026-01-01T00:01:00Z'),
				('a-d2','u','inbound','a@outside.test','info@two.example','A','legacy-a','d2','2026-01-01T00:02:00Z'),
				('a-null','u','inbound','a@outside.test','legacy@example.test','A','legacy-a',NULL,'2026-01-01T00:03:00Z'),
				('b-d1','u','inbound','b@outside.test','info@one.example','B','legacy-b','d1','2026-01-02T00:00:00Z'),
				('b-d2','u','inbound','b@outside.test','info@two.example','B','legacy-b','d2','2026-01-02T00:01:00Z'),
				('b-null','u','inbound','b@outside.test','legacy@example.test','B','legacy-b',NULL,'2026-01-02T00:02:00Z');
			INSERT INTO mail_thread_folders(user_id,thread_id,folder_id,assigned_by)
			VALUES ('u','legacy-a','folder','manual');
			INSERT INTO mail_thread_folder_suppressions(user_id,thread_id)
			VALUES ('u','legacy-b');
		`);
		const before = db.db.query('SELECT COUNT(*) AS count FROM emails').get<{ count: number }>()!
			.count;

		apply(db, '0020_domain_scoped_threads.sql');

		assert.equal(
			db.db.query('SELECT COUNT(*) AS count FROM emails').get<{ count: number }>()!.count,
			before
		);
		const mixed = db.db
			.query(
				`
			SELECT thread_id FROM emails
			GROUP BY user_id,thread_id
			HAVING COUNT(DISTINCT COALESCE(domain_id,'__NULL__')) > 1
		`
			)
			.all();
		assert.deepEqual(mixed, []);
		assert.equal(
			db.db
				.query("SELECT COUNT(*) AS count FROM mail_thread_folders WHERE user_id='u'")
				.get<{ count: number }>()!.count,
			3
		);
		assert.equal(
			db.db
				.query("SELECT COUNT(*) AS count FROM mail_thread_folder_suppressions WHERE user_id='u'")
				.get<{ count: number }>()!.count,
			3
		);
		assert.equal(
			db.db
				.query(
					"SELECT COUNT(*) AS count FROM mail_thread_folders WHERE thread_id IN ('legacy-a','legacy-b')"
				)
				.get<{ count: number }>()!.count,
			0
		);
		assert.equal(
			db.db
				.query(
					"SELECT COUNT(*) AS count FROM mail_thread_folder_suppressions WHERE thread_id IN ('legacy-a','legacy-b')"
				)
				.get<{ count: number }>()!.count,
			0
		);
	});
});

describe('0021 address identity', () => {
	test('backfills exact owned addresses and clears identity when the address is deleted', () => {
		const db = new SqliteD1('0020');
		seedPrincipals(db);
		db.db.exec(`
			INSERT INTO emails(id,user_id,direction,from_addr,to_addr,subject,domain_id) VALUES
				('in','u','inbound','sender@outside.test','INFO@ONE.EXAMPLE','Inbound','d1'),
				('out','u','outbound','INFO@TWO.EXAMPLE','recipient@outside.test','Outbound','d2'),
				('catchall','u','inbound','sender@outside.test','unknown@one.example','Catch-all','d1');
		`);
		apply(db, '0021_address_identity.sql');
		assert.deepEqual(db.db.query('SELECT id,address_id FROM emails ORDER BY id').all(), [
			{ id: 'catchall', address_id: null },
			{ id: 'in', address_id: 'a1' },
			{ id: 'out', address_id: 'a2' }
		]);
		db.db.query("DELETE FROM addresses WHERE id='a1'").run();
		assert.equal(
			db.db
				.query("SELECT address_id FROM emails WHERE id='in'")
				.get<{ address_id: string | null }>()!.address_id,
			null
		);
	});

	test('persists registered identities for inserts, drafts and sent mail, but not synthetic senders', async () => {
		const db = new SqliteD1();
		seedPrincipals(db);
		const inserted = await insertEmail(d1(db), {
			userId: 'u',
			direction: 'inbound',
			from: 'sender@outside.test',
			to: 'info@one.example',
			subject: 'Inbound',
			domainId: 'd1',
			addressId: 'a1'
		});
		const draft = await saveDraft(d1(db), 'u', {
			from: 'info@two.example',
			to: '',
			subject: 'Draft',
			domainId: 'd2',
			addressId: 'a2'
		});
		const provider: EmailProvider = {
			kind: 'resend',
			async send() {
				return { providerId: crypto.randomUUID() };
			},
			async listDomains() {
				return [];
			},
			async getDomain() {
				throw new Error('unused');
			}
		};
		const user = {
			id: 'u',
			email: 'owner@example.test',
			name: 'Owner',
			is_admin: false,
			created_at: ''
		};
		const registered = await sendAndStore(
			{ DB: d1(db), ATTACHMENTS: {} as R2Bucket },
			provider,
			user,
			{
				fromAddress: {
					id: 'a1',
					user_id: 'u',
					domain_id: 'd1',
					domain_name: 'one.example',
					address: 'info@one.example',
					label: null,
					signature: null,
					is_default: true,
					created_at: ''
				},
				to: 'person@outside.test',
				subject: 'Sent',
				text: 'Body'
			}
		);
		const synthetic = await sendAndStore(
			{ DB: d1(db), ATTACHMENTS: {} as R2Bucket },
			provider,
			user,
			{
				fromAddress: {
					id: 'reply:alias@one.example',
					user_id: 'u',
					domain_id: 'd1',
					domain_name: 'one.example',
					address: 'alias@one.example',
					label: null,
					signature: null,
					is_default: false,
					created_at: ''
				},
				to: 'person@outside.test',
				subject: 'Synthetic',
				text: 'Body'
			}
		);
		const rows = db.db
			.query('SELECT id,address_id FROM emails WHERE id IN (?,?,?,?)')
			.all<{ id: string; address_id: string | null }>(
				inserted,
				draft,
				registered.emailId,
				synthetic.emailId
			);
		const identities = new Map(rows.map((row) => [row.id, row.address_id]));
		assert.equal(identities.get(inserted), 'a1');
		assert.equal(identities.get(draft), 'a2');
		assert.equal(identities.get(registered.emailId), 'a1');
		assert.equal(identities.get(synthetic.emailId), null);
	});

	test('persists route identity through Cloudflare and Resend inbound paths', async () => {
		const db = new SqliteD1();
		seedPrincipals(db);
		const raw = new TextEncoder().encode(
			[
				'From: Header Sender <header@outside.test>',
				'To: info@one.example',
				'Subject: Cloudflare inbound',
				'Message-ID: <cf-inbound@outside.test>',
				'',
				'Body'
			].join('\r\n')
		);
		await handleCloudflareInbound(
			{
				from: 'bounce@provider.test',
				to: 'info@one.example',
				headers: new Headers(),
				raw: new Blob([raw]).stream(),
				setReject() {}
			},
			{ DB: d1(db), ATTACHMENTS: emptyBucket }
		);

		const client = {
			async getReceivedEmail() {
				return {
					from: 'Resend Sender <resend@outside.test>',
					to: ['info@two.example'],
					subject: 'Resend inbound',
					text: 'Body',
					html: null,
					message_id: 'resend-inbound@outside.test',
					headers: {}
				};
			},
			async listReceivedAttachments() {
				return [];
			}
		} as unknown as ResendClient;
		await handleResendWebhook(
			{
				type: 'email.received',
				data: { email_id: 'resend-provider-id', received_for: ['info@two.example'] }
			},
			{ DB: d1(db), ATTACHMENTS: emptyBucket },
			client
		);

		assert.deepEqual(
			db.db
				.query('SELECT subject,from_addr,from_name,address_id FROM emails ORDER BY subject')
				.all(),
			[
				{
					subject: 'Cloudflare inbound',
					from_addr: 'header@outside.test',
					from_name: 'Header Sender',
					address_id: 'a1'
				},
				{
					subject: 'Resend inbound',
					from_addr: 'resend@outside.test',
					from_name: 'Resend Sender',
					address_id: 'a2'
				}
			]
		);
	});

	test('filters by an owned address without changing the unfiltered mailbox', async () => {
		const db = new SqliteD1();
		seedPrincipals(db);
		db.db.exec(`
			INSERT INTO emails(id,user_id,direction,from_addr,to_addr,subject,thread_id,domain_id,address_id) VALUES
				('one','u','inbound','x@outside.test','info@one.example','One','one','d1','a1'),
				('two','u','inbound','x@outside.test','info@two.example','Two','two','d2','a2');
		`);
		assert.equal((await listMailbox(d1(db), 'u', { view: 'inbox' })).total, 2);
		assert.equal((await listMailbox(d1(db), 'u', { view: 'inbox', addressId: 'a1' })).total, 1);
		assert.equal(
			(await listMailbox(d1(db), 'u', { view: 'inbox', domainId: 'd1', addressId: 'a2' })).total,
			0
		);
		assert.equal(
			(await listMailbox(d1(db), 'u', { view: 'inbox', addressId: 'other-a' })).total,
			0
		);

		const response = await getMailApi({
			locals: {
				user: { id: 'u' },
				activeDomainId: null
			},
			platform: { env: { DB: d1(db) } },
			url: new URL('https://mail.example/api/mail?addressId=a1')
		} as never);
		assert.equal(response.status, 200);
		assert.equal(((await response.json()) as { total: number }).total, 1);
	});
});

describe('0022 inbound sender display names', () => {
	test('stores the parsed name through list and detail while keeping the address as identity', async () => {
		const db = new SqliteD1();
		seedPrincipals(db);
		const raw = new TextEncoder().encode(
			[
				'From: "Alice Example" <alice@outside.test>',
				'To: info@one.example',
				'Subject: Named sender',
				'Message-ID: <named@outside.test>',
				'',
				'Body'
			].join('\r\n')
		);
		await handleCloudflareInbound(
			{
				from: 'bounce@provider.test',
				to: 'info@one.example',
				headers: new Headers(),
				raw: new Blob([raw]).stream(),
				setReject() {}
			},
			{ DB: d1(db), ATTACHMENTS: emptyBucket }
		);

		const stored = db.db
			.query("SELECT * FROM emails WHERE subject='Named sender'")
			.get<{ id: string; from_addr: string; from_name: string | null }>()!;
		assert.deepEqual(
			{ from_addr: stored.from_addr, from_name: stored.from_name },
			{ from_addr: 'alice@outside.test', from_name: 'Alice Example' }
		);
		const mailbox = await listMailbox(d1(db), 'u', { view: 'inbox' });
		assert.deepEqual(mailbox.threads[0]?.participants[0], {
			label: 'Alice Example',
			address: 'alice@outside.test',
			self: false
		});
		const detail = await listThreadMessages(
			d1(db),
			'u',
			db.db.query('SELECT * FROM emails WHERE id=?').get(stored.id) as never
		);
		assert.equal(detail[0]?.from_name, 'Alice Example');
	});

	test('drops the name when malformed From falls back to the envelope sender', async () => {
		const db = new SqliteD1();
		seedPrincipals(db);
		const raw = new TextEncoder().encode(
			[
				'From: Forged Name <not-an-address>',
				'To: info@one.example',
				'Subject: Envelope fallback',
				'',
				'Body'
			].join('\r\n')
		);
		await handleCloudflareInbound(
			{
				from: 'bounce@provider.test',
				to: 'info@one.example',
				headers: new Headers(),
				raw: new Blob([raw]).stream(),
				setReject() {}
			},
			{ DB: d1(db), ATTACHMENTS: emptyBucket }
		);
		assert.deepEqual(
			db.db.query("SELECT from_addr,from_name FROM emails WHERE subject='Envelope fallback'").get(),
			{ from_addr: 'bounce@provider.test', from_name: null }
		);
	});
});

describe('domain-scoped thread resolution', () => {
	test('same-domain replies preserve the thread and cross-domain identities fail before send', async () => {
		const db = new SqliteD1();
		seedPrincipals(db);
		const originalId = await insertEmail(d1(db), {
			userId: 'u',
			direction: 'inbound',
			from: 'alice@outside.test',
			to: 'info@one.example',
			subject: 'Reply boundary',
			domainId: 'd1',
			addressId: 'a1',
			messageId: 'parent@outside.test'
		});
		const original = db.db.query('SELECT * FROM emails WHERE id=?').get(originalId) as never;
		const sameDomain = await resolveReplyFromAddress(
			d1(db),
			{
				id: 'u',
				email: 'owner@example.test',
				name: 'Owner',
				is_admin: false,
				created_at: ''
			},
			original
		);
		assert.equal(sameDomain?.id, 'a1');

		let providerCalls = 0;
		const provider: EmailProvider = {
			kind: 'resend',
			async send() {
				providerCalls += 1;
				return { providerId: 'reply-provider' };
			},
			async listDomains() {
				return [];
			},
			async getDomain() {
				throw new Error('unused');
			}
		};
		const sent = await sendAndStore(
			{ DB: d1(db), ATTACHMENTS: emptyBucket },
			provider,
			{ id: 'u', email: 'owner@example.test', name: 'Owner', is_admin: false, created_at: '' },
			{
				fromAddress: sameDomain,
				to: 'alice@outside.test',
				subject: 'Re: Reply boundary',
				text: 'Reply',
				replyToEmailId: originalId,
				inReplyTo: 'parent@outside.test'
			}
		);
		assert.equal(providerCalls, 1);
		assert.equal(
			db.db
				.query('SELECT thread_id FROM emails WHERE id=?')
				.get<{ thread_id: string }>(sent.emailId)!.thread_id,
			originalId
		);

		const crossDomain = await resolveReplyFromAddress(
			d1(db),
			{ id: 'u', email: 'owner@example.test', name: 'Owner', is_admin: false, created_at: '' },
			original,
			'a2'
		);
		assert.equal(crossDomain, null);
		assert.equal(providerCalls, 1);
		assert.equal(
			db.db.query('SELECT COUNT(*) AS count FROM emails').get<{ count: number }>()!.count,
			2
		);

		const crossResponse = await replyMailApi({
			params: { id: originalId },
			request: new Request(`https://mail.example/api/mail/${originalId}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ fromAddressId: 'a2', text: 'Blocked reply' })
			}),
			locals: {
				user: {
					id: 'u',
					email: 'owner@example.test',
					name: 'Owner',
					is_admin: false,
					created_at: ''
				}
			},
			platform: { env: { DB: d1(db), ATTACHMENTS: emptyBucket } }
		} as never);
		assert.equal(crossResponse.status, 400);
		assert.deepEqual(await crossResponse.json(), {
			error: 'Reply must use a sending address on the same domain.'
		});
		assert.equal(
			db.db.query('SELECT COUNT(*) AS count FROM emails').get<{ count: number }>()!.count,
			2
		);
	});

	test('receive-only thread does not fall through to another domain at the reply route', async () => {
		const db = new SqliteD1();
		seedPrincipals(db);
		db.db.query("UPDATE domains SET sending_enabled=0 WHERE id='d1'").run();
		const originalId = await insertEmail(d1(db), {
			userId: 'u',
			direction: 'inbound',
			from: 'alice@outside.test',
			to: 'info@one.example',
			subject: 'Receive only',
			domainId: 'd1',
			addressId: 'a1'
		});
		const response = await replyMailApi({
			params: { id: originalId },
			request: new Request(`https://mail.example/api/mail/${originalId}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: 'Blocked reply' })
			}),
			locals: {
				user: {
					id: 'u',
					email: 'owner@example.test',
					name: 'Owner',
					is_admin: false,
					created_at: ''
				}
			},
			platform: { env: { DB: d1(db), ATTACHMENTS: emptyBucket } }
		} as never);
		assert.equal(response.status, 400);
		assert.equal(
			db.db.query('SELECT COUNT(*) AS count FROM emails').get<{ count: number }>()!.count,
			1
		);
	});
	test('keeps explicit parents, Message-IDs, subjects and NULL domains inside their bucket', async () => {
		const db = new SqliteD1();
		seedPrincipals(db);
		db.db.exec(`
			INSERT INTO emails(id,user_id,direction,from_addr,to_addr,subject,message_id,thread_id,thread_key,domain_id,created_at) VALUES
				('d1-parent','u','inbound','alice@outside.test','info@one.example','Topic','same-id','d1-thread','topic','d1',datetime('now')),
				('d2-parent','u','inbound','alice@outside.test','info@two.example','Topic','d2-id','d2-thread','topic','d2',datetime('now')),
				('null-parent','u','inbound','alice@outside.test','legacy@example.test','Topic','null-id','null-thread','topic',NULL,datetime('now'));
		`);
		const base = {
			direction: 'inbound' as const,
			subject: 'Re: Topic',
			from: 'alice@outside.test',
			to: 'info@one.example'
		};
		assert.equal(
			await resolveThreadId(d1(db), 'u', {
				...base,
				emailId: 'explicit',
				replyToEmailId: 'd1-parent',
				domainId: 'd1'
			}),
			'd1-thread'
		);
		assert.equal(
			await resolveThreadId(d1(db), 'u', {
				...base,
				emailId: 'cross-explicit',
				replyToEmailId: 'd1-parent',
				domainId: 'd2',
				subjectMatch: false
			}),
			'cross-explicit'
		);
		assert.equal(
			await resolveThreadId(d1(db), 'u', {
				...base,
				emailId: 'reference',
				references: '<same-id>',
				domainId: 'd1'
			}),
			'd1-thread'
		);
		assert.equal(
			await resolveThreadId(d1(db), 'u', {
				...base,
				emailId: 'cross-reference',
				references: '<same-id>',
				domainId: 'd2',
				subjectMatch: false
			}),
			'cross-reference'
		);
		assert.equal(
			await resolveThreadId(d1(db), 'u', { ...base, emailId: 'subject', domainId: 'd1' }),
			'd1-thread'
		);
		assert.equal(
			await resolveThreadId(d1(db), 'u', {
				...base,
				emailId: 'null',
				to: 'legacy@example.test',
				domainId: null
			}),
			'null-thread'
		);
	});

	test('subject fallback uses only the correspondent and keeps replies to a forward isolated', async () => {
		const db = new SqliteD1();
		seedPrincipals(db);
		await insertEmail(d1(db), {
			userId: 'u',
			direction: 'inbound',
			from: 'alice@outside.test',
			to: 'info@one.example',
			subject: 'Quarterly',
			domainId: 'd1'
		});
		const unrelated = await insertEmail(d1(db), {
			userId: 'u',
			direction: 'inbound',
			from: 'bob@outside.test',
			to: 'info@one.example',
			subject: 'Quarterly',
			domainId: 'd1'
		});
		const unrelatedThread = db.db
			.query('SELECT thread_id FROM emails WHERE id=?')
			.get<{ thread_id: string }>(unrelated)!.thread_id;
		assert.equal(unrelatedThread, unrelated);

		const forwarded = await insertEmail(d1(db), {
			userId: 'u',
			direction: 'outbound',
			from: 'info@one.example',
			to: 'bob@outside.test',
			subject: 'Fwd: Quarterly',
			domainId: 'd1',
			subjectMatch: false,
			status: 'sent'
		});
		const reply = await insertEmail(d1(db), {
			userId: 'u',
			direction: 'inbound',
			from: 'bob@outside.test',
			to: 'info@one.example',
			subject: 'Re: Fwd: Quarterly',
			domainId: 'd1'
		});
		assert.equal(
			db.db.query('SELECT thread_id FROM emails WHERE id=?').get<{ thread_id: string }>(reply)!
				.thread_id,
			forwarded
		);
	});
});
