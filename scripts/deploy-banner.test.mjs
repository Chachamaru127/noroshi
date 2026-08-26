import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const banner = readFileSync(
	new URL('../src/lib/components/CloudflareDeployBanner.svelte', import.meta.url),
	'utf8'
);
const policySource = banner.match(/<script module lang="ts">([\s\S]*?)<\/script>/)?.[1];
if (!policySource) throw new Error('Cloudflare deploy policy module was not found');
const transpiler = new Bun.Transpiler({ loader: 'ts' });
const executablePolicy = transpiler.transformSync(policySource).replace(/\bexport\s+/g, '');
const cloudflareDeployHref = new Function(`${executablePolicy}\nreturn cloudflareDeployHref;`)();

describe('Cloudflare deployment handoff', () => {
	test('keeps the README banner inactive before public release approval', () => {
		expect(readme).toContain('公開準備中');
		expect(readme).toContain('https://deploy.workers.cloudflare.com/button');
		expect(readme).not.toMatch(/\]\(https:\/\/deploy\.workers\.cloudflare\.com\/\?url=/);
		expect(readme).not.toMatch(/href=["']https:\/\/deploy\.workers\.cloudflare\.com\/\?url=/);
		expect(readme).toContain('デプロイ完了とメール開通は別です');
	});

	test('documents every post-deploy mail readiness step', () => {
		for (const phrase of [
			'Resend',
			'Email Routing',
			'MX',
			'Catch-all',
			'シークレット',
			'D1マイグレーション',
			'最初の管理者'
		]) {
			expect(readme).toContain(phrase);
		}
	});

	test('keeps AI, Skill, and future MCP support capabilities distinct', () => {
		expect(readme).toContain('AIに相談');
		expect(readme).toContain('権限はありません');
		expect(readme).toContain('Skill');
		expect(readme).toContain('MCP');
		expect(readme).toContain('APIキー、パスワード、メール本文、DNS値');
		expect(readme).toContain('提携・公式サポート');
	});

	test('requires an approved public canonical QuickMail-ja repository for future activation', () => {
		expect(
			cloudflareDeployHref({
				repositoryUrl: 'https://github.com/example/QuickMail-ja',
				repositoryPublic: true,
				releaseApproved: true
			})
		).toBe(
			'https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fexample%2FQuickMail-ja'
		);
		expect(
			cloudflareDeployHref({
				repositoryUrl: 'https://gitlab.com/example/mail/quickmail-ja',
				repositoryPublic: true,
				releaseApproved: true
			})
		).toBe(
			'https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgitlab.com%2Fexample%2Fmail%2Fquickmail-ja'
		);
		expect(banner).toContain('aria-disabled="true"');
		expect(banner).toContain('デプロイ完了とメール開通は別です');
	});

	test('rejects private, unapproved, upstream, recovery, and non-canonical repositories', () => {
		const rejected = [
			{
				repositoryUrl: 'https://github.com/example/QuickMail-ja',
				repositoryPublic: false,
				releaseApproved: true
			},
			{
				repositoryUrl: 'https://github.com/example/QuickMail-ja',
				repositoryPublic: true,
				releaseApproved: false
			},
			{
				repositoryUrl: 'https://github.com/DivinPrince/quickmail',
				repositoryPublic: true,
				releaseApproved: true
			},
			{
				repositoryUrl: 'https://github.com/example/recovery/QuickMail-ja',
				repositoryPublic: true,
				releaseApproved: true
			},
			{
				repositoryUrl: 'http://github.com/example/QuickMail-ja',
				repositoryPublic: true,
				releaseApproved: true
			},
			{
				repositoryUrl: 'https://bitbucket.org/example/QuickMail-ja',
				repositoryPublic: true,
				releaseApproved: true
			},
			{
				repositoryUrl: 'https://github.com/example/QuickMail-ja.git',
				repositoryPublic: true,
				releaseApproved: true
			},
			{
				repositoryUrl: 'https://github.com/example/QuickMail-ja?ref=main',
				repositoryPublic: true,
				releaseApproved: true
			}
		];

		for (const input of rejected) expect(cloudflareDeployHref(input)).toBeNull();
	});
});
