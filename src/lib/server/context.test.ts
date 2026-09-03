import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
	ConfigError,
	getEmailProvider,
	getInboundEmailProviderKind,
	getSetupEmailProvider,
	listSetupAvailableDomains
} from './context';

function platform(env: Record<string, unknown>): App.Platform {
	return { env } as unknown as App.Platform;
}

describe('inbound provider configuration', () => {
	test('allows Cloudflare inbound with Resend outbound', () => {
		assert.equal(
			getInboundEmailProviderKind(
				platform({ EMAIL_PROVIDER: 'resend', INBOUND_EMAIL_PROVIDER: 'cloudflare' })
			),
			'cloudflare'
		);
	});

	test('falls back to the outbound provider for legacy deployments', () => {
		assert.equal(getInboundEmailProviderKind(platform({ EMAIL_PROVIDER: 'resend' })), 'resend');
	});

	test('rejects an unknown inbound provider', () => {
		assert.throws(
			() => getInboundEmailProviderKind(platform({ INBOUND_EMAIL_PROVIDER: 'typo' })),
			ConfigError
		);
	});

	test('keeps the default hybrid deploy send-only through Resend', () => {
		const wrangler = readFileSync(new URL('../../../wrangler.jsonc', import.meta.url), 'utf8');
		const setup = readFileSync(new URL('../../../scripts/setup.mjs', import.meta.url), 'utf8');
		assert.match(wrangler, /"EMAIL_PROVIDER": "resend"/);
		assert.match(wrangler, /"INBOUND_EMAIL_PROVIDER": "cloudflare"/);
		assert.doesNotMatch(wrangler, /"send_email"\s*:/);
		assert.match(setup, /configureSetupTemplate\(source,/);
		assert.match(setup, /EMAIL_PROVIDER: 'resend'/);
		assert.doesNotMatch(setup, /--provider|askProvider/);
	});

	test('documents Cloudflare inbound without switching outbound away from Resend', () => {
		const readme = readFileSync(
			new URL('../../../docs/setup-and-operations.md', import.meta.url),
			'utf8'
		);
		assert.match(readme, /`INBOUND_EMAIL_PROVIDER=cloudflare`、`EMAIL_PROVIDER=resend`が標準/);
		assert.match(readme, /受信には、対象ドメインのDNSゾーンをCloudflareで管理する必要があります/);
		assert.match(readme, /Resend Receivingを有効にしない/);
	});

	test('local first-admin setup discovers inbound domains without a Resend key and keeps send closed', async () => {
		const local = platform({
			EMAIL_PROVIDER: 'resend',
			INBOUND_EMAIL_PROVIDER: 'cloudflare',
			CLOUDFLARE_MAIL_DOMAINS: 'example.com'
		});
		let fetchCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			throw new Error('network must not be used');
		}) as typeof fetch;
		try {
			const [domain] = await listSetupAvailableDomains(local, true);
			assert.equal(domain.name, 'example.com');
			assert.equal(domain.can_receive, true);
			assert.equal(domain.can_send, false);
			const provider = getSetupEmailProvider(local, true);
			assert.equal((await provider.getDomain('example.com')).name, 'example.com');
			await assert.rejects(
				provider.send({} as never),
				(error: unknown) =>
					error instanceof Error && error.message === 'Resend sending is not configured'
			);
			assert.throws(() => getEmailProvider(local), ConfigError);
			assert.equal(fetchCalls, 0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
