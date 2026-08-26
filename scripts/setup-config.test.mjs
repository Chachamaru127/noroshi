import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
	buildBootstrapSecretPlan,
	configureSetupTemplate,
	generateBootstrapSecret,
	removeAddresses,
	removeSendEmailBinding,
	setVars
} from './setup-config.mjs';

const base = `{
\t"vars": {
\t\t"EMAIL_PROVIDER": "resend"
\t},
\t"d1_databases": []
}
`;

describe('setup provider config transforms', () => {
	test('points setup completion only at the deployed URL', () => {
		const setup = readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8');
		assert.match(
			setup,
			/const app = state\.publicUrl \? `\$\{state\.publicUrl\}\/setup` : 'デプロイ後のURLの\/setup';/
		);
	});

	test('inserts explicit hybrid vars without relying on a send binding anchor', () => {
		const configured = setVars(`{\n\t"d1_databases": []\n}\n`, {
			provider: 'resend',
			inboundProvider: 'cloudflare',
			domains: 'example.com'
		});
		assert.match(configured, /"EMAIL_PROVIDER": "resend"/);
		assert.match(configured, /"INBOUND_EMAIL_PROVIDER": "cloudflare"/);
		assert.match(configured, /"CLOUDFLARE_MAIL_DOMAINS": "example\.com"/);
	});

	test('removes legacy Cloudflare outbound capability from a fresh setup', () => {
		const legacy = base.replace(
			'\t"d1_databases": []',
			'\t"addresses": ["*@example.com"],\n\t"send_email": [\n\t\t{ "name": "EMAIL" }\n\t],\n\t"d1_databases": []'
		);
		const resend = removeAddresses(removeSendEmailBinding(legacy));
		assert.doesNotMatch(resend, /"addresses"\s*:/);
		assert.doesNotMatch(resend, /"send_email"\s*:/);
	});

	test('generates a one-time setup key and a non-logging secret plan', () => {
		const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
		const secret = generateBootstrapSecret(bytes);
		assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
		const plan = buildBootstrapSecretPlan(secret);
		assert.deepEqual(plan.wranglerArgs, ['secret', 'put', 'BOOTSTRAP_SECRET']);
		assert.equal(plan.input, secret);
		assert.deepEqual(plan.localUpdates, { BOOTSTRAP_SECRET: secret });
		assert.equal(plan.displayOnce, secret);
		assert.throws(() => buildBootstrapSecretPlan('short'), /24/);
	});

	test('generates a generic Resend outbound and Cloudflare inbound config', () => {
		const template = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
		const configured = configureSetupTemplate(template, {
			workerName: 'quickmail-ja',
			databaseName: 'quickmail-ja',
			databaseId: '00000000-0000-4000-8000-000000000000',
			bucketName: 'quickmail-ja-attachments',
			domain: 'example.com',
			hostname: null
		});
		assert.match(configured, /"name": "quickmail-ja"/);
		assert.match(configured, /"database_name": "quickmail-ja"/);
		assert.match(configured, /"bucket_name": "quickmail-ja-attachments"/);
		assert.match(configured, /"EMAIL_PROVIDER": "resend"/);
		assert.match(configured, /"INBOUND_EMAIL_PROVIDER": "cloudflare"/);
		assert.match(configured, /"CLOUDFLARE_MAIL_DOMAINS": "example\.com"/);
		assert.doesNotMatch(configured, /"send_email"\s*:/);
		assert.doesNotMatch(configured, /^\s*"routes"\s*:/m);
	});

	test('does not enable legacy Cloudflare outbound for a fresh setup request', () => {
		const template = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
		const configured = configureSetupTemplate(template, {
			workerName: 'quickmail-ja',
			databaseName: 'quickmail-ja',
			databaseId: '00000000-0000-4000-8000-000000000000',
			bucketName: 'quickmail-ja-attachments',
			domain: 'example.com',
			provider: 'cloudflare',
			hostname: null,
			useAddresses: true
		});
		assert.match(configured, /"EMAIL_PROVIDER": "resend"/);
		assert.doesNotMatch(configured, /"send_email"\s*:|"addresses"\s*:/);
	});
});
