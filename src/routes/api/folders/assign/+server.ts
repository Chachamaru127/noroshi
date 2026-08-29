import { json, type RequestHandler } from '@sveltejs/kit';
import { MAX_SMALL_JSON_BYTES, readJsonBody } from '$lib/server/request-security';
import {
	assignThreadsToFolder,
	listFolders,
	MailFolderNotFoundError,
	MailFolderValidationError
} from '$lib/server/folders';
import { getMailboxCounts } from '$lib/server/mail-store';

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.authMethod !== 'session') {
		return json({ error: 'Folders require a browser session.' }, { status: 403 });
	}
	const body = (await readJsonBody(request, MAX_SMALL_JSON_BYTES).catch(() => null)) as {
		ids?: unknown;
		folderId?: unknown;
	} | null;
	if (!body || !Array.isArray(body.ids) || !body.ids.every((id) => typeof id === 'string')) {
		return json({ error: 'Select at least one message.' }, { status: 400 });
	}
	if (body.folderId !== null && typeof body.folderId !== 'string') {
		return json({ error: 'Folder is required.' }, { status: 400 });
	}
	try {
		const affected = await assignThreadsToFolder(db, locals.user.id, body.ids, body.folderId);
		const [counts, folders] = await Promise.all([
			getMailboxCounts(db, locals.user.id, locals.activeDomainId),
			listFolders(db, locals.user.id, locals.activeDomainId)
		]);
		return json({ ok: true, affected, counts, folders });
	} catch (error) {
		if (error instanceof MailFolderValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		if (error instanceof MailFolderNotFoundError) {
			return json({ error: error.message }, { status: 404 });
		}
		throw error;
	}
};
