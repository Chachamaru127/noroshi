import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { compile } from 'svelte/compiler';

const root = new URL('../../', import.meta.url).pathname;
const component = readFileSync(join(root, 'src/lib/components/AiSupportDock.svelte'), 'utf8');
const setup = readFileSync(join(root, 'src/routes/setup/+page.svelte'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

describe('AI support dock accessibility and privacy boundary', () => {
	test('compiles without accessibility warnings', () => {
		const result = compile(component, {
			filename: 'AiSupportDock.svelte',
			generate: 'client'
		});
		assert.deepEqual(result.warnings, []);
	});

	test('keeps the generated prompt visible, labeled, readonly, and keyboard selectable', () => {
		assert.match(component, /AIへ渡す質問文/);
		assert.match(component, /<label[^>]*for="ai-support-prompt-preview"/);
		assert.match(component, /<textarea[^>]*id="ai-support-prompt-preview"[^>]*readonly/);
		assert.match(component, /class="prompt-preview"/);
		assert.match(component, /質問文をコピー/);
		assert.match(component, /aria-live="polite"/);
		assert.match(component, /min-height:\s*var\(--touch-target\)/);
	});

	test('uses safe external anchor attributes and never opens or calls a service itself', () => {
		assert.match(component, /target="_blank"/);
		assert.match(component, /rel="noopener noreferrer"/);
		assert.match(component, /referrerpolicy="no-referrer"/);
		assert.doesNotMatch(component, /window\.open|fetch\s*\(|XMLHttpRequest|sendBeacon/);
	});

	test('starts copy and opens one safe HTTPS destination from every provider link', () => {
		assert.match(component, /onclick=\{\(event\) => launchProvider\(event, destination\)\}/);
		assert.match(
			component,
			/beginAiSupportLaunch\(event, destination, prompt, navigator\.clipboard\)/
		);
		assert.match(component, /href=\{destination\.href\}/);
		assert.doesNotMatch(component, /geminiCopiedPrompt|Gemini用に質問文をコピー|aria-disabled/);
		assert.doesNotMatch(component, /(?:claude|chatgpt|gemini):\/\//);
	});

	test('shows the three Remix Icon provider logos with accessible text labels', () => {
		assert.match(component, /chatgpt: 'openai-fill'/);
		assert.match(component, /claude: 'claude-fill'/);
		assert.match(component, /gemini: 'gemini-fill'/);
		assert.match(component, /<Icon name=\{PROVIDER_ICONS\[destination\.provider\]\}/);
		assert.match(component, /\{destination\.label\}/);
	});

	test('discloses URL, clipboard, account-memory, and retention boundaries', () => {
		assert.match(component, /質問文がURLに含まれ/);
		assert.match(component, /ブラウザ履歴/);
		assert.match(component, /クリップボード/);
		assert.match(component, /記憶・データ保持/);
		assert.match(component, /提携・公式サポート関係にありません/);
	});

	test('does not inspect page, form, provider, mailbox, or browser location context', () => {
		assert.doesNotMatch(
			component,
			/\$page|document\.|location\.|bootstrapSecret|bind:password|selected|chosen|providerKind|providerConfigured|mailbox|domainId/
		);
		assert.doesNotMatch(component, /<slot|\$\$restProps/);
	});

	test('setup passes only a closed stage expression to the component', () => {
		assert.match(setup, /<AiSupportDock\s+stage=\{step === 1 \? 'resend' : 'first-admin'\}\s*\/>/);
		assert.doesNotMatch(setup, /<AiSupportDock[^>]*(?:chosen|selected|error|data|bootstrapSecret)/);
	});

	test('README has a standalone, bounded AI handoff section', () => {
		assert.match(readme, /^## AIに質問$/m);
		assert.match(readme, /ChatGPT、Claude、Gemini/);
		assert.match(readme, /回答するたびに公式ドキュメント/);
		assert.match(readme, /端末やOSの関連付け/);
		assert.match(readme, /自動送信しません/);
		assert.match(readme, /デプロイ完了とメール開通は別/);
		assert.match(readme, /Resend Receiving/);
	});
});
