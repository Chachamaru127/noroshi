import { json, type RequestHandler } from '@sveltejs/kit';
import { listForwardingForUser } from '$lib/server/forwarding';

function serializeOverview(item: Awaited<ReturnType<typeof listForwardingForUser>>[number]) {
	return {
		source_address: item.source_address,
		destination: item.destination,
		rule: item.rule,
		latest_attempt: item.latest_attempt
	};
}

export const GET: RequestHandler = async ({ locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const forwarding = await listForwardingForUser(db, locals.user.id);
	return json({ forwarding: forwarding.map(serializeOverview) });
};
