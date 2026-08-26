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
		const provider = createResendProvider('re_test');
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

	test('reports a send-only Resend domain as receivable when Email Routing owns inbound', async () => {
		globalThis.fetch = (async () =>
			domainResponse('example.com')) as typeof fetch;

		const provider = createResendProvider(
			're_test',
			'EXAMPLE.COM'
		);
		const [domain] = await provider.listDomains();

		assert.equal(domain.sendingEnabled, true);
		assert.equal(domain.receivingEnabled, true);
	});

	test('does not claim Cloudflare inbound for an unrelated domain', async () => {
		globalThis.fetch = (async () => domainResponse('other.example')) as typeof fetch;

		const provider = createResendProvider(
			're_test',
			'example.com'
		);
		const [domain] = await provider.listDomains();

		assert.equal(domain.receivingEnabled, false);
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

		assert.equal(domain.receivingEnabled, false);
	});
});
