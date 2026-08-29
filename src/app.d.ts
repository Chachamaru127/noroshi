import type { D1Database, ExecutionContext, R2Bucket } from '@cloudflare/workers-types';
import type { ApiScope, AuthMethod } from '$lib/server/api-access';
import type { CloudflareSendEmailBinding } from '$lib/server/providers/cloudflare-provider';
import type { Domain, MailAddress, User } from '$lib/types';

declare global {
	namespace App {
		interface Platform {
			ctx: ExecutionContext;
			env: {
				DB: D1Database;
				ATTACHMENTS: R2Bucket;
				ASSETS: Fetcher;
				EMAIL: CloudflareSendEmailBinding;
				/** `resend` (default) or `cloudflare`. */
				EMAIL_PROVIDER?: string;
				/** Set to `cloudflare` to receive through Email Routing while sending with Resend. */
				INBOUND_EMAIL_PROVIDER?: string;
				/** Comma-separated domains received through Cloudflare Email Routing. */
				CLOUDFLARE_MAIL_DOMAINS?: string;
				/** One-time secret required to create the first administrator. */
				BOOTSTRAP_SECRET?: string;
				AUTH_RATE_LIMIT_SECRET?: string;
				/** Resend API key — `wrangler secret put RESEND_API_KEY`. */
				RESEND_API_KEY: string;
				/** Signing secret from the Resend webhook (whsec_…). */
				RESEND_WEBHOOK_SECRET: string;
				FORWARDING_KILL_SWITCH?: string;
				FORWARDING_LEASE_MS?: string;
				/** Web Push application server public key. */
				VAPID_PUBLIC_KEY?: string;
				/** Web Push application server private key. */
				VAPID_PRIVATE_KEY?: string;
				/** A mailto: or https: contact URI for Web Push. */
				VAPID_SUBJECT?: string;
			};
		}
		interface Locals {
			user: User | null;
			/** How this request authenticated — sessions are unrestricted. */
			authMethod: AuthMethod | null;
			/** Scopes on the bearer token; empty for a browser session. */
			apiScopes: ApiScope[];
			apiTokenId: string | null;
			/** Connected domains, loaded once per request for the switcher. */
			domains: Domain[];
			/** The signed-in user's sending identities. */
			addresses: MailAddress[];
			/** Active domain filter, or null for the combined inbox. */
			activeDomainId: string | null;
		}
	}
}

export {};
