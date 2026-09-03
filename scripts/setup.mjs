#!/usr/bin/env bun
/**
 * Interactive first-run setup for Noroshi.
 *
 * This is the repository's separate interactive CLI, outside the QMJ-10
 * provider-neutral setup-engine contract. It is intentionally not bundled in
 * the Agent Plugin and is never invoked by the setup MCP.
 *
 * Cloudflareへログインし、D1/R2、設定、メールドメインを準備します。
 *
 * Usage:
 *   bun run setup
 *   bash scripts/setup.sh
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as stdinStream, stdout as stdoutStream } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
	assertSafeSetupMode,
	buildAuthRateLimitSecretPlan,
	buildBootstrapSecretPlan,
	buildChildEnvironment,
	buildResendCredentialPlan,
	createWebhookWithSecretBroker,
	configureSetupTemplate,
	parseProviderCollection,
	assertResourceNameAvailable,
	providerIdentityFingerprint,
	selectExactProviderIdentity,
	persistVerifiedResendSendDomain,
	removeKnownSecretAssignments
} from './setup-config.mjs';
import {
	createOpaqueSecret,
	putOpaqueSecret,
	withOpaqueSecret,
	withLocalBootstrapEnvironment
} from './setup-secret-broker.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const wranglerFile = join(root, 'wrangler.jsonc');
const devVarsFile = join(root, '.dev.vars');
const devVarsExample = join(root, '.dev.vars.example');
const envFile = join(root, '.env');

const MIN_WRANGLER = [4, 123, 0];
const RESEND_WEBHOOK_EVENTS = [
	'email.sent',
	'email.delivered',
	'email.bounced',
	'email.complained',
	'email.delivery_delayed',
	'email.failed'
];

const tty = Boolean(stdoutStream.isTTY);
const c = {
	dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
	bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
	green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
	yellow: (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
	red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s)
};

const args = parseArgs(process.argv.slice(2));

if (args.help) {
	printHelp();
	process.exit(0);
}

let rl = null;

function printHelp() {
	console.log(`Noroshi セットアップ

Cloudflareへログインし、D1/R2、設定ファイル、受信・送信経路を準備します。
受信にはCloudflareで管理するDNSゾーンが必要です。標準の送信はResendです。

  bun run setup
  bash scripts/setup.sh

オプション:
  --domain <name>      メールドメイン（例: example.com）
  --d1-name <name>     D1名（例: noroshi）
  --r2-name <name>     R2名（例: noroshi-attachments）
  --yes                使用不可（外部変更の一括承認を拒否）
  --skip-deploy        最後のデプロイを行わない
  --local-dev          セットアップキーと明示ドメインをローカルdevへだけ渡す
  --help               このヘルプを表示
`);
}

function parseArgs(argv) {
	const out = {
		help: false,
		yes: false,
		skipDeploy: false,
		localDev: false,
		domain: null,
		d1Name: null,
		r2Name: null
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--help':
			case '-h':
				out.help = true;
				break;
			case '--yes':
			case '-y':
				out.yes = true;
				break;
			case '--skip-deploy':
				out.skipDeploy = true;
				break;
			case '--local-dev':
				out.localDev = true;
				break;
			case '--domain':
				out.domain = argv[++i] ?? '';
				break;
			case '--d1-name':
				out.d1Name = argv[++i] ?? '';
				break;
			case '--r2-name':
				out.r2Name = argv[++i] ?? '';
				break;
			default:
				if (arg.startsWith('--domain=')) out.domain = arg.slice('--domain='.length);
				else if (arg.startsWith('--d1-name=')) out.d1Name = arg.slice('--d1-name='.length);
				else if (arg.startsWith('--r2-name=')) out.r2Name = arg.slice('--r2-name='.length);
				else {
					console.error(`不明なオプションです: ${arg}`);
					printHelp();
					process.exit(1);
				}
		}
	}
	return out;
}

function log(message = '') {
	console.log(message);
}

function ok(message) {
	console.log(`  ${c.green('✓')} ${message}`);
}

function warn(message) {
	console.log(`  ${c.yellow('!')} ${message}`);
}

function fail(message) {
	console.error(`  ${c.red('✗')} ${message}`);
}

function section(step, total, title) {
	console.log(`\n${c.bold(`── ${step}/${total}  ${title}`)}`);
}

function which(cmd) {
	const probe =
		process.platform === 'win32'
			? spawnSync('where', [cmd], { encoding: 'utf8' })
			: spawnSync('sh', ['-c', `command -v ${shellQuote(cmd)}`], { encoding: 'utf8' });
	const path = probe.stdout?.trim().split(/\r?\n/)[0];
	return probe.status === 0 && path ? path : null;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bunBin() {
	return which('bun') || process.execPath;
}

function childEnv(extra = {}, omit = []) {
	const bins = [join(root, 'node_modules', '.bin')];
	return buildChildEnvironment(process.env, {
		PATH: `${bins.join(delimiter)}${delimiter}${process.env.PATH ?? ''}`,
		...extra
	}, omit);
}

function run(command, commandArgs, { inherit = false, input, env, omitEnv, allowFail = false, stdio } = {}) {
	const result = spawnSync(command, commandArgs, {
		cwd: root,
		encoding: 'utf8',
		env: childEnv(env, omitEnv),
		input,
		stdio: stdio ?? (inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'])
	});
	if (result.status !== 0 && !allowFail) {
		const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
		const error = new Error(
			detail || `${command} ${commandArgs.join(' ')} failed (exit ${result.status ?? 'null'})`
		);
		error.output = detail;
		error.status = result.status;
		throw error;
	}
	return result;
}

function wrangler(wranglerArgs, options = {}) {
	const local = join(
		root,
		'node_modules',
		'.bin',
		process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'
	);
	if (!existsSync(local)) throw new Error('ロック済みWranglerがありません。frozen installを完了してください。');
	return run(local, wranglerArgs, options);
}

function parseJsonOutput(text) {
	if (!text) return null;
	const start = text.search(/[\[{]/);
	if (start === -1) return null;
	try {
		return JSON.parse(text.slice(start));
	} catch {
		return null;
	}
}

function parseVersion(text) {
	const match = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

function versionGte(version, minimum) {
	for (let i = 0; i < 3; i++) {
		if (version[i] > minimum[i]) return true;
		if (version[i] < minimum[i]) return false;
	}
	return true;
}

function formatVersion(version) {
	return version.join('.');
}

async function ensureReadline() {
	if (!rl) {
		rl = readline.createInterface({ input: stdinStream, output: stdoutStream });
	}
	return rl;
}

async function closeReadline() {
	if (rl) {
		rl.close();
		rl = null;
	}
}

async function prompt(question, fallback = '') {
	if (!stdinStream.isTTY) {
		if (fallback) return fallback;
		throw new Error(`対話できない環境では値の指定が必要です: ${question}`);
	}
	const suffix = fallback ? ` ${c.dim(`(${fallback})`)}` : '';
	const input = await (await ensureReadline()).question(`  ${question}${suffix}: `);
	return input.trim() || fallback;
}

async function confirm(question, defaultYes = true) {
	if (!stdinStream.isTTY) {
		throw new Error(`対話できない環境では確認できません: ${question}`);
	}
	const hint = defaultYes ? 'Y/n' : 'y/N';
	const input = (await prompt(`${question} [${hint}]`)).toLowerCase();
	if (!input) return defaultYes;
	return input === 'y' || input === 'yes';
}

async function promptSecret(question) {
	if (!stdinStream.isTTY) {
		throw new Error(`対話できない環境では${question}を入力できません。端末で再実行してください。`);
	}
	await closeReadline();
	stdoutStream.write(`  ${question}: `);
	const value = await readMutedLine();
	stdoutStream.write('\n');
	return value.trim();
}

async function chooseBootstrapSecret() {
	const value = await promptSecret('パスワード管理ツールで作成したセットアップキー（24文字以上）');
	if (!value) throw new Error('セットアップキーは空欄にできません。');
	return buildBootstrapSecretPlan(value);
}

function readMutedLine() {
	return new Promise((resolve, reject) => {
		if (typeof stdinStream.setRawMode !== 'function') {
			const lineRl = readline.createInterface({ input: stdinStream, output: stdoutStream });
			lineRl
				.question('')
				.then((answer) => {
					lineRl.close();
					resolve(answer);
				}, reject);
			return;
		}

		stdinStream.setRawMode(true);
		stdinStream.resume();
		stdinStream.setEncoding('utf8');
		let value = '';

		const restore = () => {
			stdinStream.setRawMode(false);
			stdinStream.pause();
			stdinStream.removeListener('data', onData);
		};

		const onData = (char) => {
			if (char === '\n' || char === '\r' || char === '\u0004') {
				restore();
				resolve(value);
				return;
			}
			if (char === '\u0003') {
				restore();
				stdoutStream.write('\n');
				process.exit(1);
			}
			if (char === '\u007f' || char === '\b') {
				value = value.slice(0, -1);
				return;
			}
			if (char < ' ') return;
			value += char;
			stdoutStream.write('•');
		};

		stdinStream.on('data', onData);
	});
}

function readWrangler() {
	if (!existsSync(wranglerFile)) {
		throw new Error('wrangler.jsoncがありません。Noroshiのルートから実行してください。');
	}
	return readFileSync(wranglerFile, 'utf8');
}

function writeWrangler(source) {
	writeFileSync(wranglerFile, source.endsWith('\n') ? source : `${source}\n`);
}

function jsoncString(source, key) {
	return source.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))?.[1] ?? null;
}

function upsertEnvFile(file, updates, { fromExample = false } = {}) {
	let text = existsSync(file)
		? readFileSync(file, 'utf8')
		: fromExample && existsSync(devVarsExample)
			? readFileSync(devVarsExample, 'utf8')
			: '';

	for (const [key, value] of Object.entries(updates)) {
		if (value == null) continue;
		const line = `${key}=${value}`;
		const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
		if (re.test(text)) text = text.replace(re, line);
		else text = `${text.trimEnd()}\n${line}\n`;
	}

	writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
}

function normalizeDomain(raw) {
	let value = String(raw).trim().toLowerCase();
	value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
	if (value.includes('@')) value = value.slice(value.lastIndexOf('@') + 1);
	value = value.replace(/\.$/, '').replace(/^www\./, '');
	return value;
}

function isDomain(value) {
	return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(value);
}

function isWorkerName(value) {
	return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value);
}

function isR2BucketName(value) {
	return (
		value.length >= 3 &&
		value.length <= 63 &&
		/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)
	);
}

async function ensureRuntime() {
	const version = run(bunBin(), ['--version'], { allowFail: true }).stdout.trim();
	if (!version) throw new Error('Bunが必要です。https://bun.sh から導入して再実行してください。');
	if (version !== '1.3.14') {
		throw new Error(`Bun 1.3.14が必要です。現在は${version}です。公式手順で固定バージョンを導入してください。`);
	}
	ok(`Bun ${version}`);
}

function installDeps() {
	run(bunBin(), ['install', '--frozen-lockfile'], { inherit: true });
	ok('依存パッケージをBunで準備しました');
}

function wranglerVersion() {
	const result = wrangler(['--version'], { allowFail: true });
	return parseVersion(`${result.stdout}\n${result.stderr}`);
}

async function ensureWrangler() {
	if (!existsSync(join(root, 'node_modules', 'wrangler'))) {
		installDeps();
	}

	let version = wranglerVersion();
	ok(`wrangler ${formatVersion(version)}`);

	if (versionGte(version, MIN_WRANGLER)) return version;

	throw new Error(`ロック済みWrangler ${formatVersion(version)}は要件未満です。レビュー済みlockfileで${formatVersion(MIN_WRANGLER)}以上へ更新してください。`);
}

function parseWhoami(text) {
	const combined = text.trim();
	const unauthenticated = /not (logged in|authenticated)|please run.*login|login to continue/i.test(
		combined
	);
	const email =
		combined.match(/email ['"]([^'"]+)['"]/i)?.[1] ??
		combined.match(/\b([\w.+-]+@[\w.-]+\.[a-z]{2,})\b/i)?.[1] ??
		null;
	const accounts = [];
	const seen = new Set();
	for (const match of combined.matchAll(/([^\n│|]{2,64}?)[│|]\s*([0-9a-f]{32})/gi)) {
		const name = match[1].replace(/[│|]/g, '').trim();
		const id = match[2].toLowerCase();
		if (seen.has(id)) continue;
		seen.add(id);
		accounts.push({ name: name || id, id });
	}
	if (accounts.length === 0) {
		for (const match of combined.matchAll(/\b([0-9a-f]{32})\b/gi)) {
			const id = match[1].toLowerCase();
			if (seen.has(id)) continue;
			seen.add(id);
			accounts.push({ name: id, id });
		}
	}
	return { email, accounts, unauthenticated };
}

async function ensureLogin() {
	const who = wrangler(['whoami'], { allowFail: true });
	const parsed = parseWhoami(`${who.stdout}\n${who.stderr}`);
	if (who.status === 0 && !parsed.unauthenticated && (parsed.email || parsed.accounts.length)) {
		ok(parsed.email ? `${parsed.email}でログイン済み` : 'Cloudflareへログイン済み');
		return pickAccount(parsed.accounts);
	}

	log(`  ${c.dim('Cloudflareログイン用のブラウザを開きます…')}`);
	wrangler(['login'], { inherit: true });

	const again = wrangler(['whoami'], { allowFail: true });
	const next = parseWhoami(`${again.stdout}\n${again.stderr}`);
	if (again.status !== 0 || next.unauthenticated) {
		throw new Error('Cloudflareログインが完了しませんでした。`bunx wrangler login`後に再実行してください。');
	}
	ok(next.email ? `${next.email}でログインしました` : 'Cloudflareへログインしました');
	return pickAccount(next.accounts);
}

async function confirmExactIdentity(provider, identity, label) {
	const fingerprint = providerIdentityFingerprint(provider, identity);
	log(`  ${label}: ${identity.name}  ${c.dim(identity.id)}  確認コード: ${fingerprint}`);
	return selectExactProviderIdentity(provider, [identity], {
		id: await prompt(`${label}のID`),
		fingerprint: await prompt('表示された確認コード')
	});
}

async function pickAccount(accounts) {
	if (accounts.length === 0) {
		throw new Error('CloudflareアカウントIDを確認できませんでした。推測で続行しません。');
	}

	log('  Cloudflareアカウントを正確に確認してください:');
	accounts.forEach((account) => {
		const fingerprint = providerIdentityFingerprint('cloudflare', account);
		log(`    ${account.name}  ${c.dim(account.id)}  確認コード: ${fingerprint}`);
	});
	const chosen = selectExactProviderIdentity('cloudflare', accounts, {
		id: await prompt('使用するアカウントID'),
		fingerprint: await prompt('表示された確認コード')
	});
	upsertEnvFile(envFile, { CLOUDFLARE_ACCOUNT_ID: chosen.id });
	ok(`${chosen.name}を使用します`);
	return chosen;
}

async function askDomain() {
	if (args.domain) {
		const domain = normalizeDomain(args.domain);
		if (!isDomain(domain)) throw new Error(`--domainの形式が正しくありません: "${args.domain}"`);
		return domain;
	}
	while (true) {
		const domain = normalizeDomain(await prompt('メール用ドメイン（例: example.com）'));
		if (isDomain(domain)) return domain;
		warn('URLや@を付けず、example.comの形式で入力してください。');
	}
}

async function askWorkerName(current) {
	const fallback = current && isWorkerName(current) ? current : 'noroshi';
	while (true) {
		const name = (await prompt('Worker名', fallback)).toLowerCase();
		if (isWorkerName(name)) return name;
		warn('半角小文字、数字、ハイフンを使用してください。');
	}
}

async function askResourceName(question, fallback, flagValue, validate, invalidHint) {
	if (flagValue) {
		const name = flagValue.trim().toLowerCase();
		if (!validate(name)) throw new Error(`${question}の形式が正しくありません: "${flagValue}"。${invalidHint}`);
		return name;
	}
	while (true) {
		const raw = await prompt(question);
		const name = (raw || fallback).toLowerCase();
		if (validate(name)) return name;
		warn(invalidHint);
	}
}

function listD1() {
	const result = wrangler(['d1', 'list', '--json'], { allowFail: true });
	if (result.status !== 0) throw new Error('D1一覧を確認できないため、作成せず停止します。');
	const parsed = parseJsonOutput(`${result.stdout}\n${result.stderr}`);
	const rows = Array.isArray(parsed) ? parsed : parsed?.databases ?? parsed?.result;
	if (!Array.isArray(rows)) throw new Error('D1一覧の応答を解釈できないため、作成せず停止します。');
	const fromJson = rows
		.map((row) => ({
			name: row.name ?? row.database_name,
			id: row.uuid ?? row.id ?? row.database_id
		}))
		.filter((row) => row.name && row.id);
	if (fromJson.length !== rows.length) throw new Error('D1一覧に不完全な項目があるため停止します。');
	return fromJson;
}

function createD1(name) {
	const result = wrangler(['d1', 'create', name], {
		allowFail: true,
		env: { CI: 'true' }
	});
	const text = `${result.stdout}\n${result.stderr}`;
	const id =
		text.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1] ??
		text.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
	if (result.status === 0 && id) return id;
	if (/already exists/i.test(text)) {
		throw new Error(`D1データベース"${name}"は作成中に衝突しました。所有権を確認して再実行してください。`);
	}
	throw new Error(text.trim() || `D1データベース"${name}"を作成できませんでした。`);
}

async function ensureD1(databaseName) {
	const existing = listD1().find((row) => row.name === databaseName);
	assertResourceNameAvailable(existing ? [databaseName] : [], databaseName, 'D1データベース');

	log(`  ${c.dim(`D1データベース ${databaseName} を作成しています…`)}`);
	const id = createD1(databaseName);
	ok(`D1 ${databaseName} (${id})`);
	return id;
}

function listR2Names() {
	const result = wrangler(['r2', 'bucket', 'list', '--json'], { allowFail: true });
	if (result.status !== 0) throw new Error('R2一覧を確認できないため、作成せず停止します。');
	const parsed = parseJsonOutput(`${result.stdout}\n${result.stderr}`);
	const rows = Array.isArray(parsed) ? parsed : parsed?.buckets ?? parsed?.result;
	if (!Array.isArray(rows)) throw new Error('R2一覧の応答を解釈できないため、作成せず停止します。');
	const fromJson = rows
		.map((row) => (typeof row === 'string' ? row : row.name ?? row.Name))
		.filter(Boolean);
	if (fromJson.length !== rows.length) throw new Error('R2一覧に不完全な項目があるため停止します。');
	return fromJson;
}

function ensureR2(bucketName) {
	assertResourceNameAvailable(listR2Names(), bucketName, 'R2バケット');

	log(`  ${c.dim(`R2バケット ${bucketName} を作成しています…`)}`);
	const result = wrangler(['r2', 'bucket', 'create', bucketName], {
		allowFail: true,
		env: { CI: 'true' }
	});
	const text = `${result.stdout}\n${result.stderr}`;
	if (/already exists/i.test(text)) {
		throw new Error(`R2バケット"${bucketName}"は作成中に衝突しました。所有権を確認して再実行してください。`);
	}
	if (result.status === 0) {
		ok(`R2 bucket ${bucketName}`);
		return;
	}
	throw new Error(text.trim() || `R2バケット"${bucketName}"を作成できませんでした。`);
}

function setPackageMigrateScripts(databaseName) {
	const pkgPath = join(root, 'package.json');
	if (!existsSync(pkgPath)) return;
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
	if (!pkg.scripts) return;
	pkg.scripts['db:migrate:local'] = `wrangler d1 migrations apply ${databaseName} --local`;
	pkg.scripts['db:migrate:remote'] = `wrangler d1 migrations apply ${databaseName} --remote`;
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, '\t')}\n`);
}

function putSecret(name, secret) {
	putOpaqueSecret({
		name,
		secret,
		put: (secretName, value) =>
			wrangler(['secret', 'put', secretName], {
				input: value,
				stdio: ['pipe', 'inherit', 'inherit']
			})
	});
	ok(`${name}をWorkerシークレットとして保存しました`);
}

async function runLocalDev() {
	const raw = process.env.NOROSHI_BOOTSTRAP_SECRET?.trim();
	if (!raw) throw new Error('--local-devにはprocess環境のNOROSHI_BOOTSTRAP_SECRETが必要です。');
	const domain = args.domain
		? normalizeDomain(args.domain)
		: stdinStream.isTTY
			? normalizeDomain(await prompt('ローカル受信ドメイン（例: example.com）'))
			: '';
	if (!domain) throw new Error('非対話の--local-devには--domain <name>が必要です。');
	if (!isDomain(domain)) throw new Error(`--domainの形式が正しくありません: "${domain}"`);
	const secret = buildBootstrapSecretPlan(raw).secret;
	const authRateLimitSecret = buildAuthRateLimitSecretPlan(randomBytes(32)).secret;
	return withLocalBootstrapEnvironment({
		secret,
		authRateLimitSecret,
		mailDomain: domain,
		launch: (env) => run(bunBin(), ['run', 'dev'], {
			inherit: true,
			env,
			omitEnv: [
				'NOROSHI_BOOTSTRAP_SECRET',
				'NOROSHI_AUTH_RATE_LIMIT_SECRET',
				'RESEND_API_KEY',
				'RESEND_WEBHOOK_SECRET'
			]
		})
	});
}

function wranglerOutputLooksEnabled(text) {
	return /enabled:\s*true|status:\s*ready|successfully enabled/i.test(text);
}

function tryWrangler(wranglerArgs) {
	const result = wrangler(wranglerArgs, { allowFail: true });
	return {
		ok: result.status === 0,
		text: `${result.stdout}\n${result.stderr}`.trim()
	};
}

async function setupCloudflare(domain) {
	warn('Email Routingの変更は、Cloudflare画面でゾーンIDと現在状態を確認してから手動で行います。');
	log(`  ${c.dim(`対象: ${domain} / Dashboard: https://dash.cloudflare.com/?to=/:account/email-service/routing`)}`);

	const routingDns = tryWrangler(['email', 'routing', 'dns', 'get', domain]);
	if (routingDns.text) {
		log(`\n  ${c.bold('受信用DNS（apex MXはCloudflareの値だけを使います）')}`);
		log(
			routingDns.text
				.split('\n')
				.map((line) => `    ${line}`)
				.join('\n')
		);
	}

	const settings = tryWrangler(['email', 'routing', 'settings', domain]);
	if (settings.text && wranglerOutputLooksEnabled(settings.text)) {
		ok('Email Routingが有効であることを確認しました');
	}

}

async function resendFetch(credential, url, init = {}) {
	return withOpaqueSecret(credential, (value) =>
		fetch(url, {
			...init,
			headers: { ...init.headers, Authorization: `Bearer ${value}` }
		})
	);
}

async function listResendDomains(setupCredential) {
	const response = await resendFetch(setupCredential, 'https://api.resend.com/domains?limit=100');
	const raw = await response.text();
	const parsed = raw ? parseJsonOutput(raw) : null;
	if (!response.ok) {
		const message = parsed?.message ?? parsed?.error ?? `Resend API ${response.status}`;
		throw new Error(message);
	}
	return parsed?.data ?? [];
}

async function listResendWebhooks(setupCredential) {
	const response = await resendFetch(setupCredential, 'https://api.resend.com/webhooks');
	const raw = await response.text();
	const parsed = raw ? parseJsonOutput(raw) : null;
	if (!response.ok) {
		throw new Error('Resend Webhook一覧を確認できませんでした。重複作成を避けるため停止します。');
	}
	return parseProviderCollection(parsed, 'Resend Webhook');
}

async function createResendWebhook(setupCredential, endpoint) {
	const response = await resendFetch(setupCredential, 'https://api.resend.com/webhooks', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ endpoint, events: RESEND_WEBHOOK_EVENTS })
	});
	const raw = await response.text();
	const parsed = raw ? parseJsonOutput(raw) : null;
	if (!response.ok) {
		throw new Error(parsed?.message ?? parsed?.error ?? `Resend Webhookの作成に失敗しました（${response.status}）`);
	}
	return parsed;
}

async function deleteResendWebhook(setupCredential, id) {
	const response = await resendFetch(setupCredential, `https://api.resend.com/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
	if (!response.ok) throw new Error(`Webhook ${id} を削除できませんでした。`);
}

async function setupResend(domain) {
	log('  https://resend.com/api-keys で一時セットアップ用とWorker送信用の2つのキーを作成してください。');
	log('  Worker送信用はSending accessかつ対象ドメインだけに制限してください。');
	log('  Resendでは送信用DNSだけを追加します。Receivingやapex MXは追加しません。');

	const setupValue = await promptSecret('一時セットアップ用Resendキー（空欄ならResend確認を省略）');
	if (!setupValue) {
		warn('Resend設定を省略しました。後で2つのキーを分けて設定してください。');
		return { setupCredential: null, webhookConfigured: false, domainOk: false };
	}
	const setupCredential = createOpaqueSecret(setupValue);

	try {
		const domains = await listResendDomains(setupCredential);
		if (domains.length === 0) {
			warn('このキーで確認できるドメインがありません。公開前にResendへドメインを追加してください。');
			return { setupCredential, webhookConfigured: false, domainOk: false };
		}
		log('  このキーで確認できるResendドメイン:');
		for (const item of domains) {
			const receiving = item.capabilities?.receiving === 'enabled' ? '受信ON' : '受信OFF';
			log(`    • ${item.name}  ${c.dim(`${item.status}, ${receiving}`)}`);
		}
		const match = domains.find((item) => item.name?.toLowerCase() === domain);
		if (!match) {
			warn(`${domain}はまだResendにありません。追加後、送信用DNSを設定してください。`);
			return { setupCredential, webhookConfigured: false, domainOk: false };
		}
		if (!match.id) {
			throw new Error('ResendドメインIDを確認できませんでした。推測で続行しません。');
		}
		await confirmExactIdentity('resend', { id: match.id, name: match.name }, 'Resendドメイン');
		ok(`${domain}をResendで確認しました（${match.status}）`);
		if (match.capabilities?.receiving === 'enabled') {
			warn('Resend Receivingを無効にしてください。受信はCloudflare Email Routingを使います。');
		}
		const sendingValue = await promptSecret('対象ドメインに制限したWorker送信用Resendキー');
		if (!sendingValue) throw new Error('Worker送信用Resendキーは空欄にできません。');
		const keyId = await prompt('Resend画面に表示されたWorker送信用キーID');
		const metadata = { id: keyId, access: await prompt('キー権限（sending_access）'), domain: await prompt('キーの制限ドメイン') };
		const officialScreenAttested = await confirm('Resend公式画面でキーID・sending_access・制限ドメインを確認しましたか？', false);
		const metadataIdentity = { id: metadata.id, name: `${metadata.access}:${metadata.domain.toLowerCase()}` };
		log(`  確認コード: ${providerIdentityFingerprint('resend-runtime-key', metadataIdentity)}`);
		const credentialPlan = buildResendCredentialPlan({
			setupCredential,
			sendingCredential: sendingValue,
			domain,
			keyMetadata: metadata,
			officialScreenAttested,
			confirmationFingerprint: await prompt('Resend画面の内容と一致する確認コードを入力')
		});
		putSecret('RESEND_API_KEY', credentialPlan.sendingCredential);
		return {
			setupCredential,
			webhookConfigured: false,
			domainOk: match.status === 'verified'
		};
	} catch (error) {
		throw new Error('Resendの対象ID・ドメイン・権限を確認できなかったため停止します。', { cause: error });
	}
}

function migrate(local, remote) {
	const databaseName = jsoncString(readWrangler(), 'database_name') || 'noroshi';
	if (local) {
		wrangler(['d1', 'migrations', 'apply', databaseName, '--local'], { inherit: true });
		ok('ローカルD1へマイグレーションを適用しました');
	}
	if (remote) {
		wrangler(['d1', 'migrations', 'apply', databaseName, '--remote'], { inherit: true });
		ok('リモートD1へマイグレーションを適用しました');
	}
}

function parseDeployUrl(text) {
	const workers = text.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
	if (workers) return workers[0];
	const https = text.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s]*/i);
	return https ? https[0].replace(/[).,]+$/, '') : null;
}

