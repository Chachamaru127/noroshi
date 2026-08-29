import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createOpaqueSecret, isOpaqueSecret, opaqueSecretsEqual } from './setup-secret-broker.mjs';

export const KNOWN_RUNTIME_SECRET_NAMES = Object.freeze([
	'BOOTSTRAP_SECRET',
	'AUTH_RATE_LIMIT_SECRET',
	'RESEND_API_KEY',
	'RESEND_WEBHOOK_SECRET'
]);

export function removeKnownSecretAssignments(source) {
	const names = KNOWN_RUNTIME_SECRET_NAMES.join('|');
	return String(source)
		.split(/\r?\n/u)
		.filter((line) => !new RegExp(`^\\s*#?\\s*(?:${names})\\s*=`, 'u').test(line))
		.join('\n');
}

export function setFirstString(source, key, value) {
	return source.replace(new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`), `$1${value}$2`);
}

export function markVerifiedResendSendDomain(source, domain) {
	const normalized = String(domain).trim().toLowerCase();
	if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u.test(normalized)) {
		throw new Error('verified Resend domain is invalid');
	}
	if (!/"RESEND_SEND_DOMAINS"\s*:\s*"[^"]*"/u.test(source)) {
		throw new Error('RESEND_SEND_DOMAINS is missing from the setup template');
	}
	return setFirstString(source, 'RESEND_SEND_DOMAINS', normalized);
}

export function persistVerifiedResendSendDomain({ domainOk, domain, read, write }) {
	if (!domainOk) return false;
	write(markVerifiedResendSendDomain(read(), domain));
	return true;
}

export function setRoutes(source, hostname) {
	const active = /\n\t"routes": \[[\s\S]*?\n\t\],?\n/;
	if (!hostname) return source.replace(active, '\n');

	const block = `\t"routes": [\n\t\t{\n\t\t\t"pattern": "${hostname}",\n\t\t\t"custom_domain": true\n\t\t}\n\t],\n`;
	if (active.test(source)) return source.replace(active, `\n${block}`);
	if (/\t\/\/ "routes": \[[\s\S]*?\t\/\/ \],\n/.test(source)) {
		return source.replace(/\t\/\/ "routes": \[[\s\S]*?\t\/\/ \],\n/, block);
	}
	return source.replace(/("workers_dev": true,\n)/, `$1\n${block}`);
}

export function setVars(source, { provider, inboundProvider, domains }) {
	const lines = [`\t\t"EMAIL_PROVIDER": "${provider}"`];
	if (inboundProvider) lines.push(`\t\t"INBOUND_EMAIL_PROVIDER": "${inboundProvider}"`);
	if (domains) {
		lines.push(`\t\t"CLOUDFLARE_MAIL_DOMAINS": "${domains}"`);
		lines.push(`\t\t"RESEND_SEND_DOMAINS": ""`);
	} else {
		lines.push(`\t\t// "CLOUDFLARE_MAIL_DOMAINS": "example.com"`);
		lines.push(`\t\t// "RESEND_SEND_DOMAINS": "example.com"`);
	}
	const block = `\t"vars": {\n${lines.join(',\n')}\n\t}`;
	if (/\t"vars"\s*:\s*\{[\s\S]*?\n\t\}/.test(source)) {
		return source.replace(/\t"vars"\s*:\s*\{[\s\S]*?\n\t\}/, block);
	}
	return source.replace(/\n(\t(?:"send_email"|"d1_databases"))/, `\n${block},\n\n$1`);
}

export function removeSendEmailBinding(source) {
	const pattern = /\n\t"send_email"\s*:\s*\[[\s\S]*?\n\t\],?\n/;
	return source.replace(pattern, '\n');
}

export function removeAddresses(source) {
	return source.replace(/\n\t"addresses"\s*:\s*\[[^\]]*\]\s*,?/, '\n');
}

export function generateBootstrapSecret(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24) {
		throw new Error('セットアップキーの生成には24バイト以上の乱数が必要です。');
	}
	return Buffer.from(bytes).toString('base64url');
}

export function buildBootstrapSecretPlan(secret) {
	const value = String(secret).trim();
	if (value.length < 24 || /\s/.test(value)) {
		throw new Error('セットアップキーは空白を含まない24文字以上で指定してください。');
	}
	return {
		wranglerArgs: ['secret', 'put', 'BOOTSTRAP_SECRET'],
		secret: createOpaqueSecret(value)
	};
}

export function buildAuthRateLimitSecretPlan(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength < 32) {
		throw new Error('認証レート制限用シークレットには32バイト以上の乱数が必要です。');
	}
	return {
		wranglerArgs: ['secret', 'put', 'AUTH_RATE_LIMIT_SECRET'],
		secret: createOpaqueSecret(Buffer.from(bytes).toString('base64url'))
	};
}

export function providerIdentityFingerprint(provider, identity) {
	const id = String(identity?.id ?? '')
		.trim()
		.toLowerCase();
	const name = String(identity?.name ?? '').trim();
	if (!provider || !id) throw new Error('provider identity requires provider and id');
	return createHash('sha256').update(`${provider}\0${id}\0${name}`).digest('hex').slice(0, 12);
}

