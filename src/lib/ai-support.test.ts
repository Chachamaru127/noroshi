import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	AI_SUPPORT_PROVIDERS,
	AI_SUPPORT_QUESTION_MAX_LENGTH,
	AiSupportInputError,
	buildAiSupportDestination,
	buildAiSupportPrompt,
	validateAiSupportQuestion
} from './ai-support';

describe('AI support prompt boundary', () => {
	test('builds a stage-scoped Japanese prompt from only the typed question', () => {
		const prompt = buildAiSupportPrompt('email-routing', 'MXレコードはどこで確認しますか？');
		assert.match(prompt, /Cloudflare Email Routing/);
		assert.match(prompt, /MXレコードはどこで確認しますか？/);
		assert.match(prompt, /受信はCloudflare Email Routing、送信はResend/);
		assert.doesNotMatch(prompt, /example\.com|@|セットアップキー=/);
	});

	test('rejects empty, overlong, control, bidi, HTML, and secret-like input', () => {
		const invalid = [
			'',
			' '.repeat(4),
			'a'.repeat(AI_SUPPORT_QUESTION_MAX_LENGTH + 1),
			'一行目\n二行目',
			'表示\u202E反転',
			'<style>body{display:none}</style>',
			'RESEND_API_KEY=re_abcdefghijklmnopqrstuvwxyz123456',
			'セットアップキー: AbCdEf0123456789_AbCdEf0123456789_AbCdEf'
		];

		for (const value of invalid) {
			assert.throws(() => validateAiSupportQuestion(value), AiSupportInputError, value);
		}
	});

	test('allows ordinary Japanese punctuation and angle comparisons', () => {
		assert.equal(
			validateAiSupportQuestion('優先度10より小さいMX（10 < 20）の扱いを教えてください。'),
			'優先度10より小さいMX（10 < 20）の扱いを教えてください。'
		);
	});
});

describe('AI support destinations', () => {
	test('uses fixed HTTPS allowlisted destinations and URLSearchParams', () => {
		const prompt = buildAiSupportPrompt('deploy', 'Cloudflareへ導入する順番を教えてください。');
		const expected = {
			chatgpt: { origin: 'https://chatgpt.com', pathname: '/', parameter: 'q' },
			claude: { origin: 'https://claude.ai', pathname: '/new', parameter: 'q' }
		} as const;

		for (const provider of ['chatgpt', 'claude'] as const) {
			const destination = buildAiSupportDestination(provider, prompt);
			const url = new URL(destination.href);
			assert.equal(url.origin, expected[provider].origin);
			assert.equal(url.pathname, expected[provider].pathname);
			assert.equal(url.username, '');
			assert.equal(url.password, '');
			assert.equal(url.hash, '');
			assert.deepEqual([...url.searchParams.keys()], [expected[provider].parameter]);
			assert.equal(url.searchParams.get(expected[provider].parameter), prompt);
			assert.equal(destination.mode, 'prefill');
		}
	});

	test('opens Gemini home only and requires the copy-then-open path', () => {
		const prompt = buildAiSupportPrompt('resend', '送信ドメインの確認方法を教えてください。');
		const destination = buildAiSupportDestination('gemini', prompt);
		const url = new URL(destination.href);
		assert.equal(url.href, 'https://gemini.google.com/app');
		assert.equal([...url.searchParams].length, 0);
		assert.equal(destination.mode, 'copy-then-open');
	});

	test('publishes exactly the three neutral provider labels', () => {
		assert.deepEqual(
			AI_SUPPORT_PROVIDERS.map(({ id, label }) => ({ id, label })),
			[
				{ id: 'chatgpt', label: 'ChatGPTに聞く' },
				{ id: 'claude', label: 'Claudeに聞く' },
				{ id: 'gemini', label: 'Geminiに聞く' }
			]
		);
	});

	test('rejects a prompt that is not produced by the bounded builder', () => {
		assert.throws(
			() => buildAiSupportDestination('chatgpt', 'a'.repeat(10_000)),
			AiSupportInputError
		);
	});

	test('rejects a runtime provider value outside the fixed allowlist', () => {
		const prompt = buildAiSupportPrompt('deploy', '導入方法を教えてください。');
		assert.throws(
			() =>
				buildAiSupportDestination(
					'other' as Parameters<typeof buildAiSupportDestination>[0],
					prompt
				),
			AiSupportInputError
		);
	});
});