function deploy() {
	const result = run(bunBin(), ['run', 'deploy'], { inherit: true, allowFail: true });
	return { ok: result.status === 0, text: '' };
}

function deployCaptured() {
	const result = run(bunBin(), ['run', 'deploy'], { allowFail: true });
	const text = `${result.stdout}\n${result.stderr}`;
	if (text.trim()) console.log(text);
	return { ok: result.status === 0, text };
}

async function maybeCreateWebhook(setupCredential, publicUrl) {
	if (!setupCredential || !publicUrl) return false;
	const endpoint = `${publicUrl.replace(/\/$/, '')}/api/webhooks/resend`;
	const existing = await listResendWebhooks(setupCredential);
	const already = existing.find((hook) => hook.endpoint === endpoint);
	if (already) {
		warn(`${endpoint}はResendに登録済みです。既存のRESEND_WEBHOOK_SECRETを維持してください。`);
		return false;
	}
	if (!(await confirm(`${endpoint}をResend Webhookへ登録しますか？`, false))) return false;
	await createWebhookWithSecretBroker({
		create: () => createResendWebhook(setupCredential, endpoint),
		remove: (id) => deleteResendWebhook(setupCredential, id),
		put: (secret) => putSecret('RESEND_WEBHOOK_SECRET', secret)
	});
	log(`  ${c.dim('署名シークレットを保存しました。値は再表示しません。')}`);
	return true;
}