export function selectExactProviderIdentity(provider, identities, expected) {
	const id = String(expected?.id ?? '')
		.trim()
		.toLowerCase();
	const fingerprint = String(expected?.fingerprint ?? '')
		.trim()
		.toLowerCase();
	if (!id || !fingerprint) {
		throw new Error('プロバイダーの正確なIDと確認コードが必要です。');
	}
	const selected = identities.find((identity) => String(identity.id).toLowerCase() === id);
	if (!selected || providerIdentityFingerprint(provider, selected) !== fingerprint) {
		throw new Error('プロバイダーのIDまたは確認コードが一致しません。');
	}
	return selected;
}

export function buildResendCredentialPlan({
	setupCredential,
	sendingCredential,
	domain,
	keyMetadata,
	confirmationFingerprint,
	officialScreenAttested
}) {
	const normalizedDomain = String(domain).trim().toLowerCase();
	const metadata = {
		id: String(keyMetadata?.id ?? '').trim(),
		name: `${String(keyMetadata?.access ?? '').trim()}:${String(keyMetadata?.domain ?? '')
			.trim()
			.toLowerCase()}`
	};
	if (!officialScreenAttested) {
		throw new Error('Resend公式画面でキーID・権限・制限ドメインを確認してください。');
	}
	if (
		!metadata.id ||
		keyMetadata?.access !== 'sending_access' ||
		keyMetadata?.domain?.toLowerCase() !== normalizedDomain
	) {
		throw new Error('Resendキーはsending_accessかつ対象ドメイン限定であることを確認してください。');
	}
	if (
		providerIdentityFingerprint('resend-runtime-key', metadata) !==
		String(confirmationFingerprint).trim().toLowerCase()
	) {
		throw new Error('Resendキーの確認コードが一致しません。');
	}
	const opaqueSetup = isOpaqueSecret(setupCredential)
		? setupCredential
		: createOpaqueSecret(String(setupCredential).trim());
	const opaqueSending = isOpaqueSecret(sendingCredential)
		? sendingCredential
		: createOpaqueSecret(String(sendingCredential).trim());
	if (opaqueSecretsEqual(opaqueSetup, opaqueSending)) {
		throw new Error('一時セットアップ用とWorker送信用には別のキーが必要です。');
	}
	return {
		setupCredential: opaqueSetup,
		sendingCredential: opaqueSending,
		runtimeScope: { access: 'sending_access', domain: normalizedDomain }
	};
}

export async function createWebhookWithSecretBroker({
	create,
	remove,
	put,
	wrap = createOpaqueSecret
}) {
	const created = await create();
	const id = String(created?.id ?? '').trim();
	const value = created?.signing_secret ?? created?.svix_secret;
	if (!id || !value) {
		if (id) {
			try {
				await remove(id);
			} catch {
				throw new Error(`Webhook ${id} の補償削除に失敗しました。Resendで確認してください。`);
			}
		}
		throw new Error('Webhook作成結果を安全に確認できませんでした。');
	}
	try {
		await put(wrap(value));
		return id;
	} catch {
		try {
			await remove(id);
		} catch {
			throw new Error(`Webhook ${id} の補償削除に失敗しました。Resendで確認してください。`);
		}
		throw new Error('Webhookシークレットの保存に失敗したため、作成したWebhookを削除しました。');
	}
}

export function parseProviderCollection(value, label) {
	const rows = Array.isArray(value) ? value : value?.data;
	if (!Array.isArray(rows)) throw new Error(`${label}一覧の応答を解釈できないため停止します。`);
	return rows;
}

export function assertResourceNameAvailable(existingNames, name, label) {
	if (!Array.isArray(existingNames)) throw new Error(`${label}一覧を確認できないため停止します。`);
	if (existingNames.includes(name))
		throw new Error(`${label}"${name}"は既に存在します。所有権manifestなしでは採用しません。`);
}

export function buildChildEnvironment(base, extra = {}, omit = []) {
	const environment = { ...base, ...extra };
	for (const name of omit) delete environment[name];
	return environment;
}

export function assertSafeSetupMode({ yes, interactive }) {
	if (yes) {
		throw new Error(
			'--yesによる外部設定の一括承認は安全上サポートしていません。対話端末で実行してください。'
		);
	}
	if (!interactive) {
		throw new Error('セットアップは対話端末で実行してください。外部変更を無人実行しません。');
	}
}

export function configureSetupTemplate(
	source,
	{ workerName, databaseName, databaseId, bucketName, domain }
) {
	let configured = setFirstString(source, 'name', workerName);
	configured = setFirstString(configured, 'database_name', databaseName);
	configured = setFirstString(configured, 'database_id', databaseId);
	configured = setFirstString(configured, 'bucket_name', bucketName);
	configured = setVars(configured, {
		provider: 'resend',
		inboundProvider: 'cloudflare',
		domains: domain
	});
	configured = removeSendEmailBinding(configured);
	configured = setRoutes(configured, null);
	return removeAddresses(configured);
}
