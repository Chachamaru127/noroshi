import type { AvailableDomain } from '$lib/types';
import {
	parseMailDomains,
	ProviderError,
	toAvailableDomain,
	type EmailProvider,
	type EmailProviderKind
} from './email-provider';
import { ConfigError } from './errors';
import { createCloudflareProvider } from './providers/cloudflare-provider';
import { createResendProvider, getResendReceivingClient } from './providers/resend-provider';
import type { ResendClient } from './resend';

export { ConfigError } from './errors';
export { ProviderError } from './email-provider';

type PlatformLike = App.Platform | undefined | null;

export type InboundEmailProviderKind = 'resend' | 'cloudflare';

export function getInboundEmailProviderKind(platform: PlatformLike): InboundEmailProviderKind {
	const raw = platform?.env.INBOUND_EMAIL_PROVIDER?.trim().toLowerCase();
	if (!raw) return getEmailProviderKind(platform);
	if (raw === 'resend' || raw === 'cloudflare') return raw;
	throw new ConfigError(
		`Unknown INBOUND_EMAIL_PROVIDER "${platform?.env.INBOUND_EMAIL_PROVIDER}". Use "resend" or "cloudflare".`
	);
}

export function getEmailProviderKind(platform: PlatformLike): EmailProviderKind {
	const raw = platform?.env.EMAIL_PROVIDER?.trim().toLowerCase();
	if (!raw || raw === 'resend') return 'resend';
	if (raw === 'cloudflare') return 'cloudflare';
	throw new ConfigError(`Unknown EMAIL_PROVIDER "${platform?.env.EMAIL_PROVIDER}". Use "resend" or "cloudflare".`);
}

export function safeEmailProviderKind(platform: PlatformLike): EmailProviderKind {
	try {
		return getEmailProviderKind(platform);
	} catch {
		return 'resend';
	}
}

export function getEmailProvider(platform: PlatformLike): EmailProvider {
	const kind = getEmailProviderKind(platform);

	switch (kind) {
		case 'resend': {
			const apiKey = platform?.env.RESEND_API_KEY;
			if (!apiKey) {
				throw new ConfigError(
					'RESEND_API_KEY is not set. Add it with the native `wrangler secret put RESEND_API_KEY` prompt.'
				);
			}
			return createResendProvider(
				apiKey,
				getInboundEmailProviderKind(platform) === 'cloudflare'
					? platform?.env.CLOUDFLARE_MAIL_DOMAINS
					: undefined,
				platform?.env.RESEND_SEND_DOMAINS
			);
		}
		case 'cloudflare': {
			const email = platform?.env.EMAIL;
			if (!email) {
				throw new ConfigError(
					'Cloudflare Email binding EMAIL is missing. Add a send_email binding named EMAIL in wrangler.jsonc.'
				);
			}
			return createCloudflareProvider(email, platform?.env.CLOUDFLARE_MAIL_DOMAINS ?? '');
		}
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

/** Local first-admin setup may use the configured inbound domain without a send credential. */
export function getSetupEmailProvider(platform: PlatformLike, isDev: boolean): EmailProvider {
	if (
		isDev &&
		getEmailProviderKind(platform) === 'resend' &&
		getInboundEmailProviderKind(platform) === 'cloudflare' &&
		!platform?.env.RESEND_API_KEY
	) {
		const domains = parseMailDomains(platform?.env.CLOUDFLARE_MAIL_DOMAINS).map((name) => ({
			id: name,
			name,
			status: 'inbound_configured',
			region: null,
			sendingEnabled: false,
			receivingEnabled: true
		}));
		return {
			kind: 'resend',
			async listDomains() {
				return domains;
			},
			async getDomain(id) {
				const domain = domains.find((candidate) => candidate.id === id);
				if (!domain) throw new ProviderError(404, 'domain_not_configured', `${id} is not configured`);
				return domain;
			},
			async send() {
				throw new ProviderError(503, 'send_not_configured', 'Resend sending is not configured');
			}
		};
	}
	return getEmailProvider(platform);
}

export async function listSetupAvailableDomains(
	platform: PlatformLike,
	isDev: boolean
): Promise<AvailableDomain[]> {
	return (await getSetupEmailProvider(platform, isDev).listDomains()).map((domain) =>
		toAvailableDomain(domain, false)
	);
}

export function hasSetupProviderConfigured(platform: PlatformLike, isDev: boolean): boolean {
	if (isDev && parseMailDomains(platform?.env.CLOUDFLARE_MAIL_DOMAINS).length > 0) return true;
	return hasProviderConfigured(platform);
}

export function hasProviderConfigured(platform: PlatformLike): boolean {
	try {
		const kind = getEmailProviderKind(platform);
		const inboundKind = getInboundEmailProviderKind(platform);
		switch (kind) {
			case 'resend':
				return (
					Boolean(platform?.env.RESEND_API_KEY) &&
					(inboundKind !== 'cloudflare' ||
						parseMailDomains(platform?.env.CLOUDFLARE_MAIL_DOMAINS).length > 0)
				);
			case 'cloudflare':
				return Boolean(platform?.env.EMAIL) && parseMailDomains(platform?.env.CLOUDFLARE_MAIL_DOMAINS).length > 0;
			default: {
				const _never: never = kind;
				return _never;
			}
		}
	} catch {
		return false;
	}
}

export async function listAvailableDomains(
	platform: PlatformLike,
	connectedIds: Iterable<string> = []
): Promise<AvailableDomain[]> {
	const connected = new Set(connectedIds);
	const remote = await getEmailProvider(platform).listDomains();
	return remote.map((domain) => toAvailableDomain(domain, connected.has(domain.id)));
}

/** Resend receiving API — used only by the Resend webhook handler. */
export function getResendClient(platform: PlatformLike): ResendClient {
	const apiKey = platform?.env.RESEND_API_KEY;
	if (!apiKey) {
		throw new ConfigError(
			'RESEND_API_KEY is not set. Add it with the native `wrangler secret put RESEND_API_KEY` prompt.'
		);
	}
	return getResendReceivingClient(apiKey);
}

export function getWebhookSecret(platform: PlatformLike): string | null {
	return platform?.env.RESEND_WEBHOOK_SECRET ?? null;
}

export function providerLoadError(kind: EmailProviderKind, error: unknown): string {
	if (error instanceof ConfigError || error instanceof ProviderError) return error.message;
	switch (kind) {
		case 'resend':
			return 'Could not reach Resend. Check the API key and try again.';
		case 'cloudflare':
			return 'Could not load Cloudflare Email domains. Check EMAIL_PROVIDER and CLOUDFLARE_MAIL_DOMAINS.';
		default: {
			const _never: never = kind;
			return _never;
		}
	}
}

export function describeProviderError(error: unknown, fallback = 'Failed to send email'): string {
	if (error instanceof ConfigError || error instanceof ProviderError) return error.message;
	return error instanceof Error ? error.message : fallback;
}

export function statusForProviderError(error: unknown): number {
	if (error instanceof ConfigError) return 503;
	if (error instanceof ProviderError) return error.status >= 500 ? 502 : 400;
	return 400;
}
