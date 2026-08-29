import { json, type RequestHandler } from '@sveltejs/kit';
import { MAX_SMALL_JSON_BYTES, readJsonBody } from '$lib/server/request-security';
import {
	deleteFolder,
	getFolderDeletionImpact,
	MailFolderNotFoundError,
	MailFolderValidationError,
	renameFolder
} from '$lib/server/folders';

function accessError(locals: App.Locals, hasDatabase: boolean): Response | null {
	if (!hasDatabase || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.authMethod !== 'session') {
		return json({ error: 'Folders require a browser session.' }, { status: 403 });
	}
	return null;
}

export const GET: RequestHandler = async ({ locals, platform, params }) => {
	const denied = accessError(locals, Boolean(platform?.env.DB));
	if (denied) return denied;
	if (!params.id) return json({ error: 'Folder was not found.' }, { status: 404 });
	try {
		return json({
			impact: await getFolderDeletionImpact(platform!.env.DB, locals.user!.id, params.id)
		});
	} catch (error) {
		if (error instanceof MailFolderNotFoundError) {
			return json({ error: error.message }, { status: 404 });
		}
		throw error;
	}
};

export const PATCH: RequestHandler = async ({ request, locals, platform, params }) => {
	const denied = accessError(locals, Boolean(platform?.env.DB));
	if (denied) return denied;
	if (!params.id) return json({ error: 'Folder was not found.' }, { status: 404 });
	const body = (await readJsonBody(request, MAX_SMALL_JSON_BYTES).catch(() => null)) as {
		name?: unknown;
	} | null;
	if (!body || typeof body.name !== 'string') {
		return json({ error: 'Folder name is required.' }, { status: 400 });
	}
	try {
		return json({
			folder: await renameFolder(
				platform!.env.DB,
				locals.user!.id,
				params.id,
				body.name,
				locals.activeDomainId
			)
		});
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

export const DELETE: RequestHandler = async ({ locals, platform, params }) => {
	const denied = accessError(locals, Boolean(platform?.env.DB));
	if (denied) return denied;
	if (!params.id) return json({ error: 'Folder was not found.' }, { status: 404 });
	try {
		return json({
			ok: true,
			impact: await deleteFolder(platform!.env.DB, locals.user!.id, params.id)
		});
	} catch (error) {
		if (error instanceof MailFolderNotFoundError) {
			return json({ error: error.message }, { status: 404 });
		}
		throw error;
	}
};
