import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { importOutlookEml, OUTLOOK_IMPORT_PREFIX } from './outlook-import';

class SqliteD1 {
	readonly db = new Database(':memory:');
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
		const result = this.db.query(this.sql).run(...this.args);
		return { meta: { changes: result.changes ?? 0 } };
	}
}

function d1(value: SqliteD1): D1Database {
	return value as unknown as D1Database;
}

function r2(objects: Map<string, Uint8Array>): R2Bucket {
	return {
		put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
			const bytes =
				value instanceof ArrayBuffer
					? new Uint8Array(value)
					: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			objects.set(key, bytes.slice());
		},
		delete: async (key: string) => {
			objects.delete(key);
		}
	} as unknown as R2Bucket;
}

function seed() {
	const db = new SqliteD1();
	db.db.exec(`
		INSERT INTO users(id,email,name,password_hash,is_admin)
		VALUES ('u','info@example.net','Owner','hash',1);
		INSERT INTO domains(id,name,status,sending_enabled,receiving_enabled)
		VALUES ('d','example.net','verified',1,1);
		INSERT INTO addresses(id,user_id,domain_id,address,is_default)
		VALUES ('a','u','d','info@example.net',1);
	`);
	return db;
}

test('imports a historical EML once, preserving a large body and attachment without forwarding it', async () => {
	const db = seed();
	const objects = new Map<string, Uint8Array>();
	const html = 'x'.repeat(260_001);
	const attachment = Buffer.alloc(5 * 1024 * 1024 + 1, 65).toString('base64');
	const raw = new TextEncoder().encode(
		[
			'From: sender@example.net',
			'To: info@example.net',
			'Subject: Historical',
			'Message-ID: <historical@example.net>',
			'Date: Tue, 26 May 2026 09:31:55 +0000',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="b"',
			'',
			'--b',
			'Content-Type: text/html; charset=utf-8',
			'',
			html,
			'--b',
			'Content-Type: application/octet-stream; name="large.bin"',
			'Content-Disposition: attachment; filename="large.bin"',
			'Content-Transfer-Encoding: base64',
			'',
			attachment,
			'--b--',
			''
		].join('\r\n')
	).buffer;
	const env = { DB: d1(db), ATTACHMENTS: r2(objects) };
	const input = {
		userId: 'u',
		domainId: 'd',
		mailboxAddress: 'info@example.net',
		direction: 'inbound' as const,
		raw
	};

	const first = await importOutlookEml(env, input);
	const retry = await importOutlookEml(env, input);
	assert.equal(first.imported, true);
	assert.equal(retry.imported, false);
	assert.equal(first.emailId, retry.emailId);
	assert.equal(objects.size, 1);

	const row = db.db
		.query(
			`SELECT direction,status,length(body_html) AS html_length,is_read,attachments_ready,provider_id
			 FROM emails WHERE id=?`
		)
		.get<{
			direction: string;
			status: string | null;
			html_length: number;
			is_read: number;
			attachments_ready: number;
			provider_id: string;
		}>(first.emailId);
	assert.equal(row?.direction, 'inbound');
	assert.equal(row?.status, null);
	assert.ok((row?.html_length ?? 0) >= html.length);
	assert.equal(row?.is_read, 1);
	assert.equal(row?.attachments_ready, 1);
	assert.ok(row?.provider_id.startsWith(OUTLOOK_IMPORT_PREFIX));
	assert.equal(
		db.db.query('SELECT COUNT(*) AS count FROM emails').get<{ count: number }>()?.count,
		1
	);
	assert.equal(
		db.db.query('SELECT COUNT(*) AS count FROM forwarding_attempts').get<{ count: number }>()
			?.count,
		0
	);
});

test('marks imported sent mail as outbound and sent', async () => {
	const db = seed();
	const raw = new TextEncoder().encode(
		'From: info@example.net\r\nTo: recipient@example.org\r\nSubject: Sent\r\nDate: Tue, 26 May 2026 10:00:00 +0000\r\n\r\nBody'
	).buffer;
	const result = await importOutlookEml(
		{ DB: d1(db), ATTACHMENTS: r2(new Map()) },
		{
			userId: 'u',
			domainId: 'd',
			mailboxAddress: 'info@example.net',
			direction: 'outbound',
			raw
		}
	);
	const row = db.db
		.query('SELECT direction,status FROM emails WHERE id=?')
		.get<{ direction: string; status: string }>(result.emailId);
	assert.deepEqual(row, { direction: 'outbound', status: 'sent' });
});
