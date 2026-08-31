import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mailboxInitial, mailboxPeople } from './mailbox-people';
import type { ThreadSummary } from './types';

function thread(participants: ThreadSummary['participants']): ThreadSummary {
	return {
		thread_id: 'thread-1',
		latest_id: 'mail-1',
		subject: 'Subject',
		preview: '',
		participants,
		message_count: 1,
		is_read: true,
		is_starred: false,
		is_draft: false,
		has_attachments: false,
		domain_id: 'domain-1',
		status: 'sent',
		created_at: '2026-08-31 12:00:00'
	};
}

test('keeps current sent-only rows visible when storage provides only the sender identity', () => {
	const summary = thread([{ label: 'me', address: 'info@example.com', self: true }]);
	assert.equal(mailboxPeople(summary, 'sent'), 'info');
	assert.equal(mailboxInitial(summary), 'M');
});

test('shows both sides of a reply thread without dropping the stored display name', () => {
	const summary = thread([
		{ label: 'me', address: 'info@example.com', self: true },
		{ label: 'Alice Example', address: 'alice@example.net', self: false }
	]);
	assert.equal(mailboxPeople(summary, 'inbox'), '自分, Alice Example');
	assert.equal(mailboxInitial(summary), 'A');
});

test('keeps starred rows readable when an external display name is absent', () => {
	const summary = thread([{ label: '', address: 'alerts@example.net', self: false }]);
	assert.equal(mailboxPeople(summary, 'starred'), 'alerts@example.net');
	assert.equal(mailboxInitial(summary), 'A');
});

test('uses the same participant rendering for custom folder rows', () => {
	const summary = thread([{ label: 'Customer Desk', address: 'desk@example.net', self: false }]);
	assert.equal(mailboxPeople(summary, 'folder'), 'Customer Desk');
	assert.equal(mailboxInitial(summary), 'C');
});
