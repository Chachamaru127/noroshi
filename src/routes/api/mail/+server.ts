import { json, type RequestHandler } from '@sveltejs/kit';
import {
	describeProviderError,
	getEmailProvider,
	statusForProviderError
} from '$lib/server/context';
import { authorizeManualForward } from '$lib/server/api-access';
import { ManualForwardError, prepareManualForward } from '$lib/server/manual-forward';
import { deleteDraft, listMailbox } from '$lib/server/mail-store';
import { sendAndStore } from '$lib/server/outbox';
import type { MailboxView, OutboundAttachmentInput } from '$lib/types';
import { RequestBodyError } from '$lib/server/request-security';
import { readMailRequest } from '$lib/server/mail-request';

type SendMailBody = {
	/** Set when the composer was editing a draft — it is removed once sent. */
	draftId?: string;
	fromAddressId?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	text?: string;
	html?: string;
	attachments?: OutboundAttachmentInput[];
	forwardOfId?: string;
	forwardAttachmentIds?: string[];
};

function mailboxView(url: URL): MailboxView {
	const view = url.searchParams.get('view');
	switch (view) {
		case 'inbox':
		case 'starred':
		case 'drafts':
		case 'sent':
		case 'trash':
			return view;
		default:
			break;
	}

	// PR #9 documented `?direction=` on the flat list; keep that working.
	const direction = url.searchParams.get('direction');
	switch (direction) {
		case 'outbound':
			return 'sent';
		case 'inbound':
			return 'inbox';
		default:
			return 'inbox';
	}
}

export const GET: RequestHandler = async ({ locals, platform, url }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const mailbox = await listMailbox(db, locals.user.id, {
		view: mailboxView(url),
		domainId: locals.activeDomainId,
		q: url.searchParams.get('q'),
		unreadOnly: url.searchParams.get('unread') === '1',
		starredOnly: url.searchParams.get('starred') === '1',
		attachmentsOnly: url.searchParams.get('attachments') === '1',
		page: Number(url.searchParams.get('page')) || 1
	});

	return json(mailbox);
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const db = platform?.env.DB;
	const bucket = platform?.env.ATTACHMENTS;
	if (!db || !bucket || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let body: SendMailBody;
	try {
		body = await readMailRequest<SendMailBody>(request);
	} catch (error) {
		if (error instanceof RequestBodyError)
			return json({ error: error.message }, { status: error.status });
		throw error;
	}
	if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
		return json({ error: 'Invalid attachments' }, { status: 400 });
	}

	if (!body.to?.trim() || !body.subject?.trim() || (!body.text?.trim() && !body.html?.trim())) {
		return json({ error: 'To, subject, and message are required' }, { status: 400 });
	}

	const forwarding = body.forwardOfId !== undefined || body.forwardAttachmentIds !== undefined;
	let attachments = body.attachments ?? [];
	if (forwarding) {
		if (
			typeof body.forwardOfId !== 'string' ||
			!body.forwardOfId.trim() ||
			(body.forwardAttachmentIds !== undefined &&
				(!Array.isArray(body.forwardAttachmentIds) ||
					!body.forwardAttachmentIds.every((id) => typeof id === 'string')))
		) {
			return json({ error: 'Invalid forward request' }, { status: 400 });
		}

		if (!locals.authMethod) {
			return json({ error: 'Unauthorized' }, { status: 401 });
		}
		const access = authorizeManualForward({
			authMethod: locals.authMethod,
			scopes: locals.apiScopes
		});
		if (!access.ok) {
			return json({ error: access.error }, { status: access.status });
		}

		try {
			attachments = (
				await prepareManualForward(
					db,
					bucket,
					locals.user.id,
					body.forwardOfId,
					body.forwardAttachmentIds ?? [],
					attachments
				)
			).attachments;
		} catch (error) {
			if (error instanceof ManualForwardError) {
				return json({ error: error.message }, { status: error.status });
			}
			throw error;
		}
	}

	try {
		const provider = getEmailProvider(platform);
		const { emailId } = await sendAndStore({ DB: db, ATTACHMENTS: bucket }, provider, locals.user, {
			fromAddressId: body.fromAddressId,
			to: body.to,
			cc: body.cc,
			bcc: body.bcc,
			subject: body.subject,
			text: body.text,
			html: body.html,
			attachments,
			startNewThread: forwarding
		});

		if (body.draftId) {
			await deleteDraft(db, locals.user.id, body.draftId);
		}

		return json({ ok: true, id: emailId });
	} catch (error) {
		return json({ error: describeProviderError(error) }, { status: statusForProviderError(error) });
	}
};
