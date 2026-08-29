import { json, type RequestHandler } from '@sveltejs/kit';
import { MAX_SMALL_JSON_BYTES, readJsonBody } from '$lib/server/request-security';
import { MailSortRuleValidationError, reorderSortRules } from '$lib/server/folder-rules';

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!platform?.env.DB || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (locals.authMethod !== 'session') {
		return json({ error: 'Sorting rules require a browser session.' }, { status: 403 });
	}
	const body = (await readJsonBody(request, MAX_SMALL_JSON_BYTES).catch(() => null)) as {
		ids?: unknown;
	} | null;
	if (!body || !Array.isArray(body.ids) || !body.ids.every((id) => typeof id === 'string')) {
		return json({ error: 'Sorting rule order is invalid.' }, { status: 400 });
	}
	try {
		return json({ rules: await reorderSortRules(platform.env.DB, locals.user.id, body.ids) });
	} catch (error) {
		if (error instanceof MailSortRuleValidationError) {
			return json({ error: error.message }, { status: 400 });
		}
		throw error;
	}
};
