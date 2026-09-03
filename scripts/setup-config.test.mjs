import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
	assertSafeSetupMode,
	buildAuthRateLimitSecretPlan,
	buildBootstrapSecretPlan,
	buildResendCredentialPlan,
	buildChildEnvironment,
	createWebhookWithSecretBroker,
	parseProviderCollection,
	assertResourceNameAvailable,
	configureSetupTemplate,
	markVerifiedResendSendDomain,
	persistVerifiedResendSendDomain,
	removeKnownSecretAssignments,
	generateBootstrapSecret,
	providerIdentityFingerprint,
	removeAddresses,
	removeSendEmailBinding,
	selectExactProviderIdentity,
	setVars
} from './setup-config.mjs';

import { isOpaqueSecret } from './setup-secret-broker.mjs';

const base = `{
\t"vars": {
\t\t"EMAIL_PROVIDER": "resend"
\t},
\t"d1_databases": []
}
`;

const resendKey = (label) => ['re', label, 'abcdefghijklmnopqrstuvwxyz'].join('_');

describe('setup provider config transforms', () => {
	test('records a verified Resend send domain without changing other resources', () => {
		const source =
			'{\n\t"vars": {\n\t\t"RESEND_SEND_DOMAINS": ""\n\t},\n\t"database_id": "keep-me"\n}\n';
		const configured = markVerifiedResendSendDomain(source, 'EXAMPLE.COM');
		assert.match(configured, /"RESEND_SEND_DOMAINS": "example\.com"/u);
		assert.match(configured, /"database_id": "keep-me"/u);
	});
	test('persists verified-domain metadata only after attestation to the production config', () => {
		let source = '{"vars":{"RESEND_SEND_DOMAINS":""}}';
		assert.equal(
			persistVerifiedResendSendDomain({
				domainOk: true,
				domain: 'EXAMPLE.COM',
				read: () => source,
				write: (next) => {
					source = next;
				}
			}),
			true
		);
		assert.match(source, /"RESEND_SEND_DOMAINS":"example\.com"/u);
		assert.throws(() =>
			persistVerifiedResendSendDomain({
				domainOk: true,
				domain: 'example.com',
				read: () => source,
				write: () => {
					throw new Error('disk unavailable');
				}
			})
		);
	});
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
		assert.match(configured, /"RESEND_SEND_DOMAINS": ""/);
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

	test('generates a one-time setup key and an opaque non-persistent secret plan', () => {
		const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
		const secret = generateBootstrapSecret(bytes);
		assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
		const plan = buildBootstrapSecretPlan(secret);
		assert.deepEqual(plan.wranglerArgs, ['secret', 'put', 'BOOTSTRAP_SECRET']);
		assert.equal(isOpaqueSecret(plan.secret), true);
		assert.equal(
			JSON.stringify(plan),
			'{"wranglerArgs":["secret","put","BOOTSTRAP_SECRET"],"secret":"[REDACTED]"}'
		);
		assert.equal('localUpdates' in plan, false);
		assert.equal('displayOnce' in plan, false);
		assert.throws(() => buildBootstrapSecretPlan('short'), /24/);
	});

	test('requires an exact provider identity and matching fingerprint', () => {
		const identities = [
			{ id: 'a'.repeat(32), name: 'Sandbox' },
			{ id: 'b'.repeat(32), name: 'Production' }
		];
		const fingerprint = providerIdentityFingerprint('cloudflare', identities[0]);
		assert.equal(
			selectExactProviderIdentity('cloudflare', identities, {
				id: identities[0].id,
				fingerprint
			}),
			identities[0]
		);
		assert.throws(
			() => selectExactProviderIdentity('cloudflare', identities, {}),
			/正確なIDと確認コード/
		);
		assert.throws(
			() =>
				selectExactProviderIdentity('cloudflare', identities, {
					id: identities[0].id,
					fingerprint: providerIdentityFingerprint('cloudflare', identities[1])
				}),
			/一致しません/
		);
	});

	test('separates a temporary Resend setup credential from the domain-restricted sending key', () => {
		const metadata = { id: 'key_123', access: 'sending_access', domain: 'mail.example.com' };
		const plan = buildResendCredentialPlan({
			setupCredential: resendKey('setup'),
			sendingCredential: resendKey('send'),
			domain: 'mail.example.com',
			keyMetadata: metadata,
			officialScreenAttested: true,
			confirmationFingerprint: providerIdentityFingerprint('resend-runtime-key', {
				id: metadata.id,
				name: 'sending_access:mail.example.com'
			})
		});
		assert.equal(isOpaqueSecret(plan.setupCredential), true);
		assert.equal(isOpaqueSecret(plan.sendingCredential), true);
		assert.deepEqual(plan.runtimeScope, {
			access: 'sending_access',
			domain: 'mail.example.com'
		});
		assert.equal(JSON.stringify(plan).includes('re_'), false);
		assert.throws(
			() =>
				buildResendCredentialPlan({
					setupCredential: resendKey('same'),
					sendingCredential: resendKey('same'),
					domain: 'mail.example.com',
					keyMetadata: metadata,
					officialScreenAttested: true,
					confirmationFingerprint: providerIdentityFingerprint('resend-runtime-key', {
						id: metadata.id,
						name: 'sending_access:mail.example.com'
					})
				}),
			/別のキー/
		);
		assert.throws(
			() =>
				buildResendCredentialPlan({
					setupCredential: resendKey('setup'),
					sendingCredential: resendKey('send'),
					domain: 'mail.example.com',
					keyMetadata: { ...metadata, access: 'full_access' },
					officialScreenAttested: true,
					confirmationFingerprint: 'bad'
				}),
			/sending_access/
		);
		assert.throws(
			() =>
				buildResendCredentialPlan({
					setupCredential: resendKey('setup'),
					sendingCredential: resendKey('send'),
					domain: 'mail.example.com',
					keyMetadata: metadata,
					confirmationFingerprint: 'missing',
					officialScreenAttested: false
				}),
			/公式画面/
		);
	});

	test('creates an independent opaque auth rate-limit secret', () => {
		const plan = buildAuthRateLimitSecretPlan(new Uint8Array(32));
		assert.deepEqual(plan.wranglerArgs, ['secret', 'put', 'AUTH_RATE_LIMIT_SECRET']);
		assert.equal(isOpaqueSecret(plan.secret), true);
		assert.throws(() => buildAuthRateLimitSecretPlan(new Uint8Array(31)), /32/);
	});

	test('deletes exactly a newly-created webhook when secret storage fails', async () => {
		const removed = [];
		await assert.rejects(
			() =>
				createWebhookWithSecretBroker({
					create: async () => ({ id: 'wh_123', signing_secret: 'opaque-value' }),
					remove: async (id) => removed.push(id),
					put: async () => {
						throw new Error('store failed');
					}
				}),
			/削除しました/
		);
		assert.deepEqual(removed, ['wh_123']);
		await assert.rejects(
			() =>
				createWebhookWithSecretBroker({
					create: async () => ({ id: 'wh_missing' }),
					remove: async () => {
						throw new Error('provider detail');
					},
					put: async () => {}
				}),
			/Webhook wh_missing の補償削除/
		);
	});

	test('fails closed on malformed provider lists and same-name resources', () => {
		assert.throws(() => parseProviderCollection(null, 'Webhook'), /解釈できない/);
		assert.throws(() => parseProviderCollection({}, 'D1'), /解釈できない/);
		assert.deepEqual(parseProviderCollection({ data: [] }, 'Webhook'), []);
		assert.throws(
			() => assertResourceNameAvailable(['owned-name'], 'owned-name', 'D1'),
			/manifestなし/
		);
		assert.doesNotThrow(() => assertResourceNameAvailable([], 'new-name', 'R2'));
	});

	test('removes the setup input name at the actual child environment merge', () => {
		const env = buildChildEnvironment(
			{
				NOROSHI_BOOTSTRAP_SECRET: 'operator-input',
				NOROSHI_AUTH_RATE_LIMIT_SECRET: 'input-alias',
				PATH: '/bin'
			},
			{ BOOTSTRAP_SECRET: 'runtime-only', AUTH_RATE_LIMIT_SECRET: 'independent-random' },
			['NOROSHI_BOOTSTRAP_SECRET', 'NOROSHI_AUTH_RATE_LIMIT_SECRET']
		);
		assert.deepEqual(env, {
			PATH: '/bin',
			BOOTSTRAP_SECRET: 'runtime-only',
			AUTH_RATE_LIMIT_SECRET: 'independent-random'
		});
		assert.notEqual(env.BOOTSTRAP_SECRET, env.AUTH_RATE_LIMIT_SECRET);
	});

	test('removes every known legacy secret assignment before rewriting local settings', () => {
		const poisoned = `EMAIL_PROVIDER=legacy
BOOTSTRAP_SECRET=bootstrap-canary
# AUTH_RATE_LIMIT_SECRET=auth-canary
 RESEND_API_KEY = resend-canary
RESEND_WEBHOOK_SECRET=webhook-canary
VAPID_PRIVATE_KEY=vapid-preserved
CLOUDFLARE_MAIL_DOMAINS=old.example
`;
		const cleaned = removeKnownSecretAssignments(poisoned);
		assert.equal(cleaned.includes('canary'), false);
		for (const key of [
			'BOOTSTRAP_SECRET',
			'AUTH_RATE_LIMIT_SECRET',
			'RESEND_API_KEY',
			'RESEND_WEBHOOK_SECRET'
		]) {
			assert.doesNotMatch(cleaned, new RegExp(`^\\s*#?\\s*${key}\\s*=`, 'mu'));
		}
		assert.match(cleaned, /EMAIL_PROVIDER=legacy/u);
		assert.match(cleaned, /CLOUDFLARE_MAIL_DOMAINS=old\.example/u);
		assert.match(cleaned, /VAPID_PRIVATE_KEY=vapid-preserved/u);
	});

	test('rejects unattended broad yes mode before any setup work', () => {
		assert.throws(() => assertSafeSetupMode({ yes: true, interactive: true }), /--yes/);
		assert.throws(() => assertSafeSetupMode({ yes: false, interactive: false }), /対話端末/);
		assert.doesNotThrow(() => assertSafeSetupMode({ yes: false, interactive: true }));
	});

	test('generates a generic Resend outbound and Cloudflare inbound config', () => {
		const template = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
		const configured = configureSetupTemplate(template, {
			workerName: 'noroshi',
			databaseName: 'noroshi',
			databaseId: '00000000-0000-4000-8000-000000000000',
			bucketName: 'noroshi-attachments',
			domain: 'example.com',
			hostname: null
		});
		assert.match(configured, /"name": "noroshi"/);
		assert.match(configured, /"database_name": "noroshi"/);
		assert.match(configured, /"bucket_name": "noroshi-attachments"/);
		assert.match(configured, /"EMAIL_PROVIDER": "resend"/);
		assert.match(configured, /"INBOUND_EMAIL_PROVIDER": "cloudflare"/);
		assert.match(configured, /"CLOUDFLARE_MAIL_DOMAINS": "example\.com"/);
		assert.match(configured, /"RESEND_SEND_DOMAINS": ""/);
		assert.doesNotMatch(configured, /"send_email"\s*:/);
		assert.doesNotMatch(configured, /^\s*"routes"\s*:/m);
	});

	test('does not enable legacy Cloudflare outbound for a fresh setup request', () => {
		const template = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
		const configured = configureSetupTemplate(template, {
			workerName: 'noroshi',
			databaseName: 'noroshi',
			databaseId: '00000000-0000-4000-8000-000000000000',
			bucketName: 'noroshi-attachments',
			domain: 'example.com',
			provider: 'cloudflare',
			hostname: null,
			useAddresses: true
		});
		assert.match(configured, /"EMAIL_PROVIDER": "resend"/);
		assert.doesNotMatch(configured, /"send_email"\s*:|"addresses"\s*:/);
	});
});
