import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NoroshiClient, safeDownloadName } from './client.ts';

describe('safeDownloadName', () => {
	test('strips directory components and absolute paths', () => {
		assert.equal(safeDownloadName('../../.ssh/authorized_keys'), 'authorized_keys');
		assert.equal(safeDownloadName('/tmp/payload'), 'payload');
		assert.equal(safeDownloadName('C:\\Windows\\win.ini'), 'win.ini');
		assert.equal(safeDownloadName('invoice.pdf'), 'invoice.pdf');
	});

	test('falls back when the name is empty or a traversal residue', () => {
		assert.equal(safeDownloadName(''), 'attachment');
		assert.equal(safeDownloadName('..'), 'attachment');
		assert.equal(safeDownloadName('/'), 'attachment');
	});
});

test('getThread can explicitly preserve unread state without changing the existing default', async () => {
	const originalFetch = globalThis.fetch;
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		requests.push(String(input));
		return new Response(JSON.stringify({ threadId: 'thread', subject: 'Subject', messages: [] }), {
			headers: { 'content-type': 'application/json' }
		});
	};
	try {
		const client = new NoroshiClient('https://mail.example.test', 'fixture-token');
		await client.getThread('thread/with space', { markRead: false });
		await client.getThread('thread/with space');
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.deepEqual(requests, [
		'https://mail.example.test/api/mail/thread%2Fwith%20space?markRead=false',
		'https://mail.example.test/api/mail/thread%2Fwith%20space'
	]);
});
