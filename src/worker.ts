import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import {
	handleCloudflareInbound,
	isAllowedCloudflareRecipient,
	type CloudflareInboundEnv,
	type CloudflareInboundMessage
} from './lib/server/cloudflare-inbound';
import { runScheduledForwarding } from './lib/server/forwarding-delivery';
import { drainAttachmentCleanupOutbox } from './lib/server/mail-store';
import sveltekit from './sveltekit-worker.js';

type SvelteKitWorker = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response;
};

const svelteApp = sveltekit as SvelteKitWorker;

/**
 * SvelteKit's generated Worker is fetch-only. This wrapper keeps HTTP on
 * SvelteKit and adds Cloudflare Email Service's `email()` handler.
 */
export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		if (typeof svelteApp.fetch !== 'function') {
			throw new Error('SvelteKit worker export is missing fetch');
		}
		return svelteApp.fetch(request, env, ctx);
	},

	async email(message: CloudflareInboundMessage, env: Env, ctx: ExecutionContext) {
		const inboundProvider = env.INBOUND_EMAIL_PROVIDER?.trim().toLowerCase();
		const outboundProvider = env.EMAIL_PROVIDER?.trim().toLowerCase();
		if (inboundProvider !== 'cloudflare' && outboundProvider !== 'cloudflare') {
			message.setReject('Cloudflare email provider is not enabled');
			return;
		}
		if (!isAllowedCloudflareRecipient(message.to, env.CLOUDFLARE_MAIL_DOMAINS)) {
			message.setReject('Recipient domain is not configured');
			return;
		}

		const inboundEnv: CloudflareInboundEnv = {
			DB: env.DB,
			ATTACHMENTS: env.ATTACHMENTS,
			EMAIL_PROVIDER: env.EMAIL_PROVIDER,
			RESEND_API_KEY: env.RESEND_API_KEY,
			FORWARDING_KILL_SWITCH: env.FORWARDING_KILL_SWITCH,
			FORWARDING_LEASE_MS: env.FORWARDING_LEASE_MS,
			VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
			VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
			VAPID_SUBJECT: env.VAPID_SUBJECT,
			waitUntil: (promise) => ctx.waitUntil(promise)
		};

		await handleCloudflareInbound(message, inboundEnv);
	},

	scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			Promise.all([
				runScheduledForwarding(
					{
						DB: env.DB,
						ATTACHMENTS: env.ATTACHMENTS,
						EMAIL_PROVIDER: env.EMAIL_PROVIDER,
						RESEND_API_KEY: env.RESEND_API_KEY,
						FORWARDING_KILL_SWITCH: env.FORWARDING_KILL_SWITCH,
						FORWARDING_LEASE_MS: env.FORWARDING_LEASE_MS
					},
					new Date(controller.scheduledTime)
				),
				drainAttachmentCleanupOutbox(env.DB, env.ATTACHMENTS)
			]).then(() => undefined)
		);
	}
};
