import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8');

test('does not persist any secret into plaintext env files or print secret values', () => {
	assert.doesNotMatch(
		source,
		/upsertEnvFile\([^\n]+\b(?:BOOTSTRAP_SECRET|RESEND_API_KEY|RESEND_WEBHOOK_SECRET)\b/
	);
	assert.doesNotMatch(source, /bootstrapPlan\.(?:displayOnce|localUpdates|input)/);
	assert.doesNotMatch(source, /resend\.(?:apiKey|webhookSecret)/);
});

test('does not default to the first Cloudflare identity', () => {
	assert.doesNotMatch(source, /accounts\[0\]/);
	assert.match(source, /selectExactProviderIdentity/);
	assert.match(source, /providerIdentityFingerprint/);
});

test('does not let yes mode choose names, approve writes, or deploy', () => {
	assert.doesNotMatch(source, /if \(args\.yes\) return/);
	assert.match(source, /assertSafeSetupMode/);
});

test('rejects yes mode before setup can invoke a provider', () => {
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL('./setup.mjs', import.meta.url)), '--yes', '--domain', 'example.com'],
		{
			encoding: 'utf8'
		}
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /--yes/);
	assert.doesNotMatch(
		`${result.stdout}\n${result.stderr}`,
		/Bun \d|Cloudflareへログイン|デプロイしました/
	);
});

test('deploys only the domain-restricted sending credential', () => {
	assert.match(source, /buildResendCredentialPlan/);
	assert.match(source, /putSecret\('RESEND_API_KEY',\s*credentialPlan\.sendingCredential\)/);
	assert.doesNotMatch(
		source,
		/putSecret\('RESEND_API_KEY',\s*(?:apiKey|credentialPlan\.setupCredential)\)/
	);
});

test('records Resend send-domain metadata only after verified setup attestation', () => {
	assert.match(source, /if \(resend\.domainOk\) \{[\s\S]*RESEND_SEND_DOMAINS/u);
	assert.doesNotMatch(
		source,
		/CLOUDFLARE_MAIL_DOMAINS:\s*domain,[\s\S]{0,100}RESEND_SEND_DOMAINS:\s*domain/u
	);
});

test('fails closed when Resend webhook inspection fails and instructs setup-key revocation', () => {
	assert.match(source, /Webhook一覧を確認できませんでした。重複作成を避けるため停止/);
	assert.match(source, /一時セットアップ用キーを失効/);
});

test('uses the reviewed lockfile and never mutates dependency versions', () => {
	assert.match(source, /\['install', '--frozen-lockfile'\]/);
	const unsafeInstaller = new RegExp(['@', 'latest|bun add|cu', 'rl[^\\n]*\\|'].join(''));
	assert.doesNotMatch(source, unsafeInstaller);
	assert.doesNotMatch(source, /\['x', 'wrangler'/);
});

test('rejects every Bun runtime except the reviewed 1.3.14 release', () => {
	assert.match(source, /version !== '1\.3\.14'/u);
	assert.match(source, /Bun 1\.3\.14が必要です/u);
	const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.equal(pkg.packageManager, 'bun@1.3.14');
	assert.match(source, /await ensureRuntime\(\);\n\s*if \(args\.localDev\)/u);
});

test('never adopts same-name D1 or R2 resources without an ownership manifest', () => {
	assert.doesNotMatch(source, /既存のD1 .*を使用します|既存のR2バケット .*を使用します/);
	assert.match(source, /assertResourceNameAvailable/);
});

test('does not mutate Email Routing without provider-derived zone state', () => {
	assert.doesNotMatch(source, /\['email', 'routing', 'enable'/);
});

test('forces workers.dev and exposes no custom-domain setup path', () => {
	assert.doesNotMatch(source, /askHostname|custom_domain|Web UIのホスト名/);
	assert.match(source, /Web UIはworkers\.devへデプロイします/);
});

test('local dev passes bootstrap through process memory, never argv or a file', () => {
	assert.match(source, /withLocalBootstrapEnvironment/);
	assert.match(source, /process\.env\.QUICKMAIL_BOOTSTRAP_SECRET/);
	assert.match(source, /buildAuthRateLimitSecretPlan\(randomBytes\(32\)\)/);
	assert.doesNotMatch(source, /\['run', 'dev',[^\]]*BOOTSTRAP_SECRET/);
});

test('stages an independent non-displayed auth rate-limit secret', () => {
	assert.match(source, /putSecret\('AUTH_RATE_LIMIT_SECRET'/);
	assert.doesNotMatch(source, /AUTH_RATE_LIMIT_SECRET[^\n]*(?:console|log|upsertEnvFile)/);
});
