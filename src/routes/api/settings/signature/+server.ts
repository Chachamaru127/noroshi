import { json, type RequestHandler } from '@sveltejs/kit';
import {
	MAX_SMALL_JSON_BYTES,
	readEndpointJsonBody,
	withRequestBodyErrors
} from '$lib/server/request-security';
import { MAX_EMAIL_SIGNATURE_LENGTH } from '$lib/email-signature';
import { updateEmailSignature } from '$lib/server/email-signature';

const patch: RequestHandler = async ({ request, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await readEndpointJsonBody(request, MAX_SMALL_JSON_BYTES)) as {
		signature?: unknown;
	};

	if (typeof body.signature !== 'string') {
		return json({ error: 'Signature must be text' }, { status: 400 });
	}
	if (body.signature.length > MAX_EMAIL_SIGNATURE_LENGTH) {
		return json(
			{ error: `Signature must be ${MAX_EMAIL_SIGNATURE_LENGTH} characters or fewer` },
			{ status: 400 }
		);
	}

	const signature = await updateEmailSignature(db, locals.user.id, body.signature);
	return json({ ok: true, signature });
};

export const PATCH = withRequestBodyErrors(patch);
