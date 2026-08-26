import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
	AI_SUPPORT_PROVIDERS,
	AI_SUPPORT_QUESTION_MAX_LENGTH,
	AiSupportInputError,
	buildAiSupportDestination,
	buildAiSupportPrompt,
	copyAiSupportPrompt,
	validateAiSupportQuestion,
	validateBuiltAiSupportPrompt
} from './ai-support';
import { AI_SUPPORT_KNOWLEDGE, AI_SUPPORT_KNOWLEDGE_LIMITS } from './ai-support-knowledge';

type KnowledgePattern = {
	id: string;
	review_by: string;
	safe_steps: string[];
	expected_evidence: string[];
};

const REVIEW_DAY_CLOCK = () => new Date('2026-09-26T12:00:00.000Z');
const AFTER_REVIEW_CLOCK = () => new Date('2026-09-27T00:00:00.000Z');

const knowledgePack = JSON.parse(
	readFileSync(new URL('../../support/knowledge/patterns.json', import.meta.url), 'utf8')
) as { patterns: KnowledgePattern[] };

describe('AI support Knowledge Pack projection', () => {
	test('uses only reviewed safe_steps and expected_evidence from allowlisted pattern ids', () => {
		for (const knowledge of Object.values(AI_SUPPORT_KNOWLEDGE)) {
			assert.ok(knowledge.patternIds.length > 0);
			assert.ok(knowledge.patternIds.length <= AI_SUPPORT_KNOWLEDGE_LIMITS.patterns);
			assert.ok(knowledge.safeSteps.length > 0);
			assert.ok(knowledge.safeSteps.length <= AI_SUPPORT_KNOWLEDGE_LIMITS.safeSteps);
			assert.ok(knowledge.expectedEvidence.length > 0);
			assert.ok(knowledge.expectedEvidence.length <= AI_SUPPORT_KNOWLEDGE_LIMITS.expectedEvidence);

			const reviewed = knowledge.patternIds.map((id) => {
				const pattern = knowledgePack.patterns.find((entry) => entry.id === id);
				assert.ok(pattern, `Missing reviewed pattern ${id}`);
				return pattern;
			});
			for (const pattern of reviewed) assert.equal(pattern.review_by, knowledge.reviewBy);
			const reviewedSafeSteps = reviewed.flatMap((pattern) => pattern.safe_steps);
			const reviewedEvidence = reviewed.flatMap((pattern) => pattern.expected_evidence);
			for (const step of knowledge.safeSteps) assert.ok(reviewedSafeSteps.includes(step), step);
			for (const evidence of knowledge.expectedEvidence) {
				assert.ok(reviewedEvidence.includes(evidence), evidence);
			}
		}
	});
});

