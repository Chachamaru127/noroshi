import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { findForbiddenFindings } from './check-template-clean.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const root = fileURLToPath(new URL('..', import.meta.url));

test('README is Japanese-first and documents the supported operating boundary', () => {
	const readme = read('README.md');
	for (const heading of [
		'## 構成',
		'## セットアップ',
		'## DNS と MX',
		'## コスト',
		'## 制限事項',
		'## バックアップとエクスポート',
		'## 復旧とロールバック',
		'## 更新'
	]) {
		assert.ok(readme.includes(heading), `README is missing ${heading}`);
	}
	assert.match(readme, /受信[^\n]*Cloudflare Email Routing/);
	assert.match(readme, /送信[^\n]*Resend/);
	assert.match(readme, /公開リポジトリのURL[^\n]*未設定/);
	assert.match(readme, /quickmail-ja-attachments/);
	assert.doesNotMatch(readme, /npm install|node scripts\/setup/);
});

test('release artifact and title use the QuickMail-ja product name', () => {
	const release = read('.github/workflows/release.yml');
	assert.match(release, /quickmail-ja-\$\{\{ steps\.version\.outputs\.version \}\}\.zip/);
	assert.match(release, /--prefix="quickmail-ja-/);
	assert.match(release, /--title "QuickMail-ja /);
	assert.doesNotMatch(release, /--title "QuickMail /);
	assert.match(release, /INPUT_TAG: \$\{\{ github\.event\.inputs\.tag \}\}/);
	assert.match(release, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+/);
	assert.doesNotMatch(release, /TAG="\$\{\{ github\.event\.inputs\.tag/);
});

test('package commands stay Bun-only and target the generic D1 name', () => {
	const pkg = JSON.parse(read('package.json'));
	assert.equal(pkg.scripts.setup, 'bun scripts/setup.mjs');
	assert.equal(
		pkg.scripts['db:migrate:local'],
		'wrangler d1 migrations apply quickmail-ja --local'
	);
	assert.equal(
		pkg.scripts['db:migrate:remote'],
		'wrangler d1 migrations apply quickmail-ja --remote'
	);
});

test('setup copy requires Cloudflare DNS for inbound and stays Japanese-first', () => {
	const setup = read('scripts/setup.mjs');
	assert.match(setup, /受信にはCloudflareで管理するDNSゾーンが必要です/);
	assert.match(setup, /Resend（送信）/);
	assert.match(setup, /セットアップキー/);
	assert.doesNotMatch(setup, /any DNS host|Node\.js 20\+|dependencies installed \(npm\)/);
});

test('clean-template diagnostics never include the matched secret value', () => {
	const clean = read('scripts/check-template-clean.mjs');
	assert.doesNotMatch(clean, /matched|JSON\.stringify\(match|slice\(0, 40\)/);
	assert.doesNotMatch(clean, /\$\{route\[1\]\}/);
	assert.match(clean, /\$\{finding\.label\} in \$\{file\}:\$\{finding\.line\}/);
});

test('clean scanner checks every match and scans the text Bun lockfile', () => {
	const fakeKey = ['re', 'A'.repeat(24)].join('_');
	const contents = `RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx\nRESEND_API_KEY=${fakeKey}`;
	const findings = findForbiddenFindings(contents);
	assert.deepEqual(findings, [{ label: 'Resend API key', line: 2 }]);
	assert.doesNotMatch(JSON.stringify(findings), new RegExp(fakeKey));
	const clean = read('scripts/check-template-clean.mjs');
	assert.doesNotMatch(clean, /pdf\|zip\|lock/);
});

test('non-interactive setup never approves a Bun download', () => {
	const setup = read('scripts/setup.sh');
	assert.match(setup, /if \[\[ ! -t 0 \]\]; then\s+return 1/);
	assert.doesNotMatch(setup, /if \[\[ ! -t 0 \]\]; then\s+return 0/);
	const temporaryHome = mkdtempSync(join(tmpdir(), 'quickmail-ja-no-bun-'));
	try {
		const result = spawnSync('/bin/bash', ['scripts/setup.sh'], {
			cwd: root,
			input: '',
			encoding: 'utf8',
			env: {
				...process.env,
				BUN_INSTALL: join(temporaryHome, 'bun-install'),
				PATH: '/usr/bin:/bin'
			}
		});
		assert.equal(result.status, 1);
		assert.match(result.stdout, /Bunを導入してから再実行してください/);
	} finally {
		rmSync(temporaryHome, { recursive: true, force: true });
	}
});

test('release archive keeps and runs the clean-template guard', () => {
	const attributes = read('.gitattributes');
	const pkg = JSON.parse(read('package.json'));
	assert.doesNotMatch(attributes, /scripts\/check-template-clean\.mjs\s+export-ignore/);
	assert.equal(pkg.scripts['test:archive'], 'bun scripts/archive-smoke.mjs');
});

test('fresh setup supports Cloudflare inbound and Resend outbound only', () => {
	const setup = read('scripts/setup.mjs');
	const readme = read('README.md');
	const wrangler = read('wrangler.jsonc');
	assert.doesNotMatch(setup, /--provider|askProvider|Cloudflare Email（送信）/);
	assert.match(setup, /Resend（送信）/);
	assert.match(readme, /初回リリースの送信はResendのみ/);
	assert.match(readme, /CLOUDFLARE_MAIL_DOMAINS/);
	assert.match(readme, /Catch-all[^\n]*Send to a Worker/);
	assert.doesNotMatch(readme, /Cloudflare Email Sending|Cloudflare Email（送信）/);
	assert.doesNotMatch(wrangler, /README Track B|resend \| cloudflare/);
});

test('forwarding contract allows one initial call and at most three retries', () => {
	const spec = read('spec.md');
	const contract = read('docs/spec/forwarding-contract.md');
	assert.match(spec, /at most three retries \(four provider calls total\)/);
	assert.match(contract, /再試行は最大3回/);
	assert.match(contract, /合計最大4回/);
});
