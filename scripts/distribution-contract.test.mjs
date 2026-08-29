import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkTemplate, findForbiddenFindings } from './check-template-clean.mjs';
import { validateSkillTreeListing } from './package-setup-skill.mjs';

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
	assert.equal(pkg.scripts['package:setup-skill'], 'bun scripts/package-setup-skill.mjs');
	assert.equal(
		pkg.scripts['check:setup-skill-knowledge'],
		'bun scripts/generate-setup-skill-knowledge.mjs --check'
	);
});

test('setup Skill has one canonical source and bounded repo adapters', () => {
	const readme = read('README.md');
	const canonical = read('skills/quickmail-ja-setup/SKILL.md');
	const codex = read('.agents/skills/quickmail-ja-setup/SKILL.md');
	const claude = read('.claude/skills/quickmail-ja-setup/SKILL.md');
	const codexNative = JSON.parse(
		read('.agents/plugins/quickmail-ja-setup/.codex-plugin/plugin.json')
	);
	assert.match(canonical, /^name: quickmail-ja-setup$/m);
	for (const adapter of [codex, claude]) {
		assert.match(adapter, /\.\.\/\.\.\/\.\.\/skills\/quickmail-ja-setup\/SKILL\.md/);
		assert.doesNotMatch(adapter, /## ブラウザ案内|## Provider別の参照/);
	}
	assert.match(readme, /ChatGPTでは、cloneだけではインストールされません/);
	assert.match(readme, /Claude Desktop／Webでも、cloneだけではインストールされません/);
	assert.match(readme, /Codex CLI向けには、公式native形式/);
	assert.match(readme, /Claude Code/);
	assert.doesNotMatch(readme, /実際に発見されるかはQMJ-15で未検証/);
	assert.equal(codexNative.name, 'quickmail-ja-setup');
	assert.equal(codexNative.skills, './skills/');
	assert.equal(codexNative.mcpServers, './.mcp.json');
	assert.doesNotMatch(readme, /Setup Skill（準備中・未提供）/);
});

test('setup Skill package is built from the staged tree without adapters or state', () => {
	const output = join(root, 'out', `quickmail-ja-setup-test-${process.pid}.zip`);
	try {
		const tree = spawnSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' });
		assert.equal(tree.status, 0, tree.stderr);
		const packaged = spawnSync(process.execPath, ['scripts/package-setup-skill.mjs', output], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, SETUP_SKILL_TREEISH: tree.stdout.trim() }
		});
		assert.equal(packaged.status, 0, packaged.stderr);
		const archive = spawnSync('unzip', ['-Z1', output], { encoding: 'utf8' });
		assert.equal(archive.status, 0, archive.stderr);
		assert.deepEqual(archive.stdout.trim().split(/\r?\n/), [
			'quickmail-ja-setup/',
			'quickmail-ja-setup/SKILL.md',
			'quickmail-ja-setup/agents/',
			'quickmail-ja-setup/agents/openai.yaml',
			'quickmail-ja-setup/references/',
			'quickmail-ja-setup/references/browser-and-byok.md',
			'quickmail-ja-setup/references/cloudflare-resend.md',
			'quickmail-ja-setup/references/gmail-byok.md',
			'quickmail-ja-setup/references/setup-patterns.json'
		]);
	} finally {
		rmSync(output, { force: true });
	}
});

