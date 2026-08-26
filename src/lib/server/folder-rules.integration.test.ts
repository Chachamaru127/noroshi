import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { Database } from 'bun:sqlite';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { GET as listRuleRoute, POST as createRuleRoute } from '../../routes/api/sort-rules/+server';
import {
	DELETE as deleteRuleRoute,
	PATCH as updateRuleRoute
} from '../../routes/api/sort-rules/[id]/+server';
import { POST as reorderRuleRoute } from '../../routes/api/sort-rules/reorder/+server';
import {
	createSortRule,
	deleteSortRule,
	listSortRules,
	reorderSortRules,
	updateSortRule
} from './folder-rules';
import { assignThreadsToFolder, createFolder } from './folders';
import { insertEmail, ProviderDeliveryAlreadyClaimedError } from './mail-store';

class SqliteD1 {
	readonly db = new Database(':memory:');
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
		const result = this.db.query(this.sql).run(...this.args);
		return { meta: { changes: result.changes ?? 0 } };
	}
}

function d1(value: SqliteD1): D1Database {
	return value as unknown as D1Database;
}

function seed(): SqliteD1 {
	const db = new SqliteD1();
	db.db.exec(`
		INSERT INTO users(id,email,name,password_hash) VALUES
			('u1','one@example.test','One','hash'),
			('u2','two@example.test','Two','hash');
	`);
	return db;
}

async function assignment(db: SqliteD1, userId: string, threadId: string) {
	return db.db
		.query('SELECT folder_id,assigned_by FROM mail_thread_folders WHERE user_id=? AND thread_id=?')
		.get(userId, threadId) as { folder_id: string; assigned_by: string } | null;
}

