import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEmailForUser, listThreadMessages, markThreadRead } from '$lib/server/mail-store';
import { resolveReplyFromAddress } from '$lib/server/outbox';
import { displaySubject } from '$lib/server/threads';
import { mailDetailDestinations } from '$lib/folder-ui';

export const load: PageServerLoad = async ({ params, locals, platform, url }) => {
	if (!locals.user || !platform?.env.DB) {
		throw error(401, 'ログインが必要です。');
	}

	const email = await getEmailForUser(platform.env.DB, locals.user.id, params.id);
	if (!email) {
		throw error(404, 'メールが見つかりません。');
	}

	// Opening any message opens its whole conversation.
	await markThreadRead(platform.env.DB, locals.user.id, email);
	const messages = await listThreadMessages(platform.env.DB, locals.user.id, email);

	const latest = messages[messages.length - 1] ?? email;
	const replyIdentity = await resolveReplyFromAddress(platform.env.DB, locals.user, latest);
	const threadId = email.thread_id ?? email.id;
	const assignedFolder = await platform.env.DB.prepare(
		`SELECT f.id
		 FROM mail_thread_folders mtf
		 JOIN mail_folders f ON f.id = mtf.folder_id AND f.user_id = mtf.user_id
		 WHERE mtf.user_id = ? AND mtf.thread_id = ?`
	)
		.bind(locals.user.id, threadId)
		.first<{ id: string }>();
	const requestedFolderId = url.searchParams.get('folder');
	const navigation = mailDetailDestinations({
		trashed: Boolean(email.deleted_at),
		// A conversation with any received message belongs to Inbox when its custom
		// folder assignment is removed. Sent is only the fallback for outbound-only threads.
		direction: messages.some((message) => message.direction === 'inbound') ? 'inbound' : 'outbound',
		requestedFolderId,
		assignedFolderId: assignedFolder?.id ?? null
	});

	return {
		threadId,
		/** The message that was linked to — expanded first when the page opens. */
		focusId: email.id,
		trashed: Boolean(email.deleted_at),
		assignedFolderId: assignedFolder?.id ?? null,
		// A bare detail URL has no trustworthy list origin. If it is assigned,
		// resolve Back deterministically to that folder instead of arbitrary tab history.
		useHistoryBack: !assignedFolder?.id || requestedFolderId === assignedFolder.id,
		...navigation,
		subject: displaySubject(messages[0]?.subject ?? email.subject),
		replyFrom: replyIdentity?.address ?? null,
		replyFromName: replyIdentity?.label?.trim() || null,
		messages: messages.map((message) => ({ ...message, is_read: true }))
	};
};
