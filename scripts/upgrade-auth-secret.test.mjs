import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	buildExistingDeploymentUpgradeConfig,
	ensureUpgradeAuthSecret,
	parseUpgradeSendDomainArgs,
	writeUpgradeConfigAtomically
} from './upgrade-auth-secret.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('stages and verifies a non-displayed auth secret for an existing deployment', async () => {
	const canary = 'upgrade-auth-secret-canary-value';
	let state = [];
	let observed = null;
	const result = await ensureUpgradeAuthSecret({
		list: async () => state,
		put: (name, value) => {
			observed = { name, length: value.length, leaked: value === canary };
			state = [{ name }];
		},
		random: () => Buffer.from(canary.padEnd(32, 'x'))
	});
	assert.deepEqual(result, { staged: true });
	assert.equal(observed.name, 'AUTH_RATE_LIMIT_SECRET');
	assert.equal(observed.length >= 32, true);
	assert.equal(JSON.stringify({ result, observed }).includes(canary), false);
});

test('fails closed when secret readback is unavailable or absent', async () => {
	await assert.rejects(
		() => ensureUpgradeAuthSecret({ list: async () => null, put: () => {} }),
		/停止/u
	);
	await assert.rejects(
		() =>
			ensureUpgradeAuthSecret({
				list: async () => [],
				put: () => {},
				random: () => Buffer.alloc(32, 1)
			}),
		/デプロイを停止/u
	);
});

test('requires an explicit verified send domain and a present restricted Resend key', () => {
	const source = '{"vars":{"RESEND_SEND_DOMAINS":""}}';
	assert.throws(
		() =>
			buildExistingDeploymentUpgradeConfig({
				source,
				resendSendDomain: 'example.com',
				domainRestrictedKeyConfirmed: false,
				secrets: [{ name: 'RESEND_API_KEY' }]
			}),
		/制限/u
	);
	assert.throws(
		() =>
			buildExistingDeploymentUpgradeConfig({
				source,
				resendSendDomain: 'example.com',
				domainRestrictedKeyConfirmed: true,
				secrets: []
			}),
		/デプロイを停止/u
	);
	assert.throws(() =>
		buildExistingDeploymentUpgradeConfig({
			source,
			resendSendDomain: '$&',
			domainRestrictedKeyConfirmed: true,
			secrets: [{ name: 'RESEND_API_KEY' }]
		})
	);
	assert.throws(
		() =>
			buildExistingDeploymentUpgradeConfig({
				source: '{"vars":{"RESEND_SEND_DOMAINS":"example.com,second.example"}}',
				resendSendDomain: 'example.com',
				domainRestrictedKeyConfirmed: true,
				secrets: [{ name: 'RESEND_API_KEY' }]
			}),
		/停止/u
	);
	const configured = buildExistingDeploymentUpgradeConfig({
		source,
		resendSendDomain: 'EXAMPLE.COM',
		domainRestrictedKeyConfirmed: true,
		secrets: [{ name: 'RESEND_API_KEY' }]
	});
	assert.match(configured, /"RESEND_SEND_DOMAINS":"example\.com"/u);
	assert.throws(() =>
		parseUpgradeSendDomainArgs([
			'--resend-send-domain',
			'example.com',
			'--resend-send-domain',
			'second.example'
		])
	);
});

test('atomically replaces the single send-domain allowlist', () => {
	const directory = mkdtempSync(join(tmpdir(), 'noroshi-upgrade-'));
	const path = join(directory, 'wrangler.jsonc');
	try {
		writeFileSync(path, '{"vars":{"RESEND_SEND_DOMAINS":"old.example"}}');
		writeUpgradeConfigAtomically(path, '{"vars":{"RESEND_SEND_DOMAINS":"example.com"}}');
		assert.equal(readFileSync(path, 'utf8'), '{"vars":{"RESEND_SEND_DOMAINS":"example.com"}}');
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
