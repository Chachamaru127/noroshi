import { json, type RequestHandler } from '@sveltejs/kit';
import {
	deleteSortRule,
	MailSortRuleNotFoundError,
	MailSortRuleValidationError,
	updateSortRule
} from '$lib/server/folder-rules';

function denied(locals: App.Locals, hasDatabase: boolean): Response | null {
	if (!hasDatabase || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.authMethod !== 'session') {
		return json({ error: 'Sorting rules require a browser session.' }, { status: 403 });
	}
	return null;
}

function invalidCondition(value: unknown): boolean {
	return value !== undefined && value !== null && typeof value !== 'string';
}

export const PATCH: RequestHandler = async ({ request, locals, platform, params }) => {
	const accessError = denied(locals, Boolean(platform?.env.DB));
	if (accessError) return accessError;
	if (!params.id) return json({ error: 'Sorting rule was not found.' }, { status: 404 });
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (
		!body ||
		(body.folderId !== undefined && typeof body.folderId !== 'string') ||
		invalidCondition(body.senderContains) ||
		invalidCondition(body.subjectContains) ||
		(body.enabled !== undefined && typeof body.enabled !== 'boolean')
	) {
		return json({ error: 'Sorting rule is invalid.' }, { status: 400 });
	}
	try {
		return json({
			rule: await updateSortRule(platform!.env.DB, locals.user!.id, params.id, {
				folderId: body.folderId as string | undefined,
				senderContains: body.senderContains as string | null | undefined,
				subjectContains: body.subjectContains as string | null | undefined,
				enabled: body.enabled as boolean | undefined
			})
		});
	} catch (error) {
		if (error instanceof MailSortRuleValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		if (error instanceof MailSortRuleNotFoundError) {
			return json({ error: error.message }, { status: 404 });
		}
		throw error;
	}
};

export const DELETE: RequestHandler = async ({ locals, platform, params }) => {
	const accessError = denied(locals, Boolean(platform?.env.DB));
	if (accessError) return accessError;
	if (!params.id) return json({ error: 'Sorting rule was not found.' }, { status: 404 });
	try {
		await deleteSortRule(platform!.env.DB, locals.user!.id, params.id);
		return json({ ok: true });
	} catch (error) {
		if (error instanceof MailSortRuleValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		if (error instanceof MailSortRuleNotFoundError) {
			return json({ error: error.message }, { status: 404 });
		}
		throw error;
	}
};