function printNextSteps(state) {
	log(`\n${c.bold('次に行うこと')}`);
	const app = state.publicUrl ? `${state.publicUrl}/setup` : 'デプロイ後のURLの/setup';
	let n = 1;
	log(`  ${n++}. Cloudflare Email RoutingでCatch-all → Send to a Worker → ${state.workerName}を選択します。`);
	log('     apex MXはCloudflareの値だけにします。Resendの受信用MXは追加しません。');
	if (!state.resendDomainOk) {
		log(`  ${n++}. Resendへ${state.domain}を追加し、送信用DNSだけを設定します。Receivingとapex MXは追加しません。`);
	}
	if (!state.webhookConfigured && state.publicUrl) {
		log(`  ${n++}. https://resend.com/webhooks で${state.publicUrl}/api/webhooks/resendを登録します。`);
		log('     イベント: sent, delivered, bounced, complained, delivery_delayed, failed');
		log('     その後: bunx wrangler secret put RESEND_WEBHOOK_SECRET && bun run deploy');
	} else if (!state.publicUrl) {
		log(`  ${n++}. デプロイ後、https://<worker>/api/webhooks/resendをResend Webhookへ登録します。`);
		log('     1回だけ表示される署名シークレットをWorkerシークレットへ保存します。');
	}
	if (state.usedResendSetupCredential) {
		log(`  ${n++}. Resend画面で一時セットアップ用キーを失効させます。Worker送信用キーは残します。`);
	}
	log(`  ${n++}. ${app}を開き、セットアップキーで最初の管理者を作成します。`);
	log('  受信メールはデプロイ済みWorkerだけに届きます。vite devには届きません。');

	log(`\n  ${c.dim('wrangler.jsoncとpackage.jsonには環境固有値が入る場合があります。公開テンプレートへコミットしないでください。')}`);
	if (state.publicUrl) log(`\n  ${c.green(state.publicUrl)}`);
}

