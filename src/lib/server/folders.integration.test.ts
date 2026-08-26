import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { Database } from 'bun:sqlite';
import type { D1Database, D1PreparedStatement, R2Bucket } from '@cloudflare/workers-types';
import { GET as getFoldersRoute } from '../../routes/api/folders/+server';
import { PATCH as renameFolderRoute } from '../../routes/api/folders/[id]/+server';
import { POST as assignFolderRoute } from '../../routes/api/folders/assign/+server';
import { DELETE as deleteMailRoute } from '../../routes/api/mail/[id]/+server';
import { POST as mailActionsRoute } from '../../routes/api/mail/actions/+server';
import { load as loadMailDetail } from '../../routes/mail/[id]/+page.server';
import { authorizeApiRequest } from './api-access';
import {
	assignThreadsToFolder,
	createFolder,
	deleteFolder,
	getFolderDeletionImpact,
	listFolders,
	renameFolder
} from './folders';
import {
	drainAttachmentCleanupOutbox,
	emptyTrash,
	getMailboxCounts,
	listMailbox
} from './mail-store';

class SqliteD1 {
	readonly db = new Database(':memory:');
	readonly executedSql: string[] = [];
	beforeExecute: ((sql: string) => void) | null = null;

	constructor() {
		this.db.exec('PRAGMA foreign_keys=ON');
		const directory = new URL('../../../migrations/', import.meta.url);
		for (const name of readdirSync(directory)
			.filter((name) => name.endsWith('.sql'))
			.sort()) {
			this.db.exec(readFileSync(new URL(name, directory), 'utf8'));
		}
	}

	prepare(sql: string) {
		return new SqliteStatement(this, sql);
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
		private readonly owner: SqliteD1,
		private readonly sql: string
	) {}
	bind(...args: unknown[]) {
		this.args = args;
		return this;
	}
	async first<T>(): Promise<T | null> {
		this.beforeExecute();
		return (this.owner.db.query(this.sql).get(...this.args) as T | undefined) ?? null;
	}
	async all<T>(): Promise<{ results: T[] }> {
		this.beforeExecute();
		return { results: this.owner.db.query(this.sql).all(...this.args) as T[] };
	}
	async run(): Promise<{ meta: { changes: number } }> {
		return this.execute() as { meta: { changes: number } };
	}
	execute() {
		this.beforeExecute();
		if (/^\s*SELECT\b/i.test(this.sql)) {
			return {
				results: this.owner.db.query(this.sql).all(...this.args),
				meta: { changes: 0 }
			};
		}
		const result = this.owner.db.query(this.sql).run(...this.args);
		return { meta: { changes: result.changes ?? 0 } };
	}
	private beforeExecute() {
		this.owner.executedSql.push(this.sql);
		const hook = this.owner.beforeExecute;
		this.owner.beforeExecute = null;
		hook?.(this.sql);
	}
}

function d1(value: SqliteD1): D1Database {
	return value as unknown as D1Database;
}

function seed() {
	const db = new SqliteD1();
	db.db.exec(`
		INSERT INTO users(id,email,name,password_hash) VALUES
			('u1','one@example.net','One','hash'),
			('u2','two@example.net','Two','hash');
		INSERT INTO domains(id,name,status,sending_enabled,receiving_enabled) VALUES
			('d1','one.example','verified',1,1),
			('d2','two.example','verified',1,1);
		INSERT INTO emails
			(id,user_id,direction,from_addr,to_addr,subject,body_text,thread_id,domain_id,is_read,is_starred,status,created_at)
		VALUES
			('a1','u1','inbound','alice@outside.test','info@one.example','Alpha','alpha body','thread-a','d1',0,1,NULL,'2026-08-25T01:00:00.000Z'),
			('a2','u1','outbound','info@one.example','alice@outside.test','Re: Alpha','reply','thread-a','d1',1,0,'sent','2026-08-25T01:01:00.000Z'),
			('b1','u1','inbound','bob@outside.test','info@two.example','Beta','beta body','thread-b','d2',1,0,NULL,'2026-08-25T02:00:00.000Z'),
			('c1','u1','inbound','carol@outside.test','info@one.example','Gamma','gamma body','thread-c','d1',0,0,NULL,'2026-08-25T03:00:00.000Z'),
			('x1','u2','inbound','other@outside.test','info@one.example','Other','other body','thread-x','d1',0,0,NULL,'2026-08-25T04:00:00.000Z');
		INSERT INTO email_attachments(id,email_id,filename,content_type,size_bytes,content_base64,storage_key)
		VALUES ('attachment-a','a1','a.txt','text/plain',1,'','mail/u1/a.txt');
	`);
	return db;
}