describe('mail sorting rules D1 integration', () => {
	test('evaluates enabled rules in position/id order with literal AND matching', async () => {
		const db = seed();
		const first = await createFolder(d1(db), 'u1', '最初');
		const second = await createFolder(d1(db), 'u1', '次');
		await createSortRule(d1(db), 'u1', {
			folderId: second.id,
			senderContains: 'billing+vip%',
			subjectContains: '請求_[重要]'
		});
		await createSortRule(d1(db), 'u1', {
			folderId: first.id,
			senderContains: 'BILLING+VIP%',
			subjectContains: '請求_[重要]'
		});
		const rules = await listSortRules(d1(db), 'u1');
		await reorderSortRules(d1(db), 'u1', [rules[1]!.id, rules[0]!.id]);

		const emailId = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'inbound',
			from: 'billing+VIP%@outside.test',
			to: 'one@example.test',
			subject: 'Re: 請求_[重要] 8月',
			providerId: 'resend-new-1'
		});
		assert.deepEqual(await assignment(db, 'u1', emailId), {
			folder_id: first.id,
			assigned_by: 'rule'
		});

		const noAndMatch = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'inbound',
			from: 'billing+VIP%@outside.test',
			to: 'one@example.test',
			subject: '通常のお知らせ',
			providerId: 'cf-new-2'
		});
		assert.equal(await assignment(db, 'u1', noAndMatch), null);
	});

	test('matches Unicode case and canonical/compatibility equivalents deterministically', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', 'Unicode');
		await createSortRule(d1(db), 'u1', {
			folderId: folder.id,
			senderContains: 'ÉQUIPE@',
			subjectContains: 'ＣＡＦÉ'
		});
		const emailId = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'inbound',
			from: 'e\u0301quipe@outside.test',
			to: 'one@example.test',
			subject: 'Rapport ｃａｆe\u0301',
			providerId: 'cf-unicode'
		});
		assert.equal((await assignment(db, 'u1', emailId))?.folder_id, folder.id);
	});

	test('matches a Greek sigma rule regardless of context-sensitive final sigma lowercasing', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', 'Greek');
		await createSortRule(d1(db), 'u1', { folderId: folder.id, subjectContains: 'ΟΣ' });
		const emailId = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'inbound',
			from: 'sender@outside.test',
			to: 'one@example.test',
			subject: 'ΟΣΑ',
			providerId: 'cf-greek-sigma'
		});
		assert.equal((await assignment(db, 'u1', emailId))?.folder_id, folder.id);
	});

	test('keeps manual or prior assignment sticky and duplicate provider delivery idempotent', async () => {
		const db = seed();
		const manual = await createFolder(d1(db), 'u1', '手動');
		const automatic = await createFolder(d1(db), 'u1', '自動');
		await createSortRule(d1(db), 'u1', { folderId: automatic.id, senderContains: 'alice@' });
		const original = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'inbound',
			from: 'alice@outside.test',
			to: 'one@example.test',
			subject: 'Original',
			messageId: '<root@example>',
			providerId: 'cf-root'
		});
		await assignThreadsToFolder(d1(db), 'u1', [original], manual.id);
		const reply = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'inbound',
			from: 'alice@outside.test',
			to: 'one@example.test',
			subject: 'Re: Original',
			inReplyTo: '<root@example>',
			providerId: 'cf-reply'
		});
		assert.deepEqual(await assignment(db, 'u1', original), {
			folder_id: manual.id,
			assigned_by: 'manual'
		});
		await assert.rejects(
			() =>
				insertEmail(d1(db), {
					userId: 'u1',
					direction: 'inbound',
					from: 'alice@outside.test',
					to: 'one@example.test',
					subject: 'Re: Original',
					inReplyTo: '<root@example>',
					providerId: 'cf-reply'
				}),
			ProviderDeliveryAlreadyClaimedError
		);
		assert.equal(
			(
				db.db.query("SELECT COUNT(*) AS n FROM emails WHERE provider_id='cf-reply'").get() as {
					n: number;
				} | null
			)?.n,
			1
		);
		assert.equal(reply.length > 0, true);
	});

	test('keeps a manual return to Inbox sticky for later matching inbound mail', async () => {
		const db = seed();
		const automatic = await createFolder(d1(db), 'u1', '自動');
		await createSortRule(d1(db), 'u1', { folderId: automatic.id, senderContains: 'alice@' });
		const original = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'inbound',
			from: 'alice@outside.test',
			to: 'one@example.test',
			subject: 'Inbox preference',
			messageId: '<inbox-root@example>',
			providerId: 'cf-inbox-root'
		});
		assert.equal((await assignment(db, 'u1', original))?.folder_id, automatic.id);
		await assignThreadsToFolder(d1(db), 'u1', [original], null);
		assert.equal(await assignment(db, 'u1', original), null);
		assert.equal(
			(
				db.db
					.query(
						'SELECT COUNT(*) AS n FROM mail_thread_folder_suppressions WHERE user_id=? AND thread_id=?'
					)
					.get('u1', original) as { n: number } | null
			)?.n,
			1
		);
		await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'inbound',
			from: 'alice@outside.test',
			to: 'one@example.test',
			subject: 'Re: Inbox preference',
			inReplyTo: '<inbox-root@example>',
			providerId: 'cf-inbox-reply'
		});
		assert.equal(await assignment(db, 'u1', original), null);
		await assignThreadsToFolder(d1(db), 'u1', [original], automatic.id);
		assert.equal(
			(
				db.db
					.query(
						'SELECT COUNT(*) AS n FROM mail_thread_folder_suppressions WHERE user_id=? AND thread_id=?'
					)
					.get('u1', original) as { n: number } | null
			)?.n,
			0
		);
		assert.equal((await assignment(db, 'u1', original))?.assigned_by, 'manual');
	});

	test('does not classify disabled rules, outbound, drafts, historical or Outlook-style imports', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', '対象');
		const disabled = await createSortRule(d1(db), 'u1', {
			folderId: folder.id,
			senderContains: 'match@',
			enabled: false
		});
		const disabledInbound = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'inbound',
			from: 'match@outside.test',
			to: 'one@example.test',
			subject: 'disabled',
			providerId: 'cf-disabled'
		});
		await updateSortRule(d1(db), 'u1', disabled.id, { enabled: true });
		const historical = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'inbound',
			from: 'match@outside.test',
			to: 'one@example.test',
			subject: 'historical'
		});
		await db
			.prepare('UPDATE emails SET provider_id=? WHERE id=?')
			.bind('outlook-import-v1-hash', historical)
			.run();
		const outbound = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'outbound',
			from: 'match@outside.test',
			to: 'one@example.test',
			subject: 'sent',
			providerId: 'resend-outbound',
			status: 'sent'
		});
		const draft = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'outbound',
			from: 'match@outside.test',
			to: 'one@example.test',
			subject: 'draft',
			status: 'draft'
		});
		for (const id of [disabledInbound, historical, outbound, draft]) {
			assert.equal(await assignment(db, 'u1', id), null);
		}
	});

	test('scopes CRUD, destination ownership and exact reorder to one tenant', async () => {
		const db = seed();
		const own = await createFolder(d1(db), 'u1', '自分');
		const other = await createFolder(d1(db), 'u2', '他人');
		await assert.rejects(
			() =>
				createSortRule(d1(db), 'u1', {
					folderId: other.id,
					senderContains: 'x'
				}),
			/not found/i
		);
		const a = await createSortRule(d1(db), 'u1', { folderId: own.id, senderContains: 'a' });
		const b = await createSortRule(d1(db), 'u1', { folderId: own.id, subjectContains: 'b' });
		const foreign = await createSortRule(d1(db), 'u2', {
			folderId: other.id,
			senderContains: 'foreign'
		});
		await assert.rejects(() => reorderSortRules(d1(db), 'u1', [a.id]), /all sorting rules/i);
		assert.deepEqual(
			(await listSortRules(d1(db), 'u1')).map((rule) => rule.id),
			[a.id, b.id]
		);
		await assert.rejects(
			() => reorderSortRules(d1(db), 'u1', [a.id, foreign.id]),
			/all sorting rules/i
		);
		assert.deepEqual(
			(await listSortRules(d1(db), 'u1')).map((rule) => rule.id),
			[a.id, b.id]
		);
		await assert.rejects(
			() => updateSortRule(d1(db), 'u2', a.id, { enabled: false }),
			/not found/i
		);
		await assert.rejects(() => deleteSortRule(d1(db), 'u2', a.id), /not found/i);
	});

	test('enforces the per-user 100 rule limit without affecting another tenant', async () => {
		const db = seed();
		const own = await createFolder(d1(db), 'u1', '上限');
		const other = await createFolder(d1(db), 'u2', '別利用者');
		for (let index = 0; index < 100; index += 1) {
			db.db
				.query(
					`INSERT INTO mail_sort_rules
				 (id,user_id,folder_id,sender_contains,enabled,position)
				 VALUES (?,?,?,?,1,?)`
				)
				.run(`rule-${index}`, 'u1', own.id, `sender-${index}`, index);
		}
		await assert.rejects(
			() => createSortRule(d1(db), 'u1', { folderId: own.id, subjectContains: 'overflow' }),
			/maximum of 100/i
		);
		assert.equal(
			(await createSortRule(d1(db), 'u2', { folderId: other.id, subjectContains: 'allowed' }))
				.user_id,
			'u2'
		);
	});

	test('editing or deleting a rule never moves conversations already classified by it', async () => {
		const db = seed();
		const originalFolder = await createFolder(d1(db), 'u1', '元');
		const newFolder = await createFolder(d1(db), 'u1', '新');
		const rule = await createSortRule(d1(db), 'u1', {
			folderId: originalFolder.id,
			senderContains: 'sticky@'
		});
		const emailId = await insertEmail(d1(db), {
			userId: 'u1',
			direction: 'inbound',
			from: 'sticky@outside.test',
			to: 'one@example.test',
			subject: 'Sticky',
			providerId: 'resend-sticky'
		});
		await updateSortRule(d1(db), 'u1', rule.id, {
			folderId: newFolder.id,
			senderContains: 'different@'
		});
		assert.equal((await assignment(db, 'u1', emailId))?.folder_id, originalFolder.id);
		await deleteSortRule(d1(db), 'u1', rule.id);
		assert.equal((await assignment(db, 'u1', emailId))?.folder_id, originalFolder.id);
	});

	test('rule routes are session-only and reject bearer-style auth', async () => {
		const request = new Request('https://example.test/api/sort-rules');
		const tokenEvent = {
			request,
			locals: { user: { id: 'u1' }, authMethod: 'api_token' },
			platform: { env: { DB: d1(seed()) } }
		} as never;
		assert.equal((await listRuleRoute(tokenEvent)).status, 403);
		const invalidEvent = {
			request: new Request('https://example.test/api/sort-rules', { method: 'POST', body: '{' }),
			locals: { user: { id: 'u1' }, authMethod: 'session' },
			platform: { env: { DB: d1(seed()) } }
		} as never;
		assert.equal((await createRuleRoute(invalidEvent)).status, 400);
	});

	test('session routes create, edit, reorder and delete only owned rules', async () => {
		const db = seed();
		const folder = await createFolder(d1(db), 'u1', 'API');
		const event = (request: Request, id = '') =>
			({
				request,
				locals: { user: { id: 'u1' }, authMethod: 'session' },
				platform: { env: { DB: d1(db) } },
				params: { id }
			}) as never;
		const firstResponse = await createRuleRoute(
			event(
				new Request('https://example.test/api/sort-rules', {
					method: 'POST',
					body: JSON.stringify({ folderId: folder.id, senderContains: 'first' })
				})
			)
		);
		assert.equal(firstResponse.status, 201);
		const first = ((await firstResponse.json()) as { rule: { id: string } }).rule;
		const secondResponse = await createRuleRoute(
			event(
				new Request('https://example.test/api/sort-rules', {
					method: 'POST',
					body: JSON.stringify({ folderId: folder.id, subjectContains: 'second' })
				})
			)
		);
		const second = ((await secondResponse.json()) as { rule: { id: string } }).rule;
		const updateResponse = await updateRuleRoute(
			event(
				new Request(`https://example.test/api/sort-rules/${first.id}`, {
					method: 'PATCH',
					body: JSON.stringify({ enabled: false })
				}),
				first.id
			)
		);
		assert.equal(updateResponse.status, 200);
		const reorderResponse = await reorderRuleRoute(
			event(
				new Request('https://example.test/api/sort-rules/reorder', {
					method: 'POST',
					body: JSON.stringify({ ids: [second.id, first.id] })
				})
			)
		);
		assert.equal(reorderResponse.status, 200);
		assert.deepEqual(
			((await reorderResponse.json()) as { rules: { id: string }[] }).rules.map((rule) => rule.id),
			[second.id, first.id]
		);
		assert.equal(
			(
				await deleteRuleRoute(
					event(
						new Request(`https://example.test/api/sort-rules/${first.id}`, {
							method: 'DELETE'
						}),
						first.id
					)
				)
			).status,
			200
		);
		assert.deepEqual(
			(await listSortRules(d1(db), 'u1')).map((rule) => rule.id),
			[second.id]
		);
	});
});