async function main() {
	if (args.yes || !args.localDev) {
		assertSafeSetupMode({ yes: args.yes, interactive: Boolean(stdinStream.isTTY) });
	}
	await ensureRuntime();
	if (args.localDev) return runLocalDev();

	log(`\n${c.bold('Noroshi セットアップ')}`);
	log(c.dim('  Cloudflare上に独自ドメインのメール環境を作成します。\n'));

	const total = 9;

	section(1, total, '実行環境');
	installDeps();

	section(2, total, 'Cloudflareログイン');
	const account = await ensureLogin();

	section(3, total, 'ドメインと送信サービス');
	const domain = await askDomain();
	await confirmExactIdentity(
		'cloudflare-zone-target',
		{ id: `${account.id}:${domain}`, name: domain },
		'Cloudflareアカウントと対象ドメイン'
	);
	ok(domain);
	ok('受信: Cloudflare Email Routing');
	ok('Resend（送信）');

	await ensureWrangler();

	let source = readWrangler();
	const workerName = await askWorkerName(jsoncString(source, 'name') || 'noroshi');
	ok('Web UIはworkers.devへデプロイします。カスタムドメイン設定はこの段階では行いません。');

	section(4, total, 'D1とR2');
	const databaseName = await askResourceName(
		'D1データベース名（例: noroshi）',
		jsoncString(source, 'database_name') || 'noroshi',
		args.d1Name,
		isWorkerName,
		'半角小文字、数字、ハイフンを使用してください。'
	);
	const bucketName = await askResourceName(
		'R2バケット名（例: noroshi-attachments）',
		jsoncString(source, 'bucket_name') || 'noroshi-attachments',
		args.r2Name,
		isR2BucketName,
		'3〜63文字の半角小文字、数字、ハイフンを使用してください。'
	);
	ok(`D1 ${databaseName}`);
	ok(`R2 ${bucketName}`);
	const databaseId = await ensureD1(databaseName);
	ensureR2(bucketName);

	section(5, total, '設定ファイル');
	source = readWrangler();
	source = configureSetupTemplate(source, {
		workerName,
		databaseName,
		databaseId,
		bucketName,
		domain
	});
	writeWrangler(source);
	ok('wrangler.jsoncを更新しました');
	setPackageMigrateScripts(databaseName);
	if (databaseName !== 'noroshi') ok(`package.jsonの移行先を${databaseName}へ更新しました`);

	const devVars = {
		EMAIL_PROVIDER: 'resend',
		INBOUND_EMAIL_PROVIDER: 'cloudflare',
		CLOUDFLARE_MAIL_DOMAINS: domain,
		RESEND_SEND_DOMAINS: ''
	};
	if (existsSync(devVarsFile)) {
		const sanitized = removeKnownSecretAssignments(readFileSync(devVarsFile, 'utf8'));
		writeFileSync(devVarsFile, sanitized.endsWith('\n') ? sanitized : `${sanitized}\n`);
	}
	upsertEnvFile(devVarsFile, devVars, { fromExample: true });
	ok('.dev.varsを更新しました');

	section(6, total, 'セットアップキー');
	const bootstrapPlan = await chooseBootstrapSecret();
	putSecret('BOOTSTRAP_SECRET', bootstrapPlan.secret);
	const authRateLimitPlan = buildAuthRateLimitSecretPlan(randomBytes(32));
	putSecret('AUTH_RATE_LIMIT_SECRET', authRateLimitPlan.secret);
	log(`  ${c.dim('セットアップキーを保存しました。値は表示・ファイル保存しません。')}`);

	section(7, total, 'メール経路');
	let resend = { setupCredential: null, webhookConfigured: false, domainOk: false };
	await setupCloudflare(domain);
	resend = await setupResend(domain);
	if (
		persistVerifiedResendSendDomain({
			domainOk: resend.domainOk,
			domain,
			read: readWrangler,
			write: writeWrangler
		})
	) {
		ok('Resend送信を検証済みドメインとして記録しました');
	}

	section(8, total, 'データベース');
	migrate(true, false);

	section(9, total, 'デプロイ');
	let deployed = false;
	let publicUrl = null;
	const shouldDeploy = args.skipDeploy ? false : await confirm('今すぐデプロイしますか？', true);
	if (shouldDeploy) {
		migrate(false, true);
		const result = deployCaptured();
		deployed = result.ok;
		const parsed = parseDeployUrl(result.text);
		if (parsed) publicUrl = parsed;
		if (deployed) ok('デプロイしました');
		else warn('デプロイに失敗しました。表示されたエラーを修正し、`bun run deploy`を実行してください。');

		if (deployed && resend.setupCredential && publicUrl) {
			try {
				const configured = await maybeCreateWebhook(resend.setupCredential, publicUrl);
				if (configured) {
					resend.webhookConfigured = true;
					log(`  ${c.dim('RESEND_WEBHOOK_SECRETを反映するため再デプロイしています…')}`);
					const again = deploy();
					if (!again.ok) warn('再デプロイに失敗しました。シークレットを確認後、`bun run deploy`を実行してください。');
				}
			} catch (error) {
				warn(`Webhook設定に失敗しました: ${error.message}`);
			}
		}
	} else {
		log(`  ${c.dim('デプロイを省略しました。準備後に`bun run db:migrate:remote`と`bun run deploy`を実行してください。')}`);
	}

	printNextSteps({
		domain,
		workerName,
		deployed,
		publicUrl,
		resendDomainOk: resend.domainOk,
		webhookConfigured: resend.webhookConfigured,
		usedResendSetupCredential: Boolean(resend.setupCredential)
	});
}

try {
	await main();
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	await closeReadline();
}
