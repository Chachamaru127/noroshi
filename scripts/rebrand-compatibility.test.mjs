import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
	for (const key of [
		'NOROSHI_CONFIG',
		'QUICKMAIL_CONFIG',
		'NOROSHI_URL',
		'NOROSHI_TOKEN',
		'QUICKMAIL_URL',
		'QUICKMAIL_TOKEN'
	]) {
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
		expect(JSON.parse(read('package.json')).name).toBe('noroshi-mail');
		expect(JSON.parse(read('cli/package.json')).name).toBe('noroshi-cli');
		expect(read('bun.lock')).toMatch(/""\s*:\s*\{\s*"name"\s*:\s*"noroshi-mail"/u);
	});

	test('makes noroshi canonical while keeping the quickmail CLI and configuration aliases', () => {
		const pkg = JSON.parse(read('package.json'));
		expect(pkg.bin.noroshi).toBe('./bin/noroshi.mjs');
		expect(pkg.bin.quickmail).toBe('./bin/quickmail.mjs');
		expect(pkg.scripts.noroshi).toBe('bun cli/main.ts');
		expect(pkg.scripts.quickmail).toBe('bun cli/main.ts');
		const cli = read('cli/main.ts');
		expect(cli).toContain('noroshi — operate a Noroshi instance');
		expect(cli).toContain('noroshi login');
		const config = read('cli/config.ts');
		expect(config).toContain('NOROSHI_CONFIG');
		expect(config).toContain('QUICKMAIL_CONFIG');
		expect(config).toContain("join(base, 'quickmail', 'config.json')");
		expect(config).toContain('QUICKMAIL_URL');
		expect(config).toContain('QUICKMAIL_TOKEN');
		for (const entrypoint of ['bin/noroshi.mjs', 'bin/quickmail.mjs']) {
			const help = execFileSync('bun', [entrypoint, '--help'], {
				cwd: root,
				encoding: 'utf8'
			});
			expect(help, entrypoint).toContain('noroshi — operate a Noroshi instance');
		}
		expect(statSync(join(root, 'bin/noroshi.mjs')).mode & 0o111).not.toBe(0);
		const directHelp = execFileSync(join(root, 'bin/noroshi.mjs'), ['--help'], {
			cwd: root,
			encoding: 'utf8'
		});
		expect(directHelp).toContain('noroshi — operate a Noroshi instance');
		const unknown = Bun.spawnSync([join(root, 'bin/noroshi.mjs'), 'not-a-command'], {
			cwd: root,
			env: cleanCliEnv({})
		});
		expect(unknown.exitCode).toBe(1);
		const unknownError = new TextDecoder().decode(unknown.stderr);
		expect(unknownError).toContain('Run noroshi --help.');
		expect(unknownError).not.toContain('Run quickmail --help.');
		expect(read('src/routes/settings/+page.svelte')).toContain('bun run noroshi');
		expect(read('src/routes/settings/+page.svelte')).toContain('quickmail');
	});

	test('does not fall back to legacy config when the canonical config is malformed', () => {
		const configRoot = mkdtempSync(join(tmpdir(), 'noroshi-config-'));
		mkdirSync(join(configRoot, 'noroshi'), { recursive: true });
		mkdirSync(join(configRoot, 'quickmail'), { recursive: true });
		writeFileSync(join(configRoot, 'noroshi', 'config.json'), '{ malformed');
		writeFileSync(
			join(configRoot, 'quickmail', 'config.json'),
			JSON.stringify({ url: 'https://legacy.example.invalid', token: 'legacy-token' })
		);
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

	test('falls back to legacy config only when the canonical config is absent', () => {
		const configRoot = mkdtempSync(join(tmpdir(), 'noroshi-legacy-config-'));
		mkdirSync(join(configRoot, 'quickmail'), { recursive: true });
		writeFileSync(
			join(configRoot, 'quickmail', 'config.json'),
			JSON.stringify({ url: 'https://legacy.example.invalid', token: 'legacy-token' })
		);
		const result = Bun.spawnSync(
			[
				'bun',
				'-e',
				`import { loadConfig } from ${JSON.stringify(join(root, 'cli/config.ts'))}; const config = await loadConfig(); console.log(config.token);`
			],
			{
				cwd: root,
				env: cleanCliEnv({ XDG_CONFIG_HOME: configRoot })
			}
		);
		expect(result.exitCode).toBe(0);
		expect(new TextDecoder().decode(result.stdout).trim()).toBe('legacy-token');
	});

	test('rejects mixed canonical and legacy environment credentials in both directions', () => {
		for (const mixed of [
			{ NOROSHI_URL: 'https://new.example.invalid', QUICKMAIL_TOKEN: 'legacy-token' },
			{ QUICKMAIL_URL: 'https://legacy.example.invalid', NOROSHI_TOKEN: 'new-token' }
		]) {
			const result = Bun.spawnSync(
				[
					'bun',
					'-e',
					`import { loadConfig } from ${JSON.stringify(join(root, 'cli/config.ts'))}; try { const config = await loadConfig(); console.log('LOADED:' + config.url + ':' + config.token); } catch (error) { console.log('REJECTED:' + error.message); }`
				],
				{ cwd: root, env: cleanCliEnv(mixed) }
			);
			expect(result.exitCode).toBe(0);
			expect(new TextDecoder().decode(result.stdout)).toContain('REJECTED:');
		}
	});

	test('keeps compatibility and attribution identifiers exact', () => {
		expect(JSON.parse(read('plugin.json')).name).toBe('quickmail-ja-setup');
		expect(read('mcp.json')).toContain('quickmail-ja-setup-engine');
		expect(read('scripts/setup-engine.mjs')).toContain("'quickmail-ja.setup-engine.v1'");
		expect(read('src/lib/server/forwarding-delivery.ts')).toContain('X-QuickMail-Forwarded');
		expect(read('src/lib/server/forwarding-delivery.ts')).toContain('quickmail-forward:');
		expect(read('scripts/outlook-import-core.mjs')).toContain(
			"'.quickmail-ja-outlook-import-staging'"
		);
		expect(read('wrangler.jsonc')).toMatch(/^\s*"name"\s*:\s*"quickmail-ja"/m);
		expect(read('wrangler.jsonc')).toContain('"bucket_name": "quickmail-ja-attachments"');
		expect(read('README.md')).toContain('DivinPrince/quickmail');
		expect(read('cli/mcp.ts')).toContain("new McpServer({ name: 'quickmail'");
	});

	test('uses Noroshi prose without renaming plugin, Skill, or MCP ids', () => {
		const plugin = JSON.parse(read('plugin.json'));
		expect(plugin.description).toContain('Noroshi');
		expect(plugin.author.name).toBe('Noroshi');
		expect(read('skills/quickmail-ja-setup/SKILL.md')).toContain('Noroshi');
		expect(read('skills/quickmail-ja-operations/SKILL.md')).toContain('Noroshi');
		expect(read('skills/quickmail-ja-setup/agents/openai.yaml')).toContain(
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
		expect(read('prototype/quickmail-ja-live-demo/index.html')).not.toContain('quickmail.invalid');
		expect(read('prototype/quickmail-ja-live-demo/test.mjs')).not.toContain('quickmail.invalid');
		expect(read('README.md')).not.toContain('忍者');
		expect(read('README.md')).toContain('狼煙');
	});

	test('allows the former public name only at documented compatibility and history boundaries', () => {
		const allowlist = new Map([
			['Plans.md', null],
			['README.md', /旧QuickMail-ja/u],
			['spec.md', /formerly QuickMail-ja/u],
			['scripts/outlook-import-core.mjs', /QuickMail-ja Outlook import staging v1/u],
			[
				'scripts/outlook-import-core.test.mjs',
				/QuickMail-ja Outlook import staging v1|\/QuickMail-ja\//u
			],
			['src/lib/ai-support.test.ts', /\[QuickMail-ja Support v2\]/u],
			['scripts/agent-plugin.test.mjs', /QuickMail-ja(?: fixture)?/u],
			['scripts/rebrand-compatibility.test.mjs', /QuickMail-ja/u]
		]);
		const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
			.trim()
			.split(/\r?\n/u);
		if (!files.includes('scripts/rebrand-compatibility.test.mjs')) {
			files.push('scripts/rebrand-compatibility.test.mjs');
		}
		const findings = [];
		for (const path of files) {
			const content = read(path);
			for (const [index, line] of content.split(/\r?\n/u).entries()) {
				if (!line.includes('QuickMail-ja')) continue;
				const allowed = allowlist.get(path);
				if (allowlist.has(path) && (allowed === null || allowed.test(line))) continue;
				findings.push(`${path}:${index + 1}:${line.trim()}`);
			}
		}
		expect(findings).toEqual([]);
	});
});
