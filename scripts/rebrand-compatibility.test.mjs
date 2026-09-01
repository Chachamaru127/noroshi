import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

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
