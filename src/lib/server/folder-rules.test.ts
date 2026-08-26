import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { createSortRule, MailSortRuleValidationError, reorderSortRules } from './folder-rules';
import { normalizeMailSortKey } from './mail-sort-key';

function rejectingDb(): D1Database {
	return {
		prepare() {
			throw new Error('database must not be reached');
		}
	} as unknown as D1Database;
}

describe('mail sorting rule validation', () => {
	test('uses locale-independent Unicode default caseless keys', () => {
		assert.equal(normalizeMailSortKey('Straße'), normalizeMailSortKey('STRASSE'));
		assert.equal(normalizeMailSortKey('STRAẞE'), normalizeMailSortKey('strasse'));
		assert.equal(normalizeMailSortKey('Σ'), normalizeMailSortKey('σ'));
		assert.equal(normalizeMailSortKey('Σ'), normalizeMailSortKey('ς'));
		assert.equal(normalizeMailSortKey('I'), normalizeMailSortKey('i'));
		assert.notEqual(normalizeMailSortKey('İ'), normalizeMailSortKey('i'));
		assert.notEqual(normalizeMailSortKey('ı'), normalizeMailSortKey('I'));
	});

	test('requires at least one bounded literal condition without control characters', async () => {
		const db = rejectingDb();
		for (const input of [
			{ folderId: 'folder', senderContains: null, subjectContains: null },
			{ folderId: 'folder', senderContains: '   ', subjectContains: undefined },
			{ folderId: 'folder', senderContains: 'a'.repeat(257), subjectContains: null },
			{ folderId: 'folder', senderContains: 'bad\u0000value', subjectContains: null },
			{ folderId: '', senderContains: 'sender', subjectContains: null }
		]) {
			await assert.rejects(
				() => createSortRule(db, 'u1', input),
				(error: unknown) => error instanceof MailSortRuleValidationError
			);
		}
	});

	test('rejects empty, duplicate, over-limit and malformed reorder requests before D1', async () => {
		const db = rejectingDb();
		for (const ids of [
			[],
			['same', 'same'],
			Array.from({ length: 101 }, (_, index) => `rule-${index}`),
			['bad\u0000id']
		]) {
			await assert.rejects(
				() => reorderSortRules(db, 'u1', ids),
				(error: unknown) => error instanceof MailSortRuleValidationError
			);
		}
	});
});
