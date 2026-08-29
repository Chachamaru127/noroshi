import { json, text, type RequestHandler } from '@sveltejs/kit';
import {
	getInboundEmailProviderKind,
	getResendClient,
	getWebhookSecret
} from '$lib/server/context';
import {
	claimWebhookEvent,
	createResendWebhookInboundEnv,
	handleResendWebhook,
	type ResendWebhookEvent
} from '$lib/server/inbound';
import { verifyWebhookSignature } from '$lib/server/webhook';
import { MAX_WEBHOOK_BYTES, readTextBody, RequestBodyError } from '$lib/server/request-security';

/**
 * Resend webhook receiver — used when EMAIL_PROVIDER=resend.
 *
 * Point a webhook at https://<your-app>/api/webhooks/resend in the Resend
 * dashboard and subscribe to `email.received` plus the delivery events.
 */
export const POST: RequestHandler = async ({ request, platform }) => {
	const db = platform?.env.DB;
	const bucket = platform?.env.ATTACHMENTS;
	if (!db || !bucket) {
		return json({ error: 'Storage unavailable' }, { status: 503 });
	}

	const secret = getWebhookSecret(platform);
	if (!secret) {
		console.error('Rejected webhook: RESEND_WEBHOOK_SECRET is not configured');
		return json({ error: 'Webhook secret not configured' }, { status: 503 });
	}

	// Must be the raw body — parsing first would invalidate the signature.
	let rawBody: string;
	try {
		rawBody = await readTextBody(request, MAX_WEBHOOK_BYTES);
	} catch (error) {
		if (error instanceof RequestBodyError)
			return json({ error: error.message }, { status: error.status });
		throw error;
	}
	const verified = await verifyWebhookSignature(request.headers, rawBody, secret);
	if (!verified.ok) {
		console.warn('Rejected webhook signature:', verified.reason);
		return json({ error: 'Invalid signature' }, { status: 401 });
	}

	let event: ResendWebhookEvent;
	try {
		event = JSON.parse(rawBody) as ResendWebhookEvent;
	} catch {
		return json({ error: 'Invalid JSON payload' }, { status: 400 });
	}

	if (!event?.type) {
		return json({ error: 'Missing event type' }, { status: 400 });
	}

	if (event.type === 'email.received' && getInboundEmailProviderKind(platform) === 'cloudflare') {
		return json({
			ok: true,
			handled: false,
			note: 'Inbound is handled by Cloudflare Email Routing'
		});
	}

	const eventId =
		request.headers.get('svix-id') ?? request.headers.get('webhook-id') ?? crypto.randomUUID();

	// Resend retries; only the first claim of an id does the work.
	const claimed = await claimWebhookEvent(db, eventId, event.type);
	if (!claimed) {
		return text('Duplicate event ignored', { status: 200 });
	}

	try {
		const client = getResendClient(platform);
		const outcome = await handleResendWebhook(
			event,
			createResendWebhookInboundEnv(platform!),
			client
		);
		return json({ ok: true, ...outcome });
	} catch (error) {
		// Release the claim so Resend's retry can succeed.
		await db.prepare('DELETE FROM webhook_events WHERE id = ?').bind(eventId).run();
		console.error('resend_webhook_handling_failed');
		return json({ error: 'Webhook handling failed' }, { status: 500 });
	}
};
