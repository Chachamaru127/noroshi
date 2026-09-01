import { AI_SUPPORT_KNOWLEDGE } from './ai-support-knowledge';

export const AI_SUPPORT_STAGES = ['deploy', 'email-routing', 'resend', 'first-admin'] as const;
export type AiSupportStage = (typeof AI_SUPPORT_STAGES)[number];

export const AI_SUPPORT_PROVIDERS = [
	{ id: 'chatgpt', label: 'ChatGPTに聞く' },
	{ id: 'claude', label: 'Claudeに聞く' },
	{ id: 'gemini', label: 'Geminiに聞く' }
] as const;
export type AiSupportProvider = (typeof AI_SUPPORT_PROVIDERS)[number]['id'];

export const AI_SUPPORT_QUESTION_MAX_LENGTH = 160;
const AI_SUPPORT_PROMPT_MAX_LENGTH = 2_000;
const AI_SUPPORT_URL_MAX_LENGTH = 7_000;
const PROMPT_START = '[Noroshi Support v2]';
const PROMPT_END = '[/Noroshi Support]';

export type AiSupportDestination = {
	provider: AiSupportProvider;
	href: string;
	mode: 'prefill' | 'copy-then-open';
};

export type AiSupportClipboard = {
	writeText(value: string): Promise<void>;
};

export type AiSupportNavigationEvent = {
	preventDefault(): void;
};

export type AiSupportClock = () => Date;

export type AiSupportCopyResult = 'copied' | 'unavailable' | 'failed';

export type AiSupportInputErrorCode =
	'empty' | 'overlength' | 'control' | 'bidi' | 'html' | 'secret' | 'personal-data' | 'unsafe-url';

export class AiSupportInputError extends Error {
	constructor(readonly code: AiSupportInputErrorCode) {
		super(code);
		this.name = 'AiSupportInputError';
	}
}

