import type { EmailProviderKind } from '$lib/types';

export function providerName(kind: EmailProviderKind): string {
	switch (kind) {
		case 'resend':
			return 'Resend';
		case 'cloudflare':
			return 'Cloudflare Email';
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

/** Render only known provider states; never leak a provider's raw status to the UI. */
export function domainStatusLabel(status: unknown): string {
	switch (status) {
		case 'verified':
			return '確認済み';
		case 'pending':
			return '確認待ち';
		case 'missing':
			return '見つかりません';
		case 'failed':
			return '確認失敗';
		case 'not_started':
			return '未開始';
		case 'temporary_failure':
			return '一時的なエラー';
		case 'suspended':
			return '停止中';
		case 'deleted':
			return '削除済み';
		case 'unverified':
			return '未確認';
		default:
			return '状態不明';
	}
}

export function missingProviderTitle(kind: EmailProviderKind): string {
	switch (kind) {
		case 'resend':
			return 'Resend APIキーが設定されていません';
		case 'cloudflare':
			return 'Cloudflare Emailが設定されていません';
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

export function missingProviderHint(kind: EmailProviderKind): string {
	switch (kind) {
		case 'resend':
			return 'wrangler secret put RESEND_API_KEY';
		case 'cloudflare':
			return 'EMAIL_PROVIDER=cloudflare\nCLOUDFLARE_MAIL_DOMAINS=yourdomain.com';
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

export function noDomainsTitle(kind: EmailProviderKind): string {
	switch (kind) {
		case 'resend':
			return 'このResendアカウントにドメインがありません';
		case 'cloudflare':
			return 'CLOUDFLARE_MAIL_DOMAINSにドメインがありません';
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

export function noDomainsBody(kind: EmailProviderKind): string {
	switch (kind) {
		case 'resend':
			return 'resend.com/domainsで送信用ドメインを追加・認証し、Cloudflare Email Routingにも同じドメインを登録してから再読み込みしてください。';
		case 'cloudflare':
			return 'Cloudflare Email Serviceでドメインを登録し、CLOUDFLARE_MAIL_DOMAINSを設定してから再読み込みしてください。';
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

export function domainPickerSubtitle(kind: EmailProviderKind): string {
	switch (kind) {
		case 'resend':
			return 'Resendで送信認証済み、かつCloudflare Email Routingで受信するドメインです。使用するドメインを選択してください。';
		case 'cloudflare':
			return 'CLOUDFLARE_MAIL_DOMAINSに登録されたドメインです。使用するドメインを選択してください。後から追加もできます。';
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

export function onboardingSubtitle(kind: EmailProviderKind): string {
	switch (kind) {
		case 'resend':
			return 'Resendで送信し、Cloudflare Email Routingで受信するドメインを選択してください。';
		case 'cloudflare':
			return 'このダッシュボードで使うドメインをCLOUDFLARE_MAIL_DOMAINSから選択してください。';
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

export function receivingHint(kind: EmailProviderKind, domainName: string): string {
	switch (kind) {
		case 'resend':
			return `${domainName}ではまだ受信が有効になっていません。Cloudflare Email RoutingのキャッチオールをこのWorkerに向けてください。Resend ReceivingやResendの受信用MXは追加しません。`;
		case 'cloudflare':
			return `${domainName}ではまだ受信が有効になっていません。Email RoutingのキャッチオールをこのWorkerに向けてください。`;
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

/** Keep provider diagnostics out of the UI while preserving useful, known guidance. */
export function safeProviderError(error: unknown): string {
	if (typeof error !== 'string') return 'ドメインを読み込めませんでした。';
	if (error.includes('Could not reach Resend')) {
		return 'Resendに接続できませんでした。APIキーを確認してください。';
	}
	if (error.includes('Could not load Cloudflare Email domains')) {
		return 'Cloudflare Emailのドメインを読み込めませんでした。設定を確認してください。';
	}
	if (error.includes('Database unavailable')) return 'データベースを利用できません。';
	return 'ドメインを読み込めませんでした。';
}
