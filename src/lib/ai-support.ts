export const AI_SUPPORT_STAGES = ['deploy', 'email-routing', 'resend', 'first-admin'] as const;
export type AiSupportStage = (typeof AI_SUPPORT_STAGES)[number];

export const AI_SUPPORT_PROVIDERS = [
	{ id: 'chatgpt', label: 'ChatGPTに聞く' },
	{ id: 'claude', label: 'Claudeに聞く' },
	{ id: 'gemini', label: 'Geminiに聞く' }
] as const;
export type AiSupportProvider = (typeof AI_SUPPORT_PROVIDERS)[number]['id'];

export const AI_SUPPORT_QUESTION_MAX_LENGTH = 400;
const AI_SUPPORT_PROMPT_MAX_LENGTH = 2_000;
const AI_SUPPORT_URL_MAX_LENGTH = 7_000;

export type AiSupportDestination = {
	provider: AiSupportProvider;
	href: string;
	mode: 'prefill' | 'copy-then-open';
};

export type AiSupportInputErrorCode =
	'empty' | 'overlength' | 'control' | 'bidi' | 'html' | 'secret' | 'unsafe-url';

export class AiSupportInputError extends Error {
	constructor(readonly code: AiSupportInputErrorCode) {
		super(code);
		this.name = 'AiSupportInputError';
	}
}

const STAGE_COPY: Record<AiSupportStage, string> = {
	deploy: 'CloudflareへQuickMail-jaをデプロイする前の準備',
	'email-routing': 'Cloudflare Email Routingの受信設定',
	resend: 'Resendの送信ドメイン設定',
	'first-admin': 'QuickMail-jaの最初の管理者作成'
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const BIDI_CHARACTERS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const HTML_TAG = /<\s*\/?\s*[a-z][^>]*>/iu;
const LABELED_SECRET =
	/(?:api[ _-]?key|access[ _-]?token|secret|password|token|apiキー|シークレット|パスワード|セットアップキー)\s*[:=：]\s*\S+/iu;
const KNOWN_SECRET = /\b(?:re|qm_(?:live|test))_[A-Za-z0-9_-]{12,}\b/u;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
const HIGH_ENTROPY_VALUE =
	/\b(?=[A-Za-z0-9_-]{32,128}\b)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/u;

function codePointLength(value: string): number {
	return [...value].length;
}

export function validateAiSupportQuestion(value: string): string {
	const question = value.trim();
	if (!question) throw new AiSupportInputError('empty');
	if (codePointLength(question) > AI_SUPPORT_QUESTION_MAX_LENGTH) {
		throw new AiSupportInputError('overlength');
	}
	if (CONTROL_CHARACTERS.test(question)) throw new AiSupportInputError('control');
	if (BIDI_CHARACTERS.test(question)) throw new AiSupportInputError('bidi');
	if (HTML_TAG.test(question)) throw new AiSupportInputError('html');
	if (
		LABELED_SECRET.test(question) ||
		KNOWN_SECRET.test(question) ||
		PRIVATE_KEY.test(question) ||
		HIGH_ENTROPY_VALUE.test(question)
	) {
		throw new AiSupportInputError('secret');
	}
	return question;
}

export function buildAiSupportPrompt(stage: AiSupportStage, value: string): string {
	const question = validateAiSupportQuestion(value);
	return [
		'あなたはQuickMail-jaの導入を支援する日本語サポート担当です。',
		`現在の手順: ${STAGE_COPY[stage]}`,
		'前提: 受信はCloudflare Email Routing、送信はResendです。Resend Receivingやapexの受信用MXは使いません。',
		'公式情報を優先し、非エンジニアにも分かるよう一度に一つずつ説明してください。秘密情報の入力を求めないでください。ログイン、MFA、規約同意、課金、デプロイ、DNS変更は利用者本人が内容を確認して操作します。',
		`質問: ${question}`
	].join('\n');
}

function assertPromptLength(prompt: string): void {
	if (!prompt.trim() || codePointLength(prompt) > AI_SUPPORT_PROMPT_MAX_LENGTH) {
		throw new AiSupportInputError('overlength');
	}
}

function assertFixedDestination(url: URL, origin: string, pathname: string): void {
	if (
		url.protocol !== 'https:' ||
		url.origin !== origin ||
		url.pathname !== pathname ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw new AiSupportInputError('unsafe-url');
	}
}

export function buildAiSupportDestination(
	provider: AiSupportProvider,
	prompt: string
): AiSupportDestination {
	assertPromptLength(prompt);
	if (!AI_SUPPORT_PROVIDERS.some(({ id }) => id === provider)) {
		throw new AiSupportInputError('unsafe-url');
	}

	if (provider === 'gemini') {
		const url = new URL('https://gemini.google.com/app');
		assertFixedDestination(url, 'https://gemini.google.com', '/app');
		return { provider, href: url.href, mode: 'copy-then-open' };
	}

	const config =
		provider === 'chatgpt'
			? { base: 'https://chatgpt.com/', origin: 'https://chatgpt.com', pathname: '/' }
			: { base: 'https://claude.ai/new', origin: 'https://claude.ai', pathname: '/new' };
	const url = new URL(config.base);
	url.search = new URLSearchParams({ q: prompt }).toString();
	assertFixedDestination(url, config.origin, config.pathname);
	if (url.href.length > AI_SUPPORT_URL_MAX_LENGTH) throw new AiSupportInputError('overlength');
	return { provider, href: url.href, mode: 'prefill' };
}
