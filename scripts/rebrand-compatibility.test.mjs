import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ENVELOPE_STROKE_HALF_WIDTH,
	SMOKE_CURVES,
	SMOKE_STROKE_HALF_WIDTH,
	cubicPoint,
	distanceToEnvelopeCenterline
} from './pwa-icon-geometry.mjs';

const root = join(import.meta.dir, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const cleanCliEnv = (overrides) => {
	const env = { ...process.env };
	for (const key of ['NOROSHI_CONFIG', 'NOROSHI_URL', 'NOROSHI_TOKEN']) {
		delete env[key];
	}
	return { ...env, ...overrides };
};

describe('Noroshi public identity', () => {
	test('uses Noroshi in the public UI, PWA metadata, documentation, and package identity', () => {
		for (const path of [
			'src/app.html',
			'src/lib/components/Logo.svelte',
			'src/lib/components/Sidebar.svelte',
			'src/routes/login/+page.svelte',
			'src/routes/inbox/+page.svelte',
			'static/manifest.webmanifest',
			'README.md'
		]) {
			expect(read(path), path).toContain('Noroshi');
		}
		const manifest = JSON.parse(read('static/manifest.webmanifest'));
		expect(manifest.name).toBe('Noroshi');
		expect(manifest.short_name).toBe('Noroshi');
		const pkg = JSON.parse(read('package.json'));
		expect(pkg.name).toBe('noroshi');
		expect(pkg.repository).toBe('https://github.com/Chachamaru127/noroshi.git');
		expect(pkg.homepage).toBe('https://noroshi-ui-preview.pages.dev/');
		expect(JSON.parse(read('cli/package.json')).name).toBe('noroshi-cli');
		expect(read('bun.lock')).toMatch(/""\s*:\s*\{\s*"name"\s*:\s*"noroshi"/u);
	});

	test('exposes noroshi as the only CLI entrypoint and configuration source', () => {
		const pkg = JSON.parse(read('package.json'));
		expect(pkg.bin).toEqual({ noroshi: './bin/noroshi.mjs' });
		expect(pkg.scripts.noroshi).toBe('bun cli/main.ts');
		expect(pkg.scripts.quickmail).toBeUndefined();
		expect(existsSync(join(root, 'bin/quickmail.mjs'))).toBe(false);
		const cli = read('cli/main.ts');
		expect(cli).toContain('noroshi \u2014 operate a Noroshi instance');
		expect(cli).toContain('noroshi login');
		const config = read('cli/config.ts');
		expect(config).toContain('NOROSHI_CONFIG');
		expect(config).toContain("join(base, 'noroshi', 'config.json')");
		expect(config).not.toContain('legacyConfigPath');
		const help = execFileSync('bun', ['bin/noroshi.mjs', '--help'], {
			cwd: root,
			encoding: 'utf8'
		});
		expect(help).toContain('noroshi \u2014 operate a Noroshi instance');
		expect(statSync(join(root, 'bin/noroshi.mjs')).mode & 0o111).not.toBe(0);
		const directHelp = execFileSync(join(root, 'bin/noroshi.mjs'), ['--help'], {
			cwd: root,
			encoding: 'utf8'
		});
		expect(directHelp).toContain('noroshi \u2014 operate a Noroshi instance');
		const unknown = Bun.spawnSync([join(root, 'bin/noroshi.mjs'), 'not-a-command'], {
			cwd: root,
			env: cleanCliEnv({})
		});
		expect(unknown.exitCode).toBe(1);
		expect(new TextDecoder().decode(unknown.stderr)).toContain('Run noroshi --help.');
		expect(read('src/routes/settings/+page.svelte')).toContain('bun run noroshi');
	});

	test('rejects a malformed configuration instead of falling back', () => {
		const configRoot = mkdtempSync(join(tmpdir(), 'noroshi-config-'));
		mkdirSync(join(configRoot, 'noroshi'), { recursive: true });
		writeFileSync(join(configRoot, 'noroshi', 'config.json'), '{ malformed');
		const result = Bun.spawnSync(
			[
				'bun',
				'-e',
				`import { loadConfig } from ${JSON.stringify(join(root, 'cli/config.ts'))}; try { const config = await loadConfig(); console.log('LOADED:' + config.token); } catch { console.log('REJECTED'); }`
			],
			{
				cwd: root,
				env: cleanCliEnv({ XDG_CONFIG_HOME: configRoot })
			}
		);
		expect(result.exitCode).toBe(0);
		expect(new TextDecoder().decode(result.stdout).trim()).toBe('REJECTED');
	});

	test('uses noroshi identifiers everywhere and keeps only upstream attribution', () => {
		expect(JSON.parse(read('plugin.json')).name).toBe('noroshi-setup');
		expect(read('mcp.json')).toContain('noroshi-setup-engine');
		expect(read('scripts/setup-engine.mjs')).toContain("'noroshi.setup-engine.v1'");
		expect(read('src/lib/server/forwarding-delivery.ts')).toContain('X-Noroshi-Forwarded');
		expect(read('src/lib/server/forwarding-delivery.ts')).toContain('noroshi-forward:');
		expect(read('scripts/outlook-import-core.mjs')).toContain("'.noroshi-outlook-import-staging'");
		expect(read('src/lib/server/api-tokens.ts')).toContain('nr_live_');
		expect(read('wrangler.jsonc')).toMatch(/^\s*"name"\s*:\s*"noroshi"/m);
		expect(read('wrangler.jsonc')).toContain('"bucket_name": "noroshi-attachments"');
		expect(read('cli/mcp.ts')).toContain("new McpServer({ name: 'noroshi'");
		expect(read('README.md')).toContain('DivinPrince/quickmail');
	});

	test('uses Noroshi prose in the plugin, Skills, and agent manifest', () => {
		const plugin = JSON.parse(read('plugin.json'));
		expect(plugin.description).toContain('Noroshi');
		expect(plugin.author.name).toBe('Noroshi');
		expect(read('skills/noroshi-setup/SKILL.md')).toContain('Noroshi');
		expect(read('skills/noroshi-operations/SKILL.md')).toContain('Noroshi');
		expect(read('skills/noroshi-setup/agents/openai.yaml')).toContain(
			'display_name: "Noroshi セットアップ"'
		);
	});

	test('keeps the mail affordance and adds only one restrained smoke-signal element', () => {
		const logo = read('src/lib/components/Logo.svelte');
		expect(logo).toContain('aria-label="Noroshi メール"');
		expect(logo).toContain('data-brand-element="envelope"');
		expect(logo).toContain('data-brand-element="smoke-signal"');
		expect((logo.match(/data-brand-element="smoke-signal"/g) ?? []).length).toBe(1);
		const iconGenerator = read('scripts/generate-pwa-icons.mjs');
		expect(iconGenerator).toContain('function smokeSignalCoverage');
		expect(iconGenerator).toContain('cubicPoint');
		expect(iconGenerator).not.toContain('const points = [');
		expect(iconGenerator).toContain('blend(SAGE, INK, smokeSignalCoverage');
		let minimumClearance = Number.POSITIVE_INFINITY;
		for (const curve of SMOKE_CURVES) {
			for (let step = 0; step <= 512; step += 1) {
				const [x, y] = cubicPoint(curve[0], curve[1], curve[2], curve[3], step / 512);
				minimumClearance = Math.min(minimumClearance, distanceToEnvelopeCenterline(x, y));
			}
		}
		expect(minimumClearance).toBeGreaterThan(ENVELOPE_STROKE_HALF_WIDTH + SMOKE_STROKE_HALF_WIDTH);
	});

	test('uses neutral Noroshi demo addresses and keeps the brand story focused on mail', () => {
		expect(read('prototype/noroshi-live-demo/index.html')).not.toContain('quickmail.invalid');
		expect(read('prototype/noroshi-live-demo/test.mjs')).not.toContain('quickmail.invalid');
		expect(read('README.md')).not.toContain('忍者');
		expect(read('README.md')).toContain('狼煙');
	});

	test('keeps the former product name out of every file except upstream attribution and history', () => {
		const allowedPath = [
			/^Plans\.md$/u,
			/^docs\/research\//u,
			/^scripts\/rebrand-compatibility\.test\.mjs$/u
		];
		const allowedLine =
			/DivinPrince|quickmail-upstream|"name": "QuickMail"|QuickMail公式リポジトリ|--title "QuickMail-ja /u;
		const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
			.trim()
			.split(/\r?\n/u);
		const findings = [];
		for (const path of files) {
			if (allowedPath.some((pattern) => pattern.test(path))) continue;
			let content;
			try {
				content = read(path);
			} catch {
				continue;
			}
			if (content.includes('\u0000')) continue;
			for (const [index, line] of content.split(/\r?\n/u).entries()) {
				if (!/quickmail/iu.test(line)) continue;
				if (allowedLine.test(line)) continue;
				findings.push(`${path}:${index + 1}:${line.trim().slice(0, 120)}`);
			}
		}
		expect(findings).toEqual([]);
	});
});
