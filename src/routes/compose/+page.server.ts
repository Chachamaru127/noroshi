import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listAttachments } from '$lib/server/attachments';
import { buildManualForwardDraft } from '$lib/server/manual-forward';
import { getDraft, getEmailForUser } from '$lib/server/mail-store';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const draftId = url.searchParams.get('draft');
	const forwardId = url.searchParams.get('forward');
	const db = platform?.env.DB;
	if (draftId && forwardId) {
		throw error(400, '下書きまたは転送するメールのどちらか一方を指定してください。');
	}

	const draft =
		draftId && db && locals.user ? await getDraft(db, locals.user.id, draftId) : null;
	let forward = null;
	if (forwardId) {
		if (!db || !locals.user) {
			throw error(401, 'ログインが必要です。');
		}
		const email = await getEmailForUser(db, locals.user.id, forwardId);
		if (!email) {
			throw error(404, 'メールが見つかりません。');
		}
		forward = buildManualForwardDraft(email, await listAttachments(db, email.id));
	}

	return { addresses: locals.addresses, draft, forward };
};
