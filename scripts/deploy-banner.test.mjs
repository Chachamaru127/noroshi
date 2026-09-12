import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const guide = readFileSync(new URL('../docs/setup-and-operations.md', import.meta.url), 'utf8');
const deploySection = guide.match(/## Cloudflareへの展開[\s\S]*?(?=\n## )/)?.[0] ?? '';
const deployBanner = readFileSync(
	new URL('../docs/assets/deploy-to-cloudflare-disabled.svg', import.meta.url),
	'utf8'
);

describe('Cloudflare deployment handoff', () => {
	test('keeps the deploy banner inactive before public release approval', () => {
		expect(guide).toContain('公開準備中');
		expect(deploySection).toContain('docs/assets/deploy-to-cloudflare-disabled.svg');
		expect(deploySection).not.toMatch(/<img[^>]+src=["']https?:\/\//i);
		expect(deploySection).not.toMatch(/!\[[^\]]*\]\(https?:\/\//i);
		expect(deployBanner).not.toMatch(/(?:href|src)=["']https?:\/\//i);
		for (const doc of [readme, guide]) {
			expect(doc).not.toMatch(/\]\(https:\/\/deploy\.workers\.cloudflare\.com\/\?url=/);
			expect(doc).not.toMatch(/href=["']https:\/\/deploy\.workers\.cloudflare\.com\/\?url=/);
		}
		expect(guide).toContain('デプロイ完了とメール開通は別です');
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
			expect(guide).toContain(phrase);
		}
	});

	test('keeps AI, Skill, Setup MCP, and host adapter capabilities distinct', () => {
		expect(guide).toContain('AIに相談');
		expect(guide).toContain('権限はありません');
		expect(guide).toContain('Skill');
		expect(guide).toContain('MCP');
		expect(guide).toContain('デプロイ後のResend設定と最初の管理者作成');
		expect(guide).toContain('Setup Skill（ローカル提供中）');
		expect(guide).toContain('Setup MCP（ローカル提供中）');
		expect(guide).toContain('provider非接続。外部writeと承認は行いません');
		expect(guide).toContain('現在の配布物には実provider adapterがありません');
		expect(guide).toContain('導入はBYOK');
		expect(guide).toContain('APIキー、パスワード、メール本文、DNS値');
		expect(guide).toContain('提携・公式サポート');
	});
});
