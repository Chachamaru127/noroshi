import { json, type RequestHandler } from '@sveltejs/kit';
import { MAX_SMALL_JSON_BYTES, readJsonBody } from '$lib/server/request-security';
import { createFolder, listFolders, MailFolderValidationError } from '$lib/server/folders';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.authMethod !== 'session') {
		return json({ error: 'Folders require a browser session.' }, { status: 403 });
	}
	return json({ folders: await listFolders(db, locals.user.id, locals.activeDomainId) });
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.authMethod !== 'session') {
		return json({ error: 'Folders require a browser session.' }, { status: 403 });
	}
	const body = (await readJsonBody(request, MAX_SMALL_JSON_BYTES).catch(() => null)) as {
		name?: unknown;
	} | null;
	if (!body || typeof body.name !== 'string') {
		return json({ error: 'Folder name is required.' }, { status: 400 });
	}
	try {
		return json({ folder: await createFolder(db, locals.user.id, body.name) }, { status: 201 });
	} catch (error) {
		if (error instanceof MailFolderValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		throw error;
	}
};
