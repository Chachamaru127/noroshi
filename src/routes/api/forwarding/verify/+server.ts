import { json, type RequestHandler } from '@sveltejs/kit';
import { ForwardingVerificationError, verifyForwardingDestination } from '$lib/server/forwarding';

export const GET: RequestHandler = async ({ platform, url }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	const token = url.searchParams.get('token');
	if (!token) return json({ error: 'Verification token is required' }, { status: 400 });

	try {
		const result = await verifyForwardingDestination(db, token);
		return json({ ok: true, destination: result.destination, rule: result.rule });
	} catch (error) {
		if (error instanceof ForwardingVerificationError) {
			return json({ error: error.message }, { status: error.code === 'invalid' ? 400 : 410 });
		}
		return json({ error: 'Could not verify forwarding destination' }, { status: 400 });
	}
};
