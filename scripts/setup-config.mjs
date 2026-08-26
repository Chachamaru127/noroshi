import { Buffer } from 'node:buffer';

export function setFirstString(source, key, value) {
	return source.replace(new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`), `$1${value}$2`);
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
	} else {
		lines.push(`\t\t// "CLOUDFLARE_MAIL_DOMAINS": "example.com"`);
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
		input: value,
		localUpdates: { BOOTSTRAP_SECRET: value },
		displayOnce: value
	};
}

export function configureSetupTemplate(
	source,
	{ workerName, databaseName, databaseId, bucketName, domain, hostname }
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
	configured = setRoutes(configured, hostname);
	return removeAddresses(configured);
}