const STAGE_COPY: Record<AiSupportStage, string> = {
	deploy: 'CloudflareへNoroshiをデプロイする前の準備',
	'email-routing': 'Cloudflare Email Routingの受信設定',
	resend: 'Resendの送信ドメイン設定',
	'first-admin': 'Noroshiの最初の管理者作成'
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const BIDI_CHARACTERS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const HTML_TAG = /<\s*\/?\s*[a-z][^>]*>/iu;
const EMAIL_ADDRESS = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b/iu;
const LABELED_SECRET =
	/(?:api[ _-]?key|access[ _-]?token|secret|password|token|apiキー|シークレット|パスワード|セットアップキー)\s*[:=：]\s*\S+/iu;
const KNOWN_SECRET =
	/\b(?:re_|qm_(?:live|test)_|whsec_|cfpat[_-]|sk_(?:live|test)_|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/u;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u;
const BEARER_TOKEN = /\bBearer\s+\S+/iu;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
const GENERIC_TOKEN = /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{32,256}(?=$|[^A-Za-z0-9_-])/u;
const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SYSTEM_CLOCK: AiSupportClock = () => new Date();
const EXPIRED_KNOWLEDGE_MESSAGE =
	'登録時の確認期限を過ぎています。下記URLを起点に、公式サイト内の現行ページを探し直してください。';

function codePointLength(value: string): number {
	return [...value].length;
}

function isAiSupportStage(value: unknown): value is AiSupportStage {
	return typeof value === 'string' && AI_SUPPORT_STAGES.some((stage) => stage === value);
}

function calendarDate(clock: AiSupportClock): string {
	const now = clock();
	if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
		throw new AiSupportInputError('unsafe-url');
	}
	return now.toISOString().slice(0, 10);
}

function isKnowledgeCurrent(reviewBy: string, today: string): boolean {
	if (!ISO_CALENDAR_DATE.test(reviewBy) || !ISO_CALENDAR_DATE.test(today)) {
		throw new AiSupportInputError('unsafe-url');
	}
	return today <= reviewBy;
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
	if (EMAIL_ADDRESS.test(question)) throw new AiSupportInputError('personal-data');
	if (
		LABELED_SECRET.test(question) ||
		KNOWN_SECRET.test(question) ||
		JWT.test(question) ||
		BEARER_TOKEN.test(question) ||
		PRIVATE_KEY.test(question) ||
		GENERIC_TOKEN.test(question)
	) {
		throw new AiSupportInputError('secret');
	}
	return question;
}

function promptPrefix(stage: AiSupportStage, today: string): string {
	const knowledge = AI_SUPPORT_KNOWLEDGE[stage];
	const sourceStatus = isKnowledgeCurrent(knowledge.reviewBy, today)
		? '公式ドキュメント（回答前に再確認）:'
		: `公式ドキュメント候補:\n- ${EXPIRED_KNOWLEDGE_MESSAGE}`;
	return [
		PROMPT_START,
		'この文章はNoroshiが画面に表示した内容です。AIの公式サポートではありません。',
		`手順ID: ${stage}`,
		`現在の手順: ${STAGE_COPY[stage]}`,
		'BYOK前提: Cloudflare、Resend、将来のGmail連携で使うGoogle Cloudは、利用者自身のアカウントと認証情報を使います。Noroshi共通のAPIキーやOAuth認証情報は使いません。',
		'前提: 受信はCloudflare Email Routing、送信はResendです。Resend Receivingやapexの受信用MXは使いません。',
		'回答前に、下記の公式ドキュメントを実際に開いて最新内容を確認してください。AIの記憶や検索結果の要約だけで回答しないでください。',
		sourceStatus,
		...knowledge.officialDocs.map((doc) => `- ${doc.label}: ${doc.url}`),
		`回答には確認日（${today}）と、実際に確認した公式URLを記載してください。リンクが変わっていたら、同じ公式サイト内で現行ページを探してください。`,
		'よくあるつまずき（固定の操作手順ではありません）:',
		...knowledge.stableTips.map((tip) => `- ${tip}`),
		'利用者は非エンジニアです。現在の公式画面に合わせて、次に行う操作を短く順番に説明してください。公式資料と画面が一致しない場合は、その差を先に説明してください。',
		'ブラウザ操作機能があり、利用者が許可した場合だけ公式ページを開いて必要画面まで案内してください。ログイン、アカウント切替、MFA、CAPTCHA、規約、支払い、秘密値入力、作成・保存・削除・DNS変更の直前で停止し、利用者へ操作を引き渡してください。ブラウザ操作機能がなければ公式URLと手動のメニュー経路を示してください。',
		'APIキー、パスワード、メール本文などの秘密情報や個人情報は入力させないでください。',
		'質問: '
	].join('\n');
}

function composeAiSupportPrompt(stage: AiSupportStage, question: string, today: string): string {
	return `${promptPrefix(stage, today)}${question}\n${PROMPT_END}`;
}

function assertPromptLength(prompt: string): void {
	if (!prompt.trim() || codePointLength(prompt) > AI_SUPPORT_PROMPT_MAX_LENGTH) {
		throw new AiSupportInputError('overlength');
	}
}

export function buildAiSupportPrompt(
	stage: AiSupportStage,
	value: string,
	clock: AiSupportClock = SYSTEM_CLOCK
): string {
	if (!isAiSupportStage(stage)) throw new AiSupportInputError('unsafe-url');
	const prompt = composeAiSupportPrompt(
		stage,
		validateAiSupportQuestion(value),
		calendarDate(clock)
	);
	assertPromptLength(prompt);
	return prompt;
}

/** Rebuilds the complete envelope so a marker or TypeScript brand alone can never authorize output. */
export function validateBuiltAiSupportPrompt(
	value: string,
	clock: AiSupportClock = SYSTEM_CLOCK
): string {
	assertPromptLength(value);
	const today = calendarDate(clock);
	for (const stage of AI_SUPPORT_STAGES) {
		const prefix = promptPrefix(stage, today);
		const suffix = `\n${PROMPT_END}`;
		if (!value.startsWith(prefix) || !value.endsWith(suffix)) continue;
		const question = validateAiSupportQuestion(value.slice(prefix.length, -suffix.length));
		if (composeAiSupportPrompt(stage, question, today) === value) return value;
	}
	throw new AiSupportInputError('unsafe-url');
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
	prompt: string,
	clock: AiSupportClock = SYSTEM_CLOCK
): AiSupportDestination {
	const safePrompt = validateBuiltAiSupportPrompt(prompt, clock);
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
	url.search = new URLSearchParams({ q: safePrompt }).toString();
	assertFixedDestination(url, config.origin, config.pathname);
	if (url.href.length > AI_SUPPORT_URL_MAX_LENGTH) throw new AiSupportInputError('overlength');
	return { provider, href: url.href, mode: 'prefill' };
}

export async function copyAiSupportPrompt(
	prompt: string,
	clipboard: AiSupportClipboard | null | undefined,
	clock: AiSupportClock = SYSTEM_CLOCK
): Promise<AiSupportCopyResult> {
	const safePrompt = validateBuiltAiSupportPrompt(prompt, clock);
	if (!clipboard?.writeText) return 'unavailable';
	try {
		await clipboard.writeText(safePrompt);
		return 'copied';
	} catch {
		return 'failed';
	}
}

export function beginAiSupportLaunch(
	event: AiSupportNavigationEvent,
	destination: AiSupportDestination,
	prompt: string,
	clipboard: AiSupportClipboard | null | undefined,
	clock: AiSupportClock = SYSTEM_CLOCK
): Promise<AiSupportCopyResult> | null {
	try {
		const currentDestination = buildAiSupportDestination(destination.provider, prompt, clock);
		if (currentDestination.href !== destination.href) {
			throw new AiSupportInputError('unsafe-url');
		}
	} catch {
		event.preventDefault();
		return null;
	}
	return copyAiSupportPrompt(prompt, clipboard, clock);
}
