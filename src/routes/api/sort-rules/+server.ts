import { json, type RequestHandler } from '@sveltejs/kit';
import { MAX_SMALL_JSON_BYTES, readJsonBody } from '$lib/server/request-security';
import {
	createSortRule,
	listSortRules,
	MailSortRuleNotFoundError,
	MailSortRuleValidationError
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

export const GET: RequestHandler = async ({ locals, platform }) => {
	const accessError = denied(locals, Boolean(platform?.env.DB));
	if (accessError) return accessError;
	return json({ rules: await listSortRules(platform!.env.DB, locals.user!.id) });
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const accessError = denied(locals, Boolean(platform?.env.DB));
	if (accessError) return accessError;
	const body = (await readJsonBody(request, MAX_SMALL_JSON_BYTES).catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (
		!body ||
		typeof body.folderId !== 'string' ||
		invalidCondition(body.senderContains) ||
		invalidCondition(body.subjectContains) ||
		(body.enabled !== undefined && typeof body.enabled !== 'boolean')
	) {
		return json({ error: 'Sorting rule is invalid.' }, { status: 400 });
	}
	try {
		return json(
			{
				rule: await createSortRule(platform!.env.DB, locals.user!.id, {
					folderId: body.folderId,
					senderContains: body.senderContains as string | null | undefined,
					subjectContains: body.subjectContains as string | null | undefined,
					enabled: body.enabled as boolean | undefined
				})
			},
			{ status: 201 }
		);
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
