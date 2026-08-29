import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { createResendProvider } from './resend-provider';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function domainResponse(name: string): Response {
	return new Response(
		JSON.stringify({
			object: 'list',
			has_more: false,
			data: [
				{
					id: 'domain-id',
					name,
					status: 'verified',
					created_at: '2026-08-24T00:00:00Z',
					region: 'ap-northeast-1',
					capabilities: { sending: 'enabled', receiving: 'disabled' }
				}
			]
		})
	);
}

describe('Resend provider with Cloudflare inbound', () => {
	test('passes automatic forwarding Reply-To and idempotency to Resend', async () => {
		let body: { reply_to?: string } = {};
		let idempotencyKey = '';
		globalThis.fetch = (async (_input, init) => {
			body = JSON.parse(String(init?.body)) as { reply_to?: string };
			idempotencyKey = new Headers(init?.headers).get('Idempotency-Key') ?? '';
			return new Response(JSON.stringify({ id: 'provider-id' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as typeof fetch;
		const provider = createResendProvider('re_test', undefined, 'quickmail.example');
		await provider.send({
			from: {
				id: 'address', user_id: 'user', domain_id: 'domain', domain_name: 'quickmail.example',
				address: 'info@quickmail.example', label: null, is_default: true, signature: null,
				created_at: '2026-08-25T00:00:00.000Z'
			},
			senderName: 'Info',
			to: ['archive@outside.example'],
			replyTo: 'sender@example.net',
			subject: 'Fwd: Hello',
			text: 'Body',
			idempotencyKey: 'quickmail-forward:rule:email'
		});
		assert.equal(body.reply_to, 'sender@example.net');
		assert.equal(idempotencyKey, 'quickmail-forward:rule:email');
	});

	test('can target an explicit local API origin for FakeProvider UI smoke', async () => {
		let requestUrl = '';
		globalThis.fetch = (async (input) => {
			requestUrl = String(input);
			return new Response(JSON.stringify({ id: 'fake-provider-id' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as typeof fetch;

		const provider = createResendProvider(
			're_test',
			undefined,
			'quickmail.example',
			'http://127.0.0.1:8788/'
		);
		const result = await provider.send({
			from: {
				id: 'address', user_id: 'user', domain_id: 'domain', domain_name: 'quickmail.example',
				address: 'info@quickmail.example', label: null, is_default: true, signature: null,
				created_at: '2026-08-25T00:00:00.000Z'
			},
			senderName: 'Info',
			to: ['test@example.net'],
			subject: 'Local smoke',
			text: 'Body',
			idempotencyKey: 'local-smoke-key'
		});

		assert.equal(requestUrl, 'http://127.0.0.1:8788/emails');
		assert.equal(result.providerId, 'fake-provider-id');
	});

	test('rejects a non-loopback FakeProvider origin before provider calls', () => {
		assert.throws(
			() => createResendProvider('re_test', undefined, 'quickmail.example', 'https://collector.example'),
			/loopback/i
		);
	});

	test('rejects a sender outside RESEND_SEND_DOMAINS before a provider call', async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response(JSON.stringify({ id: 'must-not-send' }));
		}) as typeof fetch;
		const provider = createResendProvider('re_test', 'example.com', 'allowed.example');
		await assert.rejects(
			provider.send({ from: { domain_name: 'blocked.example' } } as never),
			/error|configured/i
		);
		assert.equal(fetchCalls, 0);
	});

	test('rejects every send when zero or multiple Resend send domains are configured', async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response('{}');
		}) as typeof fetch;
		for (const configured of ['', 'one.example,two.example']) {
			const provider = createResendProvider('re_test', undefined, configured);
			await assert.rejects(
				provider.send({ from: { domain_name: 'one.example' } } as never),
				/configured/i
			);
		}
		assert.equal(fetchCalls, 0);
	});

	test('reports a send-only Resend domain as receivable when Email Routing owns inbound', async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return domainResponse('example.com');
		}) as typeof fetch;

		const provider = createResendProvider(
			're_test',
			'EXAMPLE.COM',
			'example.com'
		);
		const [domain] = await provider.listDomains();

		assert.equal(domain.sendingEnabled, true);
		assert.equal(domain.receivingEnabled, true);
		assert.equal(fetchCalls, 0);
		assert.equal((await provider.getDomain('example.com')).name, 'example.com');
	});

	test('does not claim Cloudflare inbound for an unrelated domain', async () => {
		globalThis.fetch = (async () => domainResponse('other.example')) as typeof fetch;

		const provider = createResendProvider(
			're_test',
			'example.com'
		);
		const [domain] = await provider.listDomains();

		assert.equal(domain.name, 'example.com');
		assert.equal(domain.sendingEnabled, false);
		assert.equal(domain.receivingEnabled, true);
	});

	test('ignores Resend receiving capability when Cloudflare owns inbound', async () => {
		globalThis.fetch = (async () => {
			const payload = (await domainResponse('other.example').json()) as {
				data: Array<{ capabilities: { receiving: string } }>;
			};
			payload.data[0].capabilities.receiving = 'enabled';
			return new Response(JSON.stringify(payload));
		}) as typeof fetch;

		const provider = createResendProvider(
			're_test',
			'example.com'
		);
		const [domain] = await provider.listDomains();

		assert.equal(domain.name, 'example.com');
		assert.equal(domain.sendingEnabled, false);
		assert.equal(domain.receivingEnabled, true);
	});
});
