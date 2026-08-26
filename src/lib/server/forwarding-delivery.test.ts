import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MailAddress } from '$lib/types';
import {
	buildForwardingPayload,
	forwardingIdempotencyKey,
	isForwardedHop,
	nextForwardingRetryAt,
	MAX_FORWARDING_CLAIMS
} from './forwarding-delivery';

const source: MailAddress = {
	id: 'address-1',
	user_id: 'user-1',
	domain_id: 'domain-1',
	domain_name: 'quickmail.example',
	address: 'info@quickmail.example',
	label: 'Info',
	is_default: true,
	signature: null,
	created_at: '2026-08-25T00:00:00.000Z'
};

describe('automatic forwarding MVP contract', () => {
	test('builds a sanitized Resend payload without raw headers or Bcc', () => {
		const payload = buildForwardingPayload({
			ruleId: 'rule-1',
			emailId: 'email-1',
			source,
			destination: 'archive@outside.example',
			original: {
				from: 'Sender <sender@example.net>',
				to: source.address,
				subject: 'Original\r\nBcc: hidden@example.net',
				bodyText: 'hello',
				createdAt: '2026-08-25T01:02:03.000Z'
			},
			attachments: [{ filename: 'note.txt', type: 'text/plain', content: 'aGVsbG8=' }]
		});

		assert.deepEqual(payload.to, ['archive@outside.example']);
		assert.equal(payload.replyTo, 'sender@example.net');
		assert.equal(payload.bcc, undefined);
		assert.equal(payload.inReplyTo, undefined);
		assert.equal(payload.references, undefined);
		assert.deepEqual(payload.headers, { 'X-QuickMail-Forwarded': '1' });
		assert.equal(payload.idempotencyKey, 'quickmail-forward:rule-1:email-1');
	});

	test('uses safe plain text from HTML-only inbound mail', () => {
		const payload = buildForwardingPayload({
			ruleId: 'rule-1',
			emailId: 'email-html',
			source,
			destination: 'archive@outside.example',
			original: {
				from: 'sender@example.net',
				to: source.address,
				subject: 'HTML only',
				bodyText: null,
				bodyHtml: '<p>Hello &amp; welcome</p><script>secret()</script>',
				createdAt: '2026-08-25T01:02:03.000Z'
			}
		});

		assert.match(payload.text ?? '', /Hello & welcome/);
		assert.doesNotMatch(payload.text ?? '', /<p>|<script>|secret\(\)/);
	});

	test('keeps one idempotency key per job and separates different jobs', () => {
		assert.equal(
			forwardingIdempotencyKey('rule-1', 'email-1'),
			forwardingIdempotencyKey('rule-1', 'email-1')
		);
		assert.notEqual(
			forwardingIdempotencyKey('rule-1', 'email-1'),
			forwardingIdempotencyKey('rule-1', 'email-2')
		);
	});

	test('detects loop marker and allows initial plus three retries', () => {
		assert.equal(isForwardedHop({ 'x-quickmail-forwarded': '1' }), true);
		assert.equal(isForwardedHop({ 'X-QuickMail-Forwarded': '0' }), false);
		assert.equal(MAX_FORWARDING_CLAIMS, 4);
		const now = new Date('2026-08-25T01:00:00.000Z');
		assert.equal(nextForwardingRetryAt(1, now)?.toISOString(), '2026-08-25T01:01:00.000Z');
		assert.equal(nextForwardingRetryAt(2, now)?.toISOString(), '2026-08-25T01:05:00.000Z');
		assert.equal(nextForwardingRetryAt(3, now)?.toISOString(), '2026-08-25T01:15:00.000Z');
		assert.equal(nextForwardingRetryAt(4, now), null);
	});
});