describe('custom folders D1 integration', () => {
	test('validates folder names, uniqueness and the 50 folder cap', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', '  重要  ');
		assert.equal(folder.name, '重要');
		await assert.rejects(() => createFolder(d1(db), 'u1', '重要'), /already exists/i);
		await assert.rejects(() => createFolder(d1(db), 'u1', 'Inbox'), /reserved/i);
		await assert.rejects(() => createFolder(d1(db), 'u1', 'bad\u0000name'), /control/i);
		await assert.rejects(() => createFolder(d1(db), 'u1', 'x'.repeat(81)), /80/);

		for (let index = 1; index < 50; index += 1) {
			await createFolder(d1(db), 'u1', `folder-${index}`);
		}
		await assert.rejects(() => createFolder(d1(db), 'u1', 'one-too-many'), /50/);
		assert.equal((await createFolder(d1(db), 'u2', '重要')).name, '重要');

		const emojiDb = seed();
		assert.equal((await createFolder(d1(emojiDb), 'u1', '📁'.repeat(80))).name, '📁'.repeat(80));
		await assert.rejects(() => createFolder(d1(emojiDb), 'u1', '📁'.repeat(81)), /80/);
	});

	test('uses locale-independent Unicode caseless folder uniqueness keys', async () => {
		const greekDb = seed();
		await createFolder(d1(greekDb), 'u1', 'ΟΣ');
		await assert.rejects(() => createFolder(d1(greekDb), 'u1', 'οσ'), /already exists/i);
		await assert.rejects(() => createFolder(d1(greekDb), 'u1', 'ος'), /already exists/i);

		const sharpSdb = seed();
		await createFolder(d1(sharpSdb), 'u1', 'Straße');
		await assert.rejects(() => createFolder(d1(sharpSdb), 'u1', 'STRASSE'), /already exists/i);
	});

	test('uses the conversation expression index for folder count lookups', () => {
		const db = seed();
		const plan = db.db
			.query(
				`EXPLAIN QUERY PLAN
				 SELECT f.id,
				   (SELECT COUNT(*) FROM mail_thread_folders mtf
				    WHERE mtf.user_id = f.user_id AND mtf.folder_id = f.id
				      AND EXISTS (
				        SELECT 1 FROM emails e INDEXED BY idx_emails_user_thread_identity
				        WHERE e.user_id = mtf.user_id
				          AND COALESCE(e.thread_id,e.id) = mtf.thread_id
				          AND e.deleted_at IS NULL
				      )) AS conversation_count
				 FROM mail_folders f WHERE f.user_id = ?`
			)
			.all<{ detail: string }>('u1');
		assert.equal(
			plan.some((row) => row.detail.includes('idx_emails_user_thread_identity')),
			true,
			JSON.stringify(plan)
		);
	});

	test('assigns whole conversations and keeps Inbox, Sent and Starred semantics', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', '取引先');
		assert.equal(await assignThreadsToFolder(d1(db), 'u1', ['a2'], folder.id), 1);

		assert.equal((await listMailbox(d1(db), 'u1', { view: 'inbox' })).total, 2);
		const custom = await listMailbox(d1(db), 'u1', { view: 'folder', folderId: folder.id });
		assert.equal(custom.total, 1);
		assert.equal(custom.threads[0]?.thread_id, 'thread-a');
		assert.equal(custom.threads[0]?.message_count, 2);
		assert.equal((await listMailbox(d1(db), 'u1', { view: 'sent' })).total, 1);
		assert.equal((await listMailbox(d1(db), 'u1', { view: 'starred' })).total, 1);

		const counts = await getMailboxCounts(d1(db), 'u1');
		assert.equal(counts.inbox, 2);
		assert.equal(counts.inbox_unread, 1);
		const folders = await listFolders(d1(db), 'u1');
		assert.deepEqual(
			folders.map(({ name, conversation_count, unread_count }) => ({
				name,
				conversation_count,
				unread_count
			})),
			[{ name: '取引先', conversation_count: 1, unread_count: 1 }]
		);
	});

	test('resolves an assigned trashed conversation back to its retained folder', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', '復元先');
		await assignThreadsToFolder(d1(db), 'u1', ['a1'], folder.id);
		db.db
			.query("UPDATE emails SET deleted_at='2026-08-25T05:00:00Z' WHERE thread_id='thread-a'")
			.run();

		const data = (await loadMailDetail({
			params: { id: 'a1' },
			url: new URL('https://example.test/mail/a1'),
			locals: {
				user: {
					id: 'u1',
					email: 'one@example.net',
					name: 'One',
					is_admin: false,
					created_at: '2026-08-25T00:00:00Z'
				},
				activeDomainId: null
			},
			platform: { env: { DB: d1(db) } }
		} as never)) as {
			backHref: string;
			restoreHref: string;
			assignedFolderId: string | null;
		};

		assert.equal(data.backHref, '/trash');
		assert.equal(data.restoreHref, `/folders/${folder.id}`);
		assert.equal(data.assignedFolderId, folder.id);
	});

	test('resolves direct detail navigation and unfiled destinations from the whole conversation', async () => {
		const db = seed();
		db.db
			.query(
				`INSERT INTO emails
				 (id,user_id,direction,from_addr,to_addr,subject,body_text,thread_id,domain_id,is_read,status,created_at)
				 VALUES ('sent-only','u1','outbound','info@one.example','solo@outside.test','Solo','sent only','thread-solo','d1',1,'sent','2026-08-25T05:00:00.000Z')`
			)
			.run();
		const folder = await createFolder(d1(db), 'u1', '直接表示');
		await assignThreadsToFolder(d1(db), 'u1', ['a2', 'sent-only'], folder.id);

		const load = async (id: string) =>
			(await loadMailDetail({
				params: { id },
				url: new URL(`https://example.test/mail/${id}`),
				locals: {
					user: {
						id: 'u1',
						email: 'one@example.net',
						name: 'One',
						is_admin: false,
						created_at: '2026-08-25T00:00:00Z'
					},
					activeDomainId: null
				},
				platform: { env: { DB: d1(db) } }
			} as never)) as {
				backHref: string;
				restoreHref: string;
				unfiledHref: string;
				currentFolderId: string | null;
				useHistoryBack: boolean;
			};

		const mixed = await load('a2');
		assert.equal(mixed.backHref, `/folders/${folder.id}`);
		assert.equal(mixed.currentFolderId, folder.id);
		assert.equal(mixed.unfiledHref, '/inbox');
		assert.equal(mixed.useHistoryBack, false);

		const outboundOnly = await load('sent-only');
		assert.equal(outboundOnly.backHref, `/folders/${folder.id}`);
		assert.equal(outboundOnly.currentFolderId, folder.id);
		assert.equal(outboundOnly.unfiledHref, '/sent');
		assert.equal(outboundOnly.useHistoryBack, false);
	});

	test('supports domain, search, filters and pagination in a folder', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', 'まとめ');
		assert.equal(await assignThreadsToFolder(d1(db), 'u1', ['a2', 'b1', 'c1'], folder.id), 3);

		const domain = await listMailbox(d1(db), 'u1', {
			view: 'folder',
			folderId: folder.id,
			domainId: 'd1',
			pageSize: 1,
			page: 2
		});
		assert.equal(domain.total, 2);
		assert.equal(domain.pageCount, 2);
		assert.equal(domain.threads.length, 1);
		assert.equal(
			(
				await listMailbox(d1(db), 'u1', {
					view: 'folder',
					folderId: folder.id,
					q: 'beta',
					unreadOnly: false
				})
			).threads[0]?.thread_id,
			'thread-b'
		);
		assert.equal(
			(
				await listMailbox(d1(db), 'u1', {
					view: 'folder',
					folderId: folder.id,
					unreadOnly: true
				})
			).total,
			2
		);
		assert.equal(
			(
				await listMailbox(d1(db), 'u1', {
					view: 'folder',
					folderId: folder.id,
					starredOnly: true
				})
			).total,
			1
		);
		assert.equal(
			(
				await listMailbox(d1(db), 'u1', {
					view: 'folder',
					folderId: folder.id,
					attachmentsOnly: true
				})
			).total,
			1
		);
		const domainFolders = await listFolders(d1(db), 'u1', 'd1');
		assert.deepEqual(
			domainFolders.map(({ conversation_count, unread_count }) => ({
				conversation_count,
				unread_count
			})),
			[{ conversation_count: 2, unread_count: 2 }]
		);
	});

	test('uses live messages for partially trashed threads and preserves assignment', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', '保管');
		await assignThreadsToFolder(d1(db), 'u1', ['a1'], folder.id);
		db.db.exec("UPDATE emails SET deleted_at='2026-08-25T05:00:00Z' WHERE id='a1'");

		const partial = await listMailbox(d1(db), 'u1', { view: 'folder', folderId: folder.id });
		assert.equal(partial.total, 1);
		assert.equal(partial.threads[0]?.message_count, 1);
		assert.deepEqual(
			(await listFolders(d1(db), 'u1')).map(({ conversation_count, unread_count }) => ({
				conversation_count,
				unread_count
			})),
			[{ conversation_count: 1, unread_count: 0 }]
		);

		db.db.exec("UPDATE emails SET deleted_at='2026-08-25T05:00:00Z' WHERE id='a2'");

		assert.equal(
			(await listMailbox(d1(db), 'u1', { view: 'folder', folderId: folder.id })).total,
			0
		);
		assert.equal(
			db.db
				.query("SELECT count(*) AS n FROM mail_thread_folders WHERE user_id='u1'")
				.get<{ n: number }>()?.n,
			1
		);
		db.db.exec("UPDATE emails SET deleted_at=NULL WHERE id='a1'");
		assert.equal(
			(await listMailbox(d1(db), 'u1', { view: 'folder', folderId: folder.id })).total,
			1
		);
	});

	test('rejects cross-tenant folder and message IDs without partial assignment', async () => {
		const db = seed();
		const own = await createFolder(d1(db), 'u1', '自分');
		const other = await createFolder(d1(db), 'u2', '他人');
		await assert.rejects(() => assignThreadsToFolder(d1(db), 'u1', ['a1'], other.id), /not found/i);
		await assert.rejects(
			() => assignThreadsToFolder(d1(db), 'u1', ['a1', 'x1'], own.id),
			/not found/i
		);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM mail_thread_folders').get<{ n: number }>()?.n,
			0
		);
		await assert.rejects(() => renameFolder(d1(db), 'u1', other.id, '盗用'), /not found/i);
		await assert.rejects(
			() =>
				assignThreadsToFolder(
					d1(db),
					'u1',
					Array.from({ length: 101 }, () => 'a1'),
					own.id
				),
			/100/
		);
		await assert.rejects(() => assignThreadsToFolder(d1(db), 'u1', ['a1', ''], own.id), /invalid/i);
		await assert.rejects(() => assignThreadsToFolder(d1(db), 'u1', ['a1'], ''), /invalid/i);
		db.db.exec(`INSERT INTO emails
			(id,user_id,direction,from_addr,to_addr,subject,thread_id,domain_id,status,created_at)
			VALUES ('draft-1','u1','outbound','info@one.example','draft@outside.test','Draft',
			'draft-thread','d1','draft','2026-08-25T05:30:00Z')`);
		await assert.rejects(
			() => assignThreadsToFolder(d1(db), 'u1', ['a1', 'draft-1'], own.id),
			/not found/i
		);
		await assert.rejects(
			() => assignThreadsToFolder(d1(db), 'u1', ['draft-1'], own.id),
			/not found/i
		);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM mail_thread_folders').get<{ n: number }>()?.n,
			0
		);
	});

	test('moves the advertised 100 messages without exceeding the D1 bind limit', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', '100件');
		const insert = db.db.query(
			`INSERT INTO emails
			 (id,user_id,direction,from_addr,to_addr,subject,thread_id,domain_id,created_at)
			 VALUES (?,'u1','inbound','bulk@outside.test','info@one.example','Bulk',?,'d1','2026-08-25T06:00:00Z')`
		);
		const ids = Array.from({ length: 100 }, (_, index) => `bulk-${index}`);
		for (const id of ids) insert.run(id, `bulk-thread-${id}`);

		db.executedSql.length = 0;
		assert.equal(await assignThreadsToFolder(d1(db), 'u1', ids, folder.id), 100);
		assert.equal(db.executedSql.length, 1, 'validation and assignment must be one statement');
		assert.equal(
			db.db
				.query('SELECT count(*) AS n FROM mail_thread_folders WHERE user_id=? AND folder_id=?')
				.get<{ n: number }>('u1', folder.id)?.n,
			100
		);
		db.executedSql.length = 0;
		assert.equal(await assignThreadsToFolder(d1(db), 'u1', ids, null), 100);
		assert.equal(db.executedSql.length, 1, 'validation and Inbox move must be one statement');
		assert.equal(
			db.db
				.query('SELECT count(*) AS n FROM mail_thread_folder_suppressions WHERE user_id=?')
				.get<{ n: number }>('u1')?.n,
			100
		);
		db.db.exec(
			"DELETE FROM mail_thread_folders WHERE user_id='u1'; DELETE FROM mail_thread_folder_suppressions WHERE user_id='u1'"
		);
		await assert.rejects(
			() => assignThreadsToFolder(d1(db), 'u1', [...ids.slice(0, 99), 'x1'], folder.id),
			/not found/i
		);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM mail_thread_folders').get<{ n: number }>()?.n,
			0
		);
	});

	test('cannot create ghost folder metadata when permanent deletion wins the write race', async () => {
		for (const destination of ['folder', 'inbox'] as const) {
			const db = seed();
			const folder = await createFolder(d1(db), 'u1', '競合');
			db.beforeExecute = () => {
				db.db.exec(
					"DELETE FROM email_attachments WHERE email_id IN ('a1','a2'); DELETE FROM emails WHERE id IN ('a1','a2')"
				);
			};
			const move = () =>
				assignThreadsToFolder(d1(db), 'u1', ['a1'], destination === 'folder' ? folder.id : null);
			if (destination === 'folder') await assert.rejects(move, /not found/i);
			else assert.equal(await move(), 0);
			assert.equal(
				db.db.query('SELECT count(*) AS n FROM mail_thread_folders').get<{ n: number }>()?.n,
				0
			);
			assert.equal(
				db.db
					.query('SELECT count(*) AS n FROM mail_thread_folder_suppressions')
					.get<{ n: number }>()?.n,
				0
			);
		}
	});

	test('unassigns selected conversations back to Inbox', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', '処理中');
		await assignThreadsToFolder(d1(db), 'u1', ['a2', 'b1'], folder.id);
		assert.equal(await assignThreadsToFolder(d1(db), 'u1', ['a1'], null), 1);
		assert.equal((await listMailbox(d1(db), 'u1', { view: 'inbox' })).total, 2);
		assert.equal(
			(await listMailbox(d1(db), 'u1', { view: 'folder', folderId: folder.id })).total,
			1
		);
	});

	test('suppresses future sorting only when Inbox move removed an existing assignment', async () => {
		const db = seed();
		const automatic = await createFolder(d1(db), 'u1', '自動');
		db.db
			.query(
				`INSERT INTO mail_sort_rules
				 (id,user_id,folder_id,subject_contains,subject_match_key,enabled,position)
				 VALUES ('auto-rule','u1',?,'later-auto','LATER-AUTO',1,0)`
			)
			.run(automatic.id);

		assert.equal(await assignThreadsToFolder(d1(db), 'u1', ['c1'], null), 0);
		assert.equal(
			db.db
				.query(
					"SELECT count(*) AS n FROM mail_thread_folder_suppressions WHERE user_id='u1' AND thread_id='thread-c'"
				)
				.get<{ n: number }>()?.n,
			0
		);
		db.db.exec(`INSERT INTO emails
			(id,user_id,direction,from_addr,to_addr,subject,sort_subject_key,thread_id,domain_id,provider_id,created_at)
			VALUES ('c2','u1','inbound','new@outside.test','info@one.example','later-auto','LATER-AUTO',
			'thread-c','d1','provider-c2','2026-08-25T08:10:00Z')`);
		assert.equal(
			db.db
				.query(
					"SELECT count(*) AS n FROM mail_thread_folders WHERE user_id='u1' AND thread_id='thread-c' AND folder_id=?"
				)
				.get<{ n: number }>(automatic.id)?.n,
			1
		);

		await assignThreadsToFolder(d1(db), 'u1', ['b1'], automatic.id);
		assert.equal(await assignThreadsToFolder(d1(db), 'u1', ['b1'], null), 1);
		db.db.exec(`INSERT INTO emails
			(id,user_id,direction,from_addr,to_addr,subject,sort_subject_key,thread_id,domain_id,provider_id,created_at)
			VALUES ('b2','u1','inbound','new@outside.test','info@one.example','later-auto','LATER-AUTO',
			'thread-b','d1','provider-b2','2026-08-25T08:11:00Z')`);
		assert.equal(
			db.db
				.query(
					"SELECT count(*) AS n FROM mail_thread_folders WHERE user_id='u1' AND thread_id='thread-b'"
				)
				.get<{ n: number }>()?.n,
			0
		);
		assert.equal(
			db.db
				.query(
					"SELECT count(*) AS n FROM mail_thread_folder_suppressions WHERE user_id='u1' AND thread_id='thread-b'"
				)
				.get<{ n: number }>()?.n,
			1
		);
	});

	test('folder deletion removes only organization metadata and reports impact', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', '削除予定');
		await assignThreadsToFolder(d1(db), 'u1', ['a1', 'b1'], folder.id);
		db.db
			.query(
				`INSERT INTO mail_sort_rules
				(id,user_id,folder_id,sender_contains,subject_contains,enabled,position)
				VALUES ('rule','u1',?,'alice',NULL,1,0)`
			)
			.run(folder.id);
		assert.deepEqual(await getFolderDeletionImpact(d1(db), 'u1', folder.id), {
			conversation_count: 2,
			rule_count: 1
		});
		const emailCount = db.db.query('SELECT count(*) AS n FROM emails').get<{ n: number }>()?.n;
		const attachmentCount = db.db
			.query('SELECT count(*) AS n FROM email_attachments')
			.get<{ n: number }>()?.n;
		const storageKey = db.db
			.query("SELECT storage_key FROM email_attachments WHERE id='attachment-a'")
			.get<{ storage_key: string }>()?.storage_key;

		assert.deepEqual(await deleteFolder(d1(db), 'u1', folder.id), {
			conversation_count: 2,
			rule_count: 1
		});
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM emails').get<{ n: number }>()?.n,
			emailCount
		);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM email_attachments').get<{ n: number }>()?.n,
			attachmentCount
		);
		assert.equal(
			db.db.query("SELECT storage_key FROM email_attachments WHERE id='attachment-a'").get<{
				storage_key: string;
			}>()?.storage_key,
			storageKey
		);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM mail_sort_rules').get<{ n: number }>()?.n,
			0
		);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM mail_thread_folders').get<{ n: number }>()?.n,
			0
		);
		assert.equal((await listMailbox(d1(db), 'u1', { view: 'inbox' })).total, 3);
	});

	test('empty trash removes a folder assignment only after the whole conversation is gone', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', '廃棄');
		await assignThreadsToFolder(d1(db), 'u1', ['a1'], folder.id);
		db.db.exec("UPDATE emails SET deleted_at='2026-08-25T07:00:00Z' WHERE id='a1'");
		const deletedKeys: string[] = [];
		const bucket = {
			delete: async (key: string) => {
				deletedKeys.push(key);
			}
		} as unknown as R2Bucket;

		assert.equal(await emptyTrash(d1(db), bucket, 'u1'), 1);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM mail_thread_folders').get<{ n: number }>()?.n,
			1
		);
		db.db.exec("UPDATE emails SET deleted_at='2026-08-25T07:01:00Z' WHERE id='a2'");
		assert.equal(await emptyTrash(d1(db), bucket, 'u1'), 1);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM mail_thread_folders').get<{ n: number }>()?.n,
			0
		);
		assert.deepEqual(deletedKeys, ['mail/u1/a.txt']);
		assert.deepEqual(await getFolderDeletionImpact(d1(db), 'u1', folder.id), {
			conversation_count: 0,
			rule_count: 0
		});
	});

	test('empty trash removes an Inbox suppression only after the whole conversation is gone', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', '受信トレイへ戻す');
		await assignThreadsToFolder(d1(db), 'u1', ['a1'], folder.id);
		await assignThreadsToFolder(d1(db), 'u1', ['a1'], null);
		db.db.exec("UPDATE emails SET deleted_at='2026-08-25T07:00:00Z' WHERE id='a1'");
		assert.equal(await emptyTrash(d1(db), undefined, 'u1'), 1);
		assert.equal(
			db.db
				.query('SELECT count(*) AS n FROM mail_thread_folder_suppressions WHERE user_id=?')
				.get<{ n: number }>('u1')?.n,
			1
		);
		db.db.exec("UPDATE emails SET deleted_at='2026-08-25T07:01:00Z' WHERE id='a2'");
		assert.equal(await emptyTrash(d1(db), undefined, 'u1'), 1);
		assert.equal(
			db.db
				.query('SELECT count(*) AS n FROM mail_thread_folder_suppressions WHERE user_id=?')
				.get<{ n: number }>('u1')?.n,
			0
		);
	});

	test('rolls back every D1 trash deletion before touching R2 when one row fails', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', 'ロールバック');
		await assignThreadsToFolder(d1(db), 'u1', ['a1'], folder.id);
		await assignThreadsToFolder(d1(db), 'u1', ['b1'], folder.id);
		await assignThreadsToFolder(d1(db), 'u1', ['b1'], null);
		db.db.exec(`
			UPDATE emails SET deleted_at='2026-08-25T08:00:00Z' WHERE id IN ('a1','a2','b1');
			CREATE TRIGGER reject_b1_permanent_delete BEFORE DELETE ON emails
			WHEN OLD.id = 'b1' BEGIN SELECT RAISE(ABORT,'injected delete failure'); END;
		`);
		const deletedKeys: string[] = [];
		const bucket = {
			delete: async (key: string) => {
				deletedKeys.push(key);
			}
		} as unknown as R2Bucket;

		await assert.rejects(() => emptyTrash(d1(db), bucket, 'u1'), /injected delete failure/);
		assert.equal(
			db.db.query("SELECT count(*) AS n FROM emails WHERE id IN ('a1','a2','b1')").get<{
				n: number;
			}>()?.n,
			3
		);
		assert.equal(
			db.db.query("SELECT count(*) AS n FROM email_attachments WHERE id='attachment-a'").get<{
				n: number;
			}>()?.n,
			1
		);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM mail_thread_folders').get<{ n: number }>()?.n,
			1
		);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM mail_thread_folder_suppressions').get<{ n: number }>()
				?.n,
			1
		);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM attachment_cleanup_outbox').get<{ n: number }>()?.n,
			0
		);
		assert.deepEqual(deletedKeys, []);
	});

	test('empty trash rechecks deleted_at inside the deletion transaction', async () => {
		const db = seed();
		db.db.exec("UPDATE emails SET deleted_at='2026-08-25T08:30:00Z' WHERE id='a1'");
		const deletedKeys: string[] = [];
		const bucket = {
			delete: async (key: string) => {
				deletedKeys.push(key);
			}
		} as unknown as R2Bucket;

		db.beforeExecute = () => {
			// emptyTrash first discovers the candidate IDs. Restore the row only
			// after that read, immediately before the permanent-delete batch.
			db.beforeExecute = () => {
				db.db.exec("UPDATE emails SET deleted_at=NULL WHERE id='a1'");
			};
		};

		assert.equal(await emptyTrash(d1(db), bucket, 'u1'), 0);
		assert.equal(
			db.db.query("SELECT count(*) AS n FROM emails WHERE id='a1'").get<{ n: number }>()?.n,
			1
		);
		assert.equal(
			db.db.query("SELECT count(*) AS n FROM email_attachments WHERE email_id='a1'").get<{
				n: number;
			}>()?.n,
			1
		);
		assert.deepEqual(deletedKeys, []);
	});

	test('user permanent-delete routes preserve a message restored after thread expansion', async () => {
		for (const route of ['detail', 'selection'] as const) {
			const db = seed();
			db.db.exec("UPDATE emails SET deleted_at='2026-08-25T08:45:00Z' WHERE id IN ('a1','a2')");
			const deletedKeys: string[] = [];
			const bucket = {
				delete: async (key: string) => {
					deletedKeys.push(key);
				}
			} as unknown as R2Bucket;
			const locals = {
				user: { id: 'u1', email: 'one@example.net', name: 'One', is_admin: false },
				authMethod: 'session',
				apiScopes: [],
				activeDomainId: null
			};

			// The first statement expands the selected conversation. The second
			// begins permanent deletion, after another tab has restored a1.
			db.beforeExecute = () => {
				db.beforeExecute = () => {
					db.db.exec("UPDATE emails SET deleted_at=NULL WHERE id='a1'");
				};
			};

			const response =
				route === 'detail'
					? await deleteMailRoute({
							locals,
							platform: { env: { DB: d1(db), ATTACHMENTS: bucket } },
							params: { id: 'a1' }
						} as never)
					: await mailActionsRoute({
							locals,
							platform: { env: { DB: d1(db), ATTACHMENTS: bucket } },
							request: new Request('https://example.test/api/mail/actions', {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify({ action: 'delete', ids: ['a1'] })
							})
						} as never);

			assert.equal(response.status, 200, route);
			assert.equal(
				db.db.query("SELECT deleted_at FROM emails WHERE id='a1'").get<{
					deleted_at: string | null;
				}>()?.deleted_at,
				null,
				route
			);
			assert.equal(
				db.db.query("SELECT count(*) AS n FROM emails WHERE id='a2'").get<{ n: number }>()?.n,
				0,
				route
			);
			assert.equal(
				db.db.query("SELECT count(*) AS n FROM email_attachments WHERE email_id='a1'").get<{
					n: number;
				}>()?.n,
				1,
				route
			);
			assert.deepEqual(deletedKeys, [], route);
		}
	});

	test('reports committed D1 deletion truthfully when one R2 cleanup fails', async () => {
		const db = seed();
		db.db.exec(`
			INSERT INTO email_attachments
				(id,email_id,filename,content_type,size_bytes,content_base64,storage_key)
			VALUES ('attachment-a2','a1','a2.txt','text/plain',1,'','mail/u1/a2.txt');
			UPDATE emails SET deleted_at='2026-08-25T09:00:00Z' WHERE id='a1';
		`);
		const attempted: string[] = [];
		const bucket = {
			delete: async (key: string) => {
				attempted.push(key);
				if (key.endsWith('a.txt')) throw new Error('secret provider detail');
			}
		} as unknown as R2Bucket;
		const errors: unknown[][] = [];
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			assert.equal(await emptyTrash(d1(db), bucket, 'u1'), 1);
		} finally {
			console.error = originalConsoleError;
		}

		assert.deepEqual(attempted.sort(), ['mail/u1/a.txt', 'mail/u1/a2.txt']);
		assert.equal(
			db.db.query("SELECT count(*) AS n FROM emails WHERE id='a1'").get<{ n: number }>()?.n,
			0
		);
		assert.equal(
			db.db.query("SELECT count(*) AS n FROM email_attachments WHERE email_id='a1'").get<{
				n: number;
			}>()?.n,
			0
		);
		assert.equal(errors.length, 1);
		assert.equal(JSON.stringify(errors).includes('secret provider detail'), false);
		assert.equal(JSON.stringify(errors).includes('mail/u1/'), false);
		assert.deepEqual(errors[0]?.[1], { failed: 1, total: 2, error_kinds: ['Error'] });
		assert.deepEqual(
			db.db
				.query('SELECT storage_key, attempts FROM attachment_cleanup_outbox ORDER BY storage_key')
				.all(),
			[{ storage_key: 'mail/u1/a.txt', attempts: 1 }]
		);

		const retried: string[] = [];
		const retryBucket = {
			delete: async (key: string) => {
				retried.push(key);
			}
		} as unknown as R2Bucket;
		assert.deepEqual(await drainAttachmentCleanupOutbox(d1(db), retryBucket), {
			processed: 1,
			failed: 0
		});
		assert.deepEqual(retried, ['mail/u1/a.txt']);
		assert.equal(
			db.db.query('SELECT count(*) AS n FROM attachment_cleanup_outbox').get<{ n: number }>()?.n,
			0
		);
	});

	test('cleanup retry limit does not let permanent failures starve later objects', async () => {
		const db = seed();
		db.db.exec(`
			INSERT INTO attachment_cleanup_outbox(storage_key,created_at) VALUES
				('cleanup/a','2026-08-26T00:00:00.000Z'),
				('cleanup/b','2026-08-26T00:00:00.000Z'),
				('cleanup/c','2026-08-26T00:00:00.000Z');
		`);
		const attempted: string[] = [];
		const bucket = {
			delete: async (key: string) => {
				attempted.push(key);
				if (key !== 'cleanup/c') throw new Error('permanent');
			}
		} as unknown as R2Bucket;
		const originalConsoleError = console.error;
		console.error = () => undefined;
		try {
			assert.deepEqual(await drainAttachmentCleanupOutbox(d1(db), bucket, 2), {
				processed: 2,
				failed: 2
			});
			assert.deepEqual(attempted, ['cleanup/a', 'cleanup/b']);

			attempted.length = 0;
			assert.deepEqual(await drainAttachmentCleanupOutbox(d1(db), bucket, 2), {
				processed: 2,
				failed: 1
			});
			assert.equal(attempted.includes('cleanup/c'), true);
			assert.equal(
				db.db
					.query(
						"SELECT count(*) AS n FROM attachment_cleanup_outbox WHERE storage_key='cleanup/c'"
					)
					.get<{ n: number }>()?.n,
				0
			);
		} finally {
			console.error = originalConsoleError;
		}
	});

	test('folder list and assignment endpoints return updated counts', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', 'API');
		const locals = {
			user: { id: 'u1', email: 'one@example.net', name: 'One', is_admin: false },
			authMethod: 'session',
			apiScopes: [],
			activeDomainId: null
		};
		const beforeResponse = await getFoldersRoute({
			locals,
			platform: { env: { DB: d1(db) } }
		} as never);
		const before = (await beforeResponse.json()) as { folders: { conversation_count: number }[] };
		assert.equal(before.folders[0]?.conversation_count, 0);

		const assignResponse = await assignFolderRoute({
			locals,
			platform: { env: { DB: d1(db) } },
			request: new Request('https://example.test/api/folders/assign', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ids: ['a2'], folderId: folder.id })
			})
		} as never);
		const assigned = (await assignResponse.json()) as {
			folders: { conversation_count: number; unread_count: number }[];
			counts: { inbox: number };
		};
		assert.equal(assignResponse.status, 200);
		assert.equal(assigned.folders[0]?.conversation_count, 1);
		assert.equal(assigned.folders[0]?.unread_count, 1);
		assert.equal(assigned.counts.inbox, 2);

		const renamedStore = await renameFolder(d1(db), 'u1', folder.id, 'API保管');
		assert.equal(renamedStore.conversation_count, 1);
		assert.equal(renamedStore.unread_count, 1);
		const renameResponse = await renameFolderRoute({
			locals,
			platform: { env: { DB: d1(db) } },
			params: { id: folder.id },
			request: new Request(`https://example.test/api/folders/${folder.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'API保管済み' })
			})
		} as never);
		const renamed = (await renameResponse.json()) as {
			folder: { name: string; conversation_count: number; unread_count: number };
		};
		assert.equal(renameResponse.status, 200);
		assert.equal(renamed.folder.name, 'API保管済み');
		assert.equal(renamed.folder.conversation_count, 1);
		assert.equal(renamed.folder.unread_count, 1);
	});

	test('folder routes are browser-session only', () => {
		for (const [pathname, method] of [
			['/api/folders', 'GET'],
			['/api/folders', 'POST'],
			['/api/folders/folder-id', 'PATCH'],
			['/api/folders/folder-id', 'DELETE'],
			['/api/folders/assign', 'POST']
		]) {
			assert.deepEqual(
				authorizeApiRequest({
					pathname,
					method,
					authMethod: 'session',
					scopes: []
				}),
				{ ok: true }
			);
			assert.equal(
				authorizeApiRequest({
					pathname,
					method,
					authMethod: 'api_token',
					scopes: ['mail:read', 'mail:send', 'admin']
				}).ok,
				false
			);
		}
	});
});
