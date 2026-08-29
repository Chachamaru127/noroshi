#!/usr/bin/env bun
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildAuthRateLimitSecretPlan, markVerifiedResendSendDomain } from './setup-config.mjs';
import { putOpaqueSecret } from './setup-secret-broker.mjs';

export async function ensureUpgradeAuthSecret({ list, put, random = () => randomBytes(32) }) {
	const before = await list();
	if (!Array.isArray(before))
		throw new Error('Workerシークレット一覧を確認できないため停止します。');
	if (before.some((item) => item?.name === 'AUTH_RATE_LIMIT_SECRET')) return { staged: false };
	const plan = buildAuthRateLimitSecretPlan(random());
	putOpaqueSecret({ name: 'AUTH_RATE_LIMIT_SECRET', secret: plan.secret, put });
	const after = await list();
	if (!Array.isArray(after) || !after.some((item) => item?.name === 'AUTH_RATE_LIMIT_SECRET')) {
		throw new Error('AUTH_RATE_LIMIT_SECRETの登録を確認できないためデプロイを停止します。');
	}
	return { staged: true };
}

export function buildExistingDeploymentUpgradeConfig({
	source,
	resendSendDomain,
	domainRestrictedKeyConfirmed,
	secrets
}) {
	const current = source.match(/"RESEND_SEND_DOMAINS"\s*:\s*"([^"]*)"/u)?.[1] ?? '';
	if (
		current
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean).length > 1
	) {
		throw new Error('既存の複数送信ドメインをQMJ-9へ安全に移行できないため停止します。');
	}
	if (!domainRestrictedKeyConfirmed) {
		throw new Error('Resendの送信キーが対象ドメインだけに制限されていることを確認してください。');
	}
	if (!Array.isArray(secrets) || !secrets.some((item) => item?.name === 'RESEND_API_KEY')) {
		throw new Error('既存WorkerのRESEND_API_KEYを確認できないためデプロイを停止します。');
	}
	return markVerifiedResendSendDomain(source, resendSendDomain);
}

export function writeUpgradeConfigAtomically(path, contents) {
	const temporary = `${path}.qmj9-${process.pid}.tmp`;
	try {
		writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

export function parseUpgradeSendDomainArgs(args) {
	const domains = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === '--resend-send-domain') domains.push(args[index + 1] ?? '');
	}
	if (domains.length > 1) {
		throw new Error('QMJ-9ではResend送信ドメインは1件だけです。複数ドメインの受信は継続できます。');
	}
	return domains[0] ?? '';
}

if (import.meta.main) {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const args = process.argv.slice(2);
	const resendSendDomain = parseUpgradeSendDomainArgs(args);
	const domainRestrictedKeyConfirmed = args.includes('--confirm-domain-restricted-resend-key');
	if (!resendSendDomain) {
		throw new Error('--resend-send-domain <name> が必要です。推測では続行しません。');
	}
	console.log('QMJ-9セキュリティ更新: 送信ドメイン許可リストと認証保護シークレットを確認します。');
	const wrangler = join(root, 'node_modules', '.bin', 'wrangler');
	const wranglerConfig = join(root, 'wrangler.jsonc');
	const run = (args, input) => {
		const result = spawnSync(wrangler, args, { cwd: root, encoding: 'utf8', input });
		if (result.status !== 0) throw new Error(`${args.join(' ')} failed`);
		return result.stdout;
	};
	const list = () => JSON.parse(run(['secret', 'list', '--format', 'json']));
	const secrets = await list();
	const nextConfig = buildExistingDeploymentUpgradeConfig({
		source: readFileSync(wranglerConfig, 'utf8'),
		resendSendDomain,
		domainRestrictedKeyConfirmed,
		secrets
	});
	const result = await ensureUpgradeAuthSecret({
		list,
		put: (name, value) => run(['secret', 'put', name], `${value}\n`)
	});
	writeUpgradeConfigAtomically(wranglerConfig, nextConfig);
	if (readFileSync(wranglerConfig, 'utf8') !== nextConfig) {
		throw new Error('RESEND_SEND_DOMAINSの保存を確認できないためデプロイを停止します。');
	}
	console.log(
		result.staged
			? '✓ 認証保護シークレットを登録・確認しました。'
			: '✓ 認証保護シークレットは登録済みです。'
	);
}
