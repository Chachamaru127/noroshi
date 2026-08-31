import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	cloudflareProviderId,
	inboundSenderIdentity,
	inboundSender,
	isAllowedCloudflareRecipient
} from './cloudflare-inbound';

test('accepts only recipients in configured Cloudflare domains', () => {
	assert.equal(
		isAllowedCloudflareRecipient('Member@Example.com', 'example.com'),
		true
	);
	assert.equal(isAllowedCloudflareRecipient('member@other.example', 'example.com'), false);
	assert.equal(isAllowedCloudflareRecipient('not-an-address', 'example.com'), false);
	assert.equal(isAllowedCloudflareRecipient('member@example.com', ''), false);
});

test('deduplicates exact retries without trusting the sender Message-ID', async () => {
	const encoder = new TextEncoder();
	const first = await cloudflareProviderId(encoder.encode('Message-ID: same\r\n\r\nFirst').buffer);
	const retry = await cloudflareProviderId(encoder.encode('Message-ID: same\r\n\r\nFirst').buffer);
	const distinct = await cloudflareProviderId(encoder.encode('Message-ID: same\r\n\r\nSecond').buffer);

	assert.equal(first, retry);
	assert.notEqual(first, distinct);
});

test('keeps the legacy raw delivery identity while D1 scopes it by recipient', async () => {
	const raw = new TextEncoder().encode('Message-ID: same\r\n\r\nBody').buffer;
	const first = await cloudflareProviderId(raw, 'First@Example.net');
	const retry = await cloudflareProviderId(raw, 'first@example.net');
	const second = await cloudflareProviderId(raw, 'second@example.net');
	const digest = await crypto.subtle.digest('SHA-256', raw);
	const legacy = `cf-${[...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')}`;
	assert.equal(first, retry);
	assert.equal(first, second);
	assert.equal(first, legacy);
});

test('uses the parsed From header before the SMTP bounce envelope', () => {
	assert.equal(
		inboundSender('Sender Name <sender@example.test>', 'bounce@provider.example'),
		'sender@example.test'
	);
});

test('falls back to the envelope when From is absent or invalid', () => {
	assert.equal(inboundSender(undefined, 'sender@example.test'), 'sender@example.test');
	assert.equal(inboundSender('<>', 'sender@example.test'), 'sender@example.test');
	assert.equal(inboundSender('undisclosed-recipients', 'sender@example.test'), 'sender@example.test');
	assert.equal(inboundSender('a@', 'sender@example.test'), 'sender@example.test');
	assert.equal(inboundSender('@b', 'sender@example.test'), 'sender@example.test');
	assert.equal(inboundSender('a@@b', 'sender@example.test'), 'sender@example.test');
	assert.equal(inboundSender(undefined, undefined), '');
});

test('keeps a parsed RFC From display name only with its valid mailbox', () => {
	assert.deepEqual(
		inboundSenderIdentity(
			{ name: 'Alice Example', address: 'Alice@Example.test' },
			'bounce@provider.example'
		),
		{ address: 'alice@example.test', name: 'Alice Example' }
	);
	assert.deepEqual(
		inboundSenderIdentity(
			{ name: 'Forged Name', address: 'not-an-address' },
			'bounce@provider.example'
		),
		{ address: 'bounce@provider.example', name: null }
	);
});
