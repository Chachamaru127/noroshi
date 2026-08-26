#!/usr/bin/env bun
/**
 * Interactive first-run setup for QuickMail-ja.
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
	buildBootstrapSecretPlan,
	configureSetupTemplate,
	generateBootstrapSecret
} from './setup-config.mjs';

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
	console.log(`QuickMail-ja セットアップ

Cloudflareへログインし、D1/R2、設定ファイル、受信・送信経路を準備します。
受信にはCloudflareで管理するDNSゾーンが必要です。標準の送信はResendです。

  bun run setup
  bash scripts/setup.sh

オプション:
  --domain <name>      メールドメイン（例: example.com）
  --d1-name <name>     D1名（例: quickmail-ja）
  --r2-name <name>     R2名（例: quickmail-ja-attachments）
  --yes                既定値を使用（--domainは必須）
  --skip-deploy        最後のデプロイを行わない
  --help               このヘルプを表示
`);
}

function parseArgs(argv) {
	const out = {
		help: false,
		yes: false,
		skipDeploy: false,
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

function childEnv(extra = {}) {
	const bins = [join(root, 'node_modules', '.bin')];
	return {
		...process.env,
		PATH: `${bins.join(delimiter)}${delimiter}${process.env.PATH ?? ''}`,
		...extra
	};
}

function run(command, commandArgs, { inherit = false, input, env, allowFail = false, stdio } = {}) {
	const result = spawnSync(command, commandArgs, {
		cwd: root,
		encoding: 'utf8',
		env: childEnv(env),
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
	if (existsSync(local)) {
		return run(local, wranglerArgs, options);
	}
	return run(bunBin(), ['x', 'wrangler', ...wranglerArgs], options);
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
	if (args.yes) return fallback;
	if (!stdinStream.isTTY) {
		if (fallback) return fallback;
		throw new Error(`対話できない環境では値の指定が必要です: ${question}`);
	}
	const suffix = fallback ? ` ${c.dim(`(${fallback})`)}` : '';
	const input = await (await ensureReadline()).question(`  ${question}${suffix}: `);
	return input.trim() || fallback;
}

async function confirm(question, defaultYes = true) {
	if (args.yes) return defaultYes;
	if (!stdinStream.isTTY) return defaultYes;
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
	let value = '';
	if (stdinStream.isTTY && !args.yes) {
		value = await promptSecret('セットアップキー（空欄なら安全な値を自動生成）');
	}
	if (!value) value = generateBootstrapSecret(randomBytes(32));
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
		throw new Error('wrangler.jsoncがありません。QuickMail-jaのルートから実行してください。');
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
	ok(`Bun ${version}`);
}

function installDeps() {
	run(bunBin(), ['install'], { inherit: true });
	ok('依存パッケージをBunで準備しました');
}

function wranglerVersion() {
	const result = wrangler(['--version'], { allowFail: true });
	return parseVersion(`${result.stdout}\n${result.stderr}`);
}

function upgradeWrangler() {
	run(bunBin(), ['add', '-d', 'wrangler@latest'], { inherit: true });
}

async function ensureWrangler() {
	if (!existsSync(join(root, 'node_modules', 'wrangler')) && !which('wrangler')) {
		installDeps();
	}

	let version = wranglerVersion();
	ok(`wrangler ${formatVersion(version)}`);

	if (versionGte(version, MIN_WRANGLER)) return version;

	warn(`Wrangler ${formatVersion(version)}は古いため、${formatVersion(MIN_WRANGLER)}以上が必要です。`);
	if (!(await confirm('Wranglerを最新版へ更新しますか？', true))) {
		throw new Error('`bun add -d wrangler@latest`で更新してから再実行してください。');
	}
	upgradeWrangler();
	version = wranglerVersion();
	ok(`wrangler ${formatVersion(version)}`);
	return version;
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

async function pickAccount(accounts) {
	if (accounts.length === 0) return null;
	if (accounts.length === 1) {
		ok(`アカウント: ${accounts[0].name}`);
		upsertEnvFile(envFile, { CLOUDFLARE_ACCOUNT_ID: accounts[0].id });
		return accounts[0];
	}

	log('  複数のCloudflareアカウントが見つかりました:');
	accounts.forEach((account, index) => {
		log(`    ${index + 1}) ${account.name}  ${c.dim(account.id)}`);
	});

	if (args.yes) {
		upsertEnvFile(envFile, { CLOUDFLARE_ACCOUNT_ID: accounts[0].id });
		ok(`${accounts[0].name}を使用します`);
		return accounts[0];
	}

	let chosen = null;
	while (!chosen) {
		const raw = await prompt('使用するアカウント番号', '1');
		const index = Number(raw) - 1;
		chosen = accounts[index];
		if (!chosen) warn('一覧の番号を入力してください。');
	}
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
	const fallback = current && isWorkerName(current) ? current : 'quickmail-ja';
	while (true) {
		const name = (await prompt('Worker名', fallback)).toLowerCase();
		if (isWorkerName(name)) return name;
		warn('半角小文字、数字、ハイフンを使用してください。');
	}
}

async function askHostname(domain) {
	const raw = await prompt('Web UIのホスト名（空欄ならworkers.dev）', '');
	if (!raw) return null;
	const host = normalizeDomain(raw.includes('.') ? raw : `${raw}.${domain}`);
	if (!isDomain(host)) {
		warn(`ホスト名"${raw}"の形式が正しくないため、workers.devへデプロイします。`);
		return null;
	}
	return host;
}

async function askResourceName(question, fallback, flagValue, validate, invalidHint) {
	if (flagValue) {
		const name = flagValue.trim().toLowerCase();
		if (!validate(name)) throw new Error(`${question}の形式が正しくありません: "${flagValue}"。${invalidHint}`);
		return name;
	}
	if (args.yes) return fallback;
	while (true) {
		const raw = await prompt(question);
		const name = (raw || fallback).toLowerCase();
		if (validate(name)) return name;
		warn(invalidHint);
	}
}

function listD1() {
	const result = wrangler(['d1', 'list', '--json'], { allowFail: true });
	const parsed = parseJsonOutput(`${result.stdout}\n${result.stderr}`);
	const rows = Array.isArray(parsed) ? parsed : parsed?.databases ?? parsed?.result ?? [];
	const fromJson = rows
		.map((row) => ({
			name: row.name ?? row.database_name,
			id: row.uuid ?? row.id ?? row.database_id
		}))
		.filter((row) => row.name && row.id);
	if (fromJson.length > 0) return fromJson;

	const table = wrangler(['d1', 'list'], { allowFail: true });
	const text = `${table.stdout}\n${table.stderr}`;
	const found = [];
	for (const line of text.split('\n')) {
		const id = line.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1];
		if (!id) continue;
		const name = line.match(/\b(quickmail|[a-z0-9][a-z0-9-]{1,62})\b/i)?.[1];
		if (name) found.push({ name, id });
	}
	return found;
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
		const existing = listD1().find((row) => row.name === name);
		if (existing) return existing.id;
	}
	throw new Error(text.trim() || `D1データベース"${name}"を作成できませんでした。`);
}

async function ensureD1(databaseName) {
	const existing = listD1().find((row) => row.name === databaseName);
	if (existing) {
		ok(`既存のD1 ${databaseName} (${existing.id}) を使用します`);
		return existing.id;
	}

	log(`  ${c.dim(`D1データベース ${databaseName} を作成しています…`)}`);
	const id = createD1(databaseName);
	ok(`D1 ${databaseName} (${id})`);
	return id;
}

function listR2Names() {
	const result = wrangler(['r2', 'bucket', 'list', '--json'], { allowFail: true });
	const parsed = parseJsonOutput(`${result.stdout}\n${result.stderr}`);
	const rows = Array.isArray(parsed) ? parsed : parsed?.buckets ?? parsed?.result ?? [];
	const fromJson = rows
		.map((row) => (typeof row === 'string' ? row : row.name ?? row.Name))
		.filter(Boolean);
	if (fromJson.length > 0) return fromJson;

	const table = wrangler(['r2', 'bucket', 'list'], { allowFail: true });
	const text = `${table.stdout}\n${table.stderr}`;
	const names = [];
	for (const line of text.split('\n')) {
		const match = line.match(/\b([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\b/i);
		if (match && !/^(name|creation|location|id)$/i.test(match[1])) names.push(match[1]);
	}
	return names;
}

function ensureR2(bucketName) {
	if (listR2Names().includes(bucketName)) {
		ok(`既存のR2バケット ${bucketName} を使用します`);
		return;
	}

	log(`  ${c.dim(`R2バケット ${bucketName} を作成しています…`)}`);
	const result = wrangler(['r2', 'bucket', 'create', bucketName], {
		allowFail: true,
		env: { CI: 'true' }
	});
	const text = `${result.stdout}\n${result.stderr}`;
	if (result.status === 0 || /already exists/i.test(text)) {
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

function putSecret(name, value) {
	wrangler(['secret', 'put', name], {
		input: value,
		stdio: ['pipe', 'inherit', 'inherit']
	});
	ok(`${name}をWorkerシークレットとして保存しました`);
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
	log(`  ${c.dim('Email Routingを有効化しています…')}`);
	const routing = tryWrangler(['email', 'routing', 'enable', domain]);
	if (routing.ok) ok(`${domain}でEmail Routingを有効化しました`);
	else {
		warn('CLIからEmail Routingを有効化できませんでした。');
		log(`  ${routing.text.split('\n').slice(0, 8).join('\n  ')}`);
		log(
			`  ${c.dim('Dashboard: https://dash.cloudflare.com/?to=/:account/email-service/routing')}`
		);
	}

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

async function listResendDomains(apiKey) {
	const response = await fetch('https://api.resend.com/domains?limit=100', {
		headers: { Authorization: `Bearer ${apiKey}` }
	});
	const raw = await response.text();
	const parsed = raw ? parseJsonOutput(raw) : null;
	if (!response.ok) {
		const message = parsed?.message ?? parsed?.error ?? `Resend API ${response.status}`;
		throw new Error(message);
	}
	return parsed?.data ?? [];
}

async function listResendWebhooks(apiKey) {
	const response = await fetch('https://api.resend.com/webhooks', {
		headers: { Authorization: `Bearer ${apiKey}` }
	});
	const raw = await response.text();
	const parsed = raw ? parseJsonOutput(raw) : null;
	if (!response.ok) return [];
	return parsed?.data ?? [];
}

async function createResendWebhook(apiKey, endpoint) {
	const response = await fetch('https://api.resend.com/webhooks', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
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

async function setupResend(domain) {
	log('  https://resend.com/api-keys で送信・ドメイン確認用のAPIキーを作成してください。');
	log('  Resendでは送信用DNSだけを追加します。Receivingやapex MXは追加しません。');

	let apiKey = '';
	if (stdinStream.isTTY && !args.yes) {
		apiKey = await promptSecret('Resend APIキー（re_で始まる値。空欄なら後で設定）');
	} else {
		warn('APIキー入力を省略しました。後で`wrangler secret put RESEND_API_KEY`を実行してください。');
	}

	if (!apiKey) {
		return { apiKey: '', webhookSecret: '', domainOk: false };
	}

	if (!apiKey.startsWith('re_')) {
		warn('Resend APIキーは通常re_で始まります。入力値はそのまま保存します。');
	}

	putSecret('RESEND_API_KEY', apiKey);

	try {
		const domains = await listResendDomains(apiKey);
		if (domains.length === 0) {
			warn('このキーで確認できるドメインがありません。公開前にResendへドメインを追加してください。');
			return { apiKey, webhookSecret: '', domainOk: false };
		}
		log('  このキーで確認できるResendドメイン:');
		for (const item of domains) {
			const receiving = item.capabilities?.receiving === 'enabled' ? '受信ON' : '受信OFF';
			log(`    • ${item.name}  ${c.dim(`${item.status}, ${receiving}`)}`);
		}
		const match = domains.find((item) => item.name?.toLowerCase() === domain);
		if (!match) {
			warn(`${domain}はまだResendにありません。追加後、送信用DNSを設定してください。`);
			return { apiKey, webhookSecret: '', domainOk: false };
		}
		ok(`${domain}をResendで確認しました（${match.status}）`);
		if (match.capabilities?.receiving === 'enabled') {
			warn('Resend Receivingを無効にしてください。受信はCloudflare Email Routingを使います。');
		}
		return { apiKey, webhookSecret: '', domainOk: match.status === 'verified' };
	} catch (error) {
		warn(`Resendのドメイン一覧を取得できませんでした: ${error.message}`);
		return { apiKey, webhookSecret: '', domainOk: false };
	}
}

function migrate(local, remote) {
	const databaseName = jsoncString(readWrangler(), 'database_name') || 'quickmail-ja';
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

async function maybeCreateWebhook(apiKey, publicUrl) {
	if (!apiKey || !publicUrl) return '';
	const endpoint = `${publicUrl.replace(/\/$/, '')}/api/webhooks/resend`;
	const existing = await listResendWebhooks(apiKey);
	const already = existing.find((hook) => hook.endpoint === endpoint);
	if (already) {
		warn(`${endpoint}はResendに登録済みです。既存のRESEND_WEBHOOK_SECRETを維持してください。`);
		return '';
	}
	if (!(await confirm(`${endpoint}をResend Webhookへ登録しますか？`, true))) return '';
	const created = await createResendWebhook(apiKey, endpoint);
	const secret = created?.signing_secret ?? created?.svix_secret ?? '';
	if (!secret) {
		warn('Webhookを作成しましたが署名シークレットを取得できませんでした。Resend画面から保存してください。');
		return '';
	}
	putSecret('RESEND_WEBHOOK_SECRET', secret);
	log(`  ${c.dim('署名シークレットを保存しました。値は再表示しません。')}`);
	return secret;
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
	if (!state.webhookSecret && state.publicUrl) {
		log(`  ${n++}. https://resend.com/webhooks で${state.publicUrl}/api/webhooks/resendを登録します。`);
		log('     イベント: sent, delivered, bounced, complained, delivery_delayed, failed');
		log('     その後: bunx wrangler secret put RESEND_WEBHOOK_SECRET && bun run deploy');
	} else if (!state.publicUrl) {
		log(`  ${n++}. デプロイ後、https://<worker>/api/webhooks/resendをResend Webhookへ登録します。`);
		log('     1回だけ表示される署名シークレットをWorkerシークレットへ保存します。');
	}
	log(`  ${n++}. ${app}を開き、セットアップキーで最初の管理者を作成します。`);
	log('  受信メールはデプロイ済みWorkerだけに届きます。vite devには届きません。');

	log(`\n  ${c.dim('wrangler.jsoncとpackage.jsonには環境固有値が入る場合があります。公開テンプレートへコミットしないでください。')}`);
	if (state.publicUrl) log(`\n  ${c.green(state.publicUrl)}`);
}

async function main() {
	if (!stdinStream.isTTY && !args.yes) {
		throw new Error('対話できない環境では--yesと--domainが必要です。--helpを確認してください。');
	}
	if (args.yes && !args.domain) {
		throw new Error('--yesを使う場合は--domainが必要です。');
	}

	log(`\n${c.bold('QuickMail-ja セットアップ')}`);
	log(c.dim('  Cloudflare上に独自ドメインのメール環境を作成します。\n'));

	const total = 9;

	section(1, total, '実行環境');
	await ensureRuntime();
	installDeps();

	section(2, total, 'Cloudflareログイン');
	await ensureLogin();

	section(3, total, 'ドメインと送信サービス');
	const domain = await askDomain();
	ok(domain);
	ok('受信: Cloudflare Email Routing');
	ok('Resend（送信）');

	await ensureWrangler();

	let source = readWrangler();
	const workerName = await askWorkerName(jsoncString(source, 'name') || 'quickmail-ja');
	const hostname = await askHostname(domain);
	if (hostname) ok(`Web UIホスト名: ${hostname}`);

	section(4, total, 'D1とR2');
	const databaseName = await askResourceName(
		'D1データベース名（例: quickmail-ja）',
		jsoncString(source, 'database_name') || 'quickmail-ja',
		args.d1Name,
		isWorkerName,
		'半角小文字、数字、ハイフンを使用してください。'
	);
	const bucketName = await askResourceName(
		'R2バケット名（例: quickmail-ja-attachments）',
		jsoncString(source, 'bucket_name') || 'quickmail-ja-attachments',
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
		domain,
		hostname
	});
	writeWrangler(source);
	ok('wrangler.jsoncを更新しました');
	setPackageMigrateScripts(databaseName);
	if (databaseName !== 'quickmail-ja') ok(`package.jsonの移行先を${databaseName}へ更新しました`);

	const devVars = {
		EMAIL_PROVIDER: 'resend',
		INBOUND_EMAIL_PROVIDER: 'cloudflare',
		CLOUDFLARE_MAIL_DOMAINS: domain
	};
	upsertEnvFile(devVarsFile, devVars, { fromExample: true });
	ok('.dev.varsを更新しました');

	section(6, total, 'セットアップキー');
	const bootstrapPlan = await chooseBootstrapSecret();
	upsertEnvFile(devVarsFile, bootstrapPlan.localUpdates, { fromExample: true });
	putSecret('BOOTSTRAP_SECRET', bootstrapPlan.input);
	log(`  ${c.bold('最初の管理者作成に使うセットアップキー（この画面での表示は1回だけです）')}`);
	log(`  ${c.bold(bootstrapPlan.displayOnce)}`);
	log(`  ${c.dim('安全な場所へ保存し、管理者作成後は破棄してください。')}`);

	section(7, total, 'メール経路');
	let resend = { apiKey: '', webhookSecret: '', domainOk: false };
	await setupCloudflare(domain);
	resend = await setupResend(domain);
	if (resend.apiKey) {
		upsertEnvFile(devVarsFile, { RESEND_API_KEY: resend.apiKey });
		ok('RESEND_API_KEYを.dev.varsへ保存しました');
	}

	section(8, total, 'データベース');
	migrate(true, false);

	section(9, total, 'デプロイ');
	let deployed = false;
	let publicUrl = hostname ? `https://${hostname}` : null;
	const shouldDeploy = args.skipDeploy ? false : await confirm('今すぐデプロイしますか？', true);
	if (shouldDeploy) {
		migrate(false, true);
		const result = deployCaptured();
		deployed = result.ok;
		const parsed = parseDeployUrl(result.text);
		if (parsed) publicUrl = parsed;
		if (deployed) ok('デプロイしました');
		else warn('デプロイに失敗しました。表示されたエラーを修正し、`bun run deploy`を実行してください。');

		if (deployed && resend.apiKey && publicUrl) {
			try {
				const secret = await maybeCreateWebhook(resend.apiKey, publicUrl);
				if (secret) {
					resend.webhookSecret = secret;
					upsertEnvFile(devVarsFile, { RESEND_WEBHOOK_SECRET: secret });
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
		webhookSecret: resend.webhookSecret
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
