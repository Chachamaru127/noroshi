import { json, type RequestHandler } from '@sveltejs/kit';
import { MAX_SMALL_JSON_BYTES, readJsonBody } from '$lib/server/request-security';
import { getEmailProvider, ProviderError } from '$lib/server/context';
import {
	disconnectDomain,
	findMatchingProviderDomain,
	getDomain,
	setCatchallUser,
	upsertDomain
} from '$lib/server/domains';

/** PATCH — set the catch-all owner or re-sync status from the active provider. */
export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user?.is_admin) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const domain = await getDomain(db, params.id!);
	if (!domain) {
		return json({ error: 'Domain not connected' }, { status: 404 });
	}

	const body = (await readJsonBody(request, MAX_SMALL_JSON_BYTES)) as {
		catchallUserId?: string | null;
		refresh?: boolean;
	};

	if (body.refresh) {
		try {
			const provider = getEmailProvider(platform);
			const remote = findMatchingProviderDomain(domain, await provider.listDomains());
			if (!remote) {
				throw new ProviderError(404, 'domain_not_configured', 'Domain is not configured');
			}
			return json({ domain: await upsertDomain(db, remote) });
		} catch (error) {
			return json(
				{ error: error instanceof ProviderError ? error.message : 'Failed to refresh domain' },
				{ status: 502 }
			);
		}
	}

	if (body.catchallUserId !== undefined) {
		await setCatchallUser(db, domain.id, body.catchallUserId || null);
	}

	return json({ domain: await getDomain(db, domain.id) });
};

/** DELETE — stop using the domain here. The domain stays with the provider. */
export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user?.is_admin) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	await disconnectDomain(db, params.id!);
	return json({ ok: true });
};
