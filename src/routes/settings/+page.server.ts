import type { PageServerLoad } from './$types';
import { listApiTokens } from '$lib/server/api-tokens';
import { getEmailSignature } from '$lib/server/email-signature';
import { listForwardingForUser } from '$lib/server/forwarding';
import { listSortRules } from '$lib/server/folder-rules';
import { readVapidConfiguration } from '$lib/server/push-notifications';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const db = platform?.env.DB;
	const signature = locals.user && db ? await getEmailSignature(db, locals.user.id) : '';
	const apiTokens = locals.user && db ? await listApiTokens(db, locals.user.id) : [];
	const forwarding = locals.user && db ? await listForwardingForUser(db, locals.user.id) : [];
	const sortRules = locals.user && db ? await listSortRules(db, locals.user.id) : [];
	const vapid = platform?.env ? readVapidConfiguration(platform.env) : null;

	return {
		domains: locals.domains,
		addresses: locals.addresses,
		forwarding,
		sortRules,
		signature,
		apiTokens,
		push: {
			configured: Boolean(vapid),
			publicKey: vapid?.publicKey ?? null
		},
		isAdmin: locals.user?.is_admin ?? false
	};
};
