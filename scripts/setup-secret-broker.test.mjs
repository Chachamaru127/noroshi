import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import {
	createOpaqueSecret,
	isOpaqueSecret,
	putOpaqueSecret,
	withLocalBootstrapEnvironment,
	withOpaqueSecret
} from './setup-secret-broker.mjs';

const secretCanary = () => ['re', 'secret-canary', 'abcdefghijklmnopqrstuvwxyz'].join('_');

test('injects bootstrap only into local child runtime memory', () => {
	const secret = createOpaqueSecret('runtime-only-bootstrap-value');
	const authSecret = createOpaqueSecret('independent-runtime-rate-limit-value');
	let received;
	withLocalBootstrapEnvironment({
		secret,
		authRateLimitSecret: authSecret,
		mailDomain: 'example.com',
		environment: {
			SAFE: 'yes',
			NOROSHI_BOOTSTRAP_SECRET: 'operator-input',
			NOROSHI_AUTH_RATE_LIMIT_SECRET: 'must-not-pass',
			RESEND_API_KEY: 'poisoned-runtime-key',
			RESEND_WEBHOOK_SECRET: 'poisoned-webhook-key'
		},
		launch: (env) => {
			received = env;
		}
	});
	assert.deepEqual(received, {
		SAFE: 'yes',
		BOOTSTRAP_SECRET: 'runtime-only-bootstrap-value',
		AUTH_RATE_LIMIT_SECRET: 'independent-runtime-rate-limit-value',
		EMAIL_PROVIDER: 'resend',
		INBOUND_EMAIL_PROVIDER: 'cloudflare',
		CLOUDFLARE_MAIL_DOMAINS: 'example.com',
		RESEND_SEND_DOMAINS: ''
	});
	assert.notEqual(received.BOOTSTRAP_SECRET, received.AUTH_RATE_LIMIT_SECRET);
	assert.equal('RESEND_API_KEY' in received, false);
	assert.equal('RESEND_WEBHOOK_SECRET' in received, false);
	assert.equal(JSON.stringify(secret), '"[REDACTED]"');
});

test('keeps secret values opaque outside the native put boundary', () => {
	const raw = secretCanary();
	const secret = createOpaqueSecret(raw);
	assert.equal(isOpaqueSecret(secret), true);
	assert.equal(String(secret), '[REDACTED]');
	assert.equal(JSON.stringify(secret), '"[REDACTED]"');
	assert.equal(inspect(secret).includes(raw), false);
	assert.deepEqual(Object.keys(secret), []);
	assert.equal(
		withOpaqueSecret(secret, (value) => value === raw),
		true
	);
});

test('passes a secret directly to the native put seam without logging or persisting it', () => {
	const raw = secretCanary();
	const secret = createOpaqueSecret(raw);
	const calls = [];
	const result = putOpaqueSecret({
		name: 'RESEND_API_KEY',
		secret,
		put: (name, value) => {
			calls.push({ name, matches: value === raw });
			return { ok: true };
		}
	});
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(calls, [{ name: 'RESEND_API_KEY', matches: true }]);
	assert.equal(JSON.stringify({ secret, calls }).includes(raw), false);
});

test('rejects plain strings and unsupported secret names at the broker boundary', () => {
	assert.throws(
		() => putOpaqueSecret({ name: 'RESEND_API_KEY', secret: 'plain', put: () => {} }),
		/opaque secret/
	);
	assert.throws(
		() =>
			putOpaqueSecret({
				name: 'UNREVIEWED_SECRET',
				secret: createOpaqueSecret('secret'),
				put: () => {}
			}),
		/許可されていない/
	);
});