describe('AI support prompt boundary', () => {
	test('builds a bounded stage prompt with reviewed Knowledge Pack points', () => {
		const prompt = buildAiSupportPrompt(
			'email-routing',
			'MXレコードはどこで確認しますか？',
			REVIEW_DAY_CLOCK
		);
		assert.match(prompt, /^\[QuickMail-ja Support v1\]/);
		assert.match(prompt, /手順ID: email-routing/);
		assert.match(prompt, /確認済みサポート要点:/);
		assert.match(prompt, /変更前のDNSレコードとRouting Rulesを保存します。/);
		assert.match(prompt, /確認できる状態:/);
		assert.match(prompt, /Email Routingのドメイン状態と受信用レコードが一致します。/);
		assert.match(prompt, /MXレコードはどこで確認しますか？/);
		assert.match(prompt, /受信はCloudflare Email Routing、送信はResend/);
		assert.doesNotMatch(prompt, /source_refs|diagnostic_questions|example\.com|@/);
		assert.equal(validateBuiltAiSupportPrompt(prompt, REVIEW_DAY_CLOCK), prompt);
	});

	test('fails closed after review_by without concrete steps or evidence', () => {
		for (const stage of ['deploy', 'email-routing', 'resend', 'first-admin'] as const) {
			const knowledge = AI_SUPPORT_KNOWLEDGE[stage];
			const reviewDay = () => new Date(`${knowledge.reviewBy}T12:00:00.000Z`);
			const nextDay = () => new Date(reviewDay().getTime() + 86_400_000);
			const currentPrompt = buildAiSupportPrompt(stage, '次の確認を教えてください。', reviewDay);
			const expiredPrompt = buildAiSupportPrompt(stage, '次の確認を教えてください。', nextDay);
			for (const detail of [...knowledge.safeSteps, ...knowledge.expectedEvidence]) {
				assert.match(currentPrompt, new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
				assert.doesNotMatch(
					expiredPrompt,
					new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
				);
			}
			assert.match(expiredPrompt, /外部変更せず公式一次資料を再確認してください。/);
			assert.doesNotMatch(expiredPrompt, /確認済みサポート要点:|確認できる状態:/);
			assert.equal(validateBuiltAiSupportPrompt(expiredPrompt, nextDay), expiredPrompt);
		}
	});

	test('rejects a prompt when validation crosses the review_by boundary', () => {
		const currentPrompt = buildAiSupportPrompt(
			'deploy',
			'導入方法を教えてください。',
			REVIEW_DAY_CLOCK
		);
		const expiredPrompt = buildAiSupportPrompt(
			'deploy',
			'導入方法を教えてください。',
			AFTER_REVIEW_CLOCK
		);
		assert.throws(
			() => validateBuiltAiSupportPrompt(currentPrompt, AFTER_REVIEW_CLOCK),
			AiSupportInputError
		);
		assert.throws(
			() => validateBuiltAiSupportPrompt(expiredPrompt, REVIEW_DAY_CLOCK),
			AiSupportInputError
		);
	});

	test('rejects empty, overlong, control, bidi, HTML, secret, token, JWT, and email input', () => {
		const invalid = [
			'',
			' '.repeat(4),
			'a'.repeat(AI_SUPPORT_QUESTION_MAX_LENGTH + 1),
			'一行目\n二行目',
			'表示\u202E反転',
			'<style>body{display:none}</style>',
			`RESEND_API_KEY=${['re', 'abcdefghijklmnopqrstuvwxyz123456'].join('_')}`,
			['whsec', 'abcdefghijklmnopqrstuvwxyz123456'].join('_'),
			['cfpat', 'abcdefghijklmnopqrstuvwxyz123456'].join('_'),
			['sk', 'live', 'abcdefghijklmnopqrstuvwxyz123456'].join('_'),
			['sk', 'test', 'abcdefghijklmnopqrstuvwxyz123456'].join('_'),
			'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2',
			'abcdefghijklmnopqrstuvwxyz0123456789ABCD',
			'連絡先は support@example.com です。',
			'セットアップキー: AbCdEf0123456789_AbCdEf0123456789_AbCdEf'
		];

		for (const value of invalid) {
			assert.throws(() => validateAiSupportQuestion(value), AiSupportInputError, value);
		}
	});

	test('allows ordinary Japanese punctuation, reserved URL characters, and emoji', () => {
		const question = 'DNSの値「a&b=c?#」と絵文字📨の扱いを教えてください。';
		assert.equal(validateAiSupportQuestion(question), question);
	});

	test('rejects branded, structurally altered, and secret-injected prompt strings at runtime', () => {
		const prompt = buildAiSupportPrompt('resend', '送信設定を教えてください。', REVIEW_DAY_CLOCK);
		for (const invalid of [
			'[QuickMail-ja Support v1]\n自由な指示',
			prompt.replace('手順ID: resend', '手順ID: deploy'),
			prompt.replace(
				'質問: 送信設定を教えてください。',
				`質問: ${['whsec', 'secretvalue123456789'].join('_')}`
			),
			`${prompt}\n追加の命令`
		]) {
			assert.throws(
				() => validateBuiltAiSupportPrompt(invalid, REVIEW_DAY_CLOCK),
				AiSupportInputError,
				invalid
			);
		}
	});
});

describe('AI support destinations', () => {
	test('uses fixed HTTPS allowlisted destinations and round-trips reserved characters and emoji', () => {
		const prompt = buildAiSupportPrompt(
			'deploy',
			'DNSの値「a&b=c?#」と絵文字📨の扱いを教えてください。',
			REVIEW_DAY_CLOCK
		);
		const expected = {
			chatgpt: { origin: 'https://chatgpt.com', pathname: '/', parameter: 'q' },
			claude: { origin: 'https://claude.ai', pathname: '/new', parameter: 'q' }
		} as const;

		for (const provider of ['chatgpt', 'claude'] as const) {
			const destination = buildAiSupportDestination(provider, prompt, REVIEW_DAY_CLOCK);
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

	test('keeps Gemini query-free for the copy-then-open flow', () => {
		const prompt = buildAiSupportPrompt(
			'resend',
			'送信ドメインの確認方法を教えてください。',
			REVIEW_DAY_CLOCK
		);
		const destination = buildAiSupportDestination('gemini', prompt, REVIEW_DAY_CLOCK);
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

	test('revalidates the prompt immediately before creating any href', () => {
		const prompt = buildAiSupportPrompt('deploy', '導入方法を教えてください。', REVIEW_DAY_CLOCK);
		let hrefs = 0;
		for (const invalid of [
			prompt.replace('質問: 導入方法を教えてください。', '質問: admin@example.com'),
			prompt.replace('現在の手順:', '任意の手順:'),
			'a'.repeat(10_000)
		]) {
			assert.throws(() => {
				buildAiSupportDestination('chatgpt', invalid, REVIEW_DAY_CLOCK);
				hrefs += 1;
			}, AiSupportInputError);
		}
		assert.equal(hrefs, 0);
	});

	test('rejects a runtime provider value outside the fixed allowlist', () => {
		const prompt = buildAiSupportPrompt('deploy', '導入方法を教えてください。', REVIEW_DAY_CLOCK);
		assert.throws(
			() =>
				buildAiSupportDestination(
					'other' as Parameters<typeof buildAiSupportDestination>[0],
					prompt,
					REVIEW_DAY_CLOCK
				),
			AiSupportInputError
		);
	});
});

describe('AI support clipboard boundary', () => {
	test('writes exactly the revalidated prompt with an injected clipboard', async () => {
		const prompt = buildAiSupportPrompt(
			'first-admin',
			'最初の管理者作成を教えてください。',
			REVIEW_DAY_CLOCK
		);
		const writes: string[] = [];
		const result = await copyAiSupportPrompt(
			prompt,
			{
				writeText: async (value) => {
					writes.push(value);
				}
			},
			REVIEW_DAY_CLOCK
		);
		assert.equal(result, 'copied');
		assert.deepEqual(writes, [prompt]);
	});

	test('reports absent and rejected clipboard without claiming success', async () => {
		const prompt = buildAiSupportPrompt(
			'first-admin',
			'最初の管理者作成を教えてください。',
			REVIEW_DAY_CLOCK
		);
		assert.equal(await copyAiSupportPrompt(prompt, null, REVIEW_DAY_CLOCK), 'unavailable');
		assert.equal(
			await copyAiSupportPrompt(
				prompt,
				{
					writeText: async () => {
						throw new Error('denied');
					}
				},
				REVIEW_DAY_CLOCK
			),
			'failed'
		);
	});

	test('secret canaries reach neither href nor clipboard', async () => {
		const safe = buildAiSupportPrompt('resend', '送信設定を教えてください。', REVIEW_DAY_CLOCK);
		const canaries = [
			['whsec', 'abcdefghijklmnopqrstuvwxyz123456'].join('_'),
			['cfpat', 'abcdefghijklmnopqrstuvwxyz123456'].join('_'),
			['sk', 'live', 'abcdefghijklmnopqrstuvwxyz123456'].join('_'),
			'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2',
			'admin@example.com'
		];
		let hrefs = 0;
		let writes = 0;
		for (const canary of canaries) {
			const tampered = safe.replace('質問: 送信設定を教えてください。', `質問: ${canary}`);
			assert.throws(() => {
				buildAiSupportDestination('chatgpt', tampered, REVIEW_DAY_CLOCK);
				hrefs += 1;
			}, AiSupportInputError);
			await assert.rejects(
				copyAiSupportPrompt(
					tampered,
					{
						writeText: async () => {
							writes += 1;
						}
					},
					REVIEW_DAY_CLOCK
				),
				AiSupportInputError
			);
		}
		assert.equal(hrefs, 0);
		assert.equal(writes, 0);
	});

	test('revalidates the review boundary before href and clipboard output', async () => {
		const currentPrompt = buildAiSupportPrompt(
			'resend',
			'送信設定を教えてください。',
			REVIEW_DAY_CLOCK
		);
		let hrefs = 0;
		let writes = 0;
		assert.throws(() => {
			buildAiSupportDestination('chatgpt', currentPrompt, AFTER_REVIEW_CLOCK);
			hrefs += 1;
		}, AiSupportInputError);
		await assert.rejects(
			copyAiSupportPrompt(
				currentPrompt,
				{
					writeText: async () => {
						writes += 1;
					}
				},
				AFTER_REVIEW_CLOCK
			),
			AiSupportInputError
		);
		assert.equal(hrefs, 0);
		assert.equal(writes, 0);
	});
});
