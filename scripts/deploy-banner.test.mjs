import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const deploySection = readme.match(/## Cloudflareへの展開[\s\S]*?(?=\n## )/)?.[0] ?? '';
const deployBanner = readFileSync(
	new URL('../docs/assets/deploy-to-cloudflare-disabled.svg', import.meta.url),
	'utf8'
);

describe('Cloudflare deployment handoff', () => {
	test('keeps the README banner inactive before public release approval', () => {
		expect(readme).toContain('公開準備中');
		expect(deploySection).toContain('docs/assets/deploy-to-cloudflare-disabled.svg');
		expect(deploySection).not.toMatch(/<img[^>]+src=["']https?:\/\//i);
		expect(deploySection).not.toMatch(/!\[[^\]]*\]\(https?:\/\//i);
		expect(deployBanner).not.toMatch(/(?:href|src)=["']https?:\/\//i);
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
		expect(readme).toContain('デプロイ後のResend設定と最初の管理者作成');
		expect(readme).toContain('デプロイ前の導線、Email Routing支援、Setup Skill、MCPは未提供');
		expect(readme).toContain('APIキー、パスワード、メール本文、DNS値');
		expect(readme).toContain('提携・公式サポート');
	});
});
