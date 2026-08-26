export type MailUiErrorContext = 'draft' | 'send' | 'reply';

const FALLBACKS: Record<MailUiErrorContext, string> = {
	draft: '下書きを保存できませんでした。',
	send: 'メールを送信できませんでした。',
	reply: '返信を送信できませんでした。'
};

const KNOWN_ERRORS: Record<string, string> = {
	Unauthorized: 'ログインが必要です。',
	'Invalid attachments': '添付ファイルを確認してください。',
	'To, subject, and message are required': '宛先、件名、本文を入力してください。',
	'Message body is required': '本文を入力してください。',
	'Failed to send': 'メールを送信できませんでした。',
	'Failed to send email': 'メールを送信できませんでした。',
	'Failed to send reply': '返信を送信できませんでした。',
	'Could not save draft': '下書きを保存できませんでした。',
	'No sending address configured. Add one in Settings first.':
		'送信元アドレスが設定されていません。設定から追加してください。',
	'Invalid forward request': '転送内容を確認してください。',
	'Invalid attachment content': '添付ファイルを確認してください。',
	'An attachment exceeds the size limit': '添付ファイルのサイズ上限を超えています。',
	'Attachments exceed the total size limit': '添付ファイルの合計サイズ上限を超えています。',
	'Forward source not found': '転送元のメールが見つかりません。',
	'A forwarded attachment is unavailable': '転送する添付ファイルを利用できません。',
	'Invalid forwarded attachment selection': '転送する添付ファイルを確認してください。'
};

/** Convert only known API errors to UI text; never expose server or provider details. */
export function translateMailError(value: unknown, context: MailUiErrorContext): string {
	if (typeof value !== 'string') return FALLBACKS[context];
	return KNOWN_ERRORS[value] ?? FALLBACKS[context];
}

export function deliveryFailureMessage(status: unknown): string {
	if (status === 'bounced') return '宛先に届きませんでした。';
	return '送信できませんでした。';
}