test('setup Skill package rejects an output outside repository out without deleting it', () => {
	const temporary = mkdtempSync(join(tmpdir(), 'quickmail-ja-skill-output-'));
	const outside = join(temporary, 'preserve.zip');
	writeFileSync(outside, 'must remain');
	try {
		const packaged = spawnSync(process.execPath, ['scripts/package-setup-skill.mjs', outside], {
			cwd: root,
			encoding: 'utf8'
		});
		assert.notEqual(packaged.status, 0);
		assert.match(packaged.stderr, /direct \.zip file under the repository out directory/);
		assert.equal(readFileSync(outside, 'utf8'), 'must remain');
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test('setup Skill package rejects an output symlink without deleting its target', () => {
	const temporary = mkdtempSync(join(tmpdir(), 'quickmail-ja-skill-symlink-'));
	const target = join(temporary, 'target.zip');
	const output = join(root, 'out', `quickmail-ja-setup-link-${process.pid}.zip`);
	writeFileSync(target, 'must remain');
	mkdirSync(join(root, 'out'), { recursive: true });
	symlinkSync(target, output);
	try {
		const packaged = spawnSync(process.execPath, ['scripts/package-setup-skill.mjs', output], {
			cwd: root,
			encoding: 'utf8'
		});
		assert.notEqual(packaged.status, 0);
		assert.match(packaged.stderr, /output must be a regular file/);
		assert.equal(readFileSync(target, 'utf8'), 'must remain');
	} finally {
		rmSync(output, { force: true });
		rmSync(temporary, { recursive: true, force: true });
	}
});

test('setup Skill package rejects a symlink fixture before archiving', () => {
	const object = '0'.repeat(40);
	const regular = (path) => `100644 blob ${object}\t${path}\0`;
	const listing = [
		regular('SKILL.md'),
		regular('agents/openai.yaml'),
		regular('references/browser-and-byok.md'),
		regular('references/cloudflare-resend.md'),
		regular('references/gmail-byok.md'),
		regular('references/setup-patterns.json'),
		`120000 blob ${object}\treferences/escape\0`
	].join('');
	assert.throws(() => validateSkillTreeListing(listing), /non-file entry: references\/escape/);
});

test('packaged setup knowledge is a current bounded projection of the reviewed Pack', () => {
	const checked = spawnSync(
		process.execPath,
		['scripts/generate-setup-skill-knowledge.mjs', '--check'],
		{
			cwd: root,
			encoding: 'utf8'
		}
	);
	assert.equal(checked.status, 0, checked.stderr);
	const packaged = JSON.parse(read('skills/quickmail-ja-setup/references/setup-patterns.json'));
	assert.equal(packaged.generated_from, 'support/knowledge/patterns.json');
	assert.ok(packaged.patterns.length > 0);
	assert.ok(
		packaged.patterns.every((pattern) => !['backup', 'migration'].includes(pattern.category))
	);
});

test('ignore rules admit only the two setup adapters, never Claude state', () => {
	const ignoredState = spawnSync('git', ['check-ignore', '-q', '.claude/state/session.json'], {
		cwd: root
	});
	const codexAdapter = spawnSync(
		'git',
		['check-ignore', '-q', '.agents/skills/quickmail-ja-setup/SKILL.md'],
		{ cwd: root }
	);
	const claudeAdapter = spawnSync(
		'git',
		['check-ignore', '-q', '.claude/skills/quickmail-ja-setup/SKILL.md'],
		{ cwd: root }
	);
	assert.equal(ignoredState.status, 0);
	assert.equal(codexAdapter.status, 1);
	assert.equal(claudeAdapter.status, 1);
});

test('setup copy requires Cloudflare DNS for inbound and stays Japanese-first', () => {
	const setup = read('scripts/setup.mjs');
	assert.match(setup, /QMJ-10[\s\S]*provider-neutral setup-engine contract/);
	assert.match(setup, /not bundled in[\s\S]*Agent Plugin/);
	assert.match(setup, /never invoked by the setup MCP/);
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

test('clean-template accepts only the tracked Codex native distribution paths', () => {
	const result = checkTemplate(root);
	assert.deepEqual(result.failures, []);
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

test('setup never downloads or executes a Bun installer', () => {
	const setup = read('scripts/setup.sh');
	assert.doesNotMatch(setup, /curl[^\n|]*\|\s*(?:ba)?sh/u);
	assert.match(setup, /Bun 1\.3\.14を検証済み/u);
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
		assert.match(result.stdout, /公式手順でBun 1\.3\.14を導入してください/u);
	} finally {
		rmSync(temporaryHome, { recursive: true, force: true });
	}
});

test('QMJ-9 distribution keeps setup secrets out of files and stays on workers.dev', () => {
	const readme = read('README.md');
	const devVars = read('.dev.vars.example');
	const wrangler = read('wrangler.jsonc');
	const pkg = JSON.parse(read('package.json'));
	assert.match(readme, /1\.3\.14（検証済みの固定バージョン）/u);
	assert.match(readme, /bun install --frozen-lockfile/u);
	assert.match(readme, /AUTH_RATE_LIMIT_SECRET/u);
	assert.match(readme, /workers\.dev/u);
	assert.match(readme, /ログ保持/u);
	assert.match(readme, /料金アラート|コストアラート/u);
	assert.doesNotMatch(readme, /bun run setup -- --yes/u);
	assert.doesNotMatch(
		devVars,
		/^(?:BOOTSTRAP_SECRET|AUTH_RATE_LIMIT_SECRET|RESEND_API_KEY|RESEND_WEBHOOK_SECRET)=/mu
	);
	assert.doesNotMatch(devVars, /VAPID_PRIVATE_KEY\s*=/u);
	assert.match(wrangler, /AUTH_RATE_LIMIT_SECRET/u);
	assert.doesNotMatch(wrangler, /"routes"|custom_domain/u);
	assert.match(
		pkg.cloudflare.bindings.RESEND_API_KEY.description,
		/domain-restricted sending key/iu
	);
	assert.match(
		pkg.cloudflare.bindings.RESEND_API_KEY.description,
		/never deploy a full-access setup key/iu
	);
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
