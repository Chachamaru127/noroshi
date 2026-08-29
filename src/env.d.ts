import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { CloudflareSendEmailBinding } from '$lib/server/providers/cloudflare-provider';

declare global {
	interface Env {
		DB: D1Database;
		ATTACHMENTS: R2Bucket;
		ASSETS: Fetcher;
		EMAIL: CloudflareSendEmailBinding;
		EMAIL_PROVIDER?: string;
		INBOUND_EMAIL_PROVIDER?: string;
		CLOUDFLARE_MAIL_DOMAINS?: string;
		RESEND_SEND_DOMAINS?: string;
		BOOTSTRAP_SECRET?: string;
		AUTH_RATE_LIMIT_SECRET?: string;
		RESEND_API_KEY: string;
		RESEND_WEBHOOK_SECRET: string;
		FORWARDING_KILL_SWITCH?: string;
		FORWARDING_LEASE_MS?: string;
		VAPID_PUBLIC_KEY?: string;
		VAPID_PRIVATE_KEY?: string;
		VAPID_SUBJECT?: string;
	}
}

export {};
