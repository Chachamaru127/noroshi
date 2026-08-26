import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { ConfigError, getInboundEmailProviderKind } from './context';

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
		const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
		assert.match(readme, /`INBOUND_EMAIL_PROVIDER=cloudflare`、`EMAIL_PROVIDER=resend`が標準/);
		assert.match(readme, /受信には、対象ドメインのDNSゾーンをCloudflareで管理する必要があります/);
		assert.match(readme, /Resend Receivingを有効にしない/);
	});
});
