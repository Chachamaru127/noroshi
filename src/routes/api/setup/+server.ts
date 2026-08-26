import { json, type RequestHandler } from '@sveltejs/kit';
import {
	bootstrapAdmin,
	countUsers,
	login,
	sessionCookieOptions,
	SESSION_COOKIE
} from '$lib/server/auth';
import { SESSION_DAYS } from '$lib/server/constants';
import {
	ConfigError,
	getEmailProvider,
	safeEmailProviderKind,
	hasProviderConfigured,
	ProviderError
} from '$lib/server/context';
import { createAddress, setCatchallUser, upsertDomain } from '$lib/server/domains';

async function matchesBootstrapSecret(expected: string, provided: string | undefined): Promise<boolean> {
	if (!provided) return false;
	const encoder = new TextEncoder();
	const [expectedHash, providedHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(expected)),
		crypto.subtle.digest('SHA-256', encoder.encode(provided))
	]);
	const expectedBytes = new Uint8Array(expectedHash);
	const providedBytes = new Uint8Array(providedHash);
	let difference = 0;
	for (let index = 0; index < expectedBytes.length; index += 1) {
		difference |= expectedBytes[index] ^ providedBytes[index];
	}
	return difference === 0;
}

const defaultSetupDependencies = {
	bootstrapAdmin,
	countUsers,
	login,
	getEmailProvider,
	createAddress,
	setCatchallUser,
	upsertDomain
};

export const GET: RequestHandler = async ({ platform }) => {
	const db = platform?.env.DB;
	if (!db) {
		return json({ ready: false, needsSetup: true, providerConfigured: false, providerKind: 'resend' });
	}

	const users = await countUsers(db);
	return json({
		ready: true,
		needsSetup: users === 0,
		providerConfigured: hasProviderConfigured(platform),
		providerKind: safeEmailProviderKind(platform)
	});
};

/**
 * First-run bootstrap, done in one shot: connect the chosen provider domain,
 * create the admin, claim their address, make them the catch-all, sign them in.
 */
export function _createSetupPostHandler(
	overrides: Partial<typeof defaultSetupDependencies> = {}
): RequestHandler {
	const dependencies = { ...defaultSetupDependencies, ...overrides };
	return async ({ request, cookies, platform }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	// The whole endpoint is only open while the app is uninitialised.
	if ((await dependencies.countUsers(db)) > 0) {
		return json({ error: 'Setup already completed' }, { status: 400 });
	}

	const body = (await request.json()) as {
		domainId?: string;
		localPart?: string;
		name?: string;
		password?: string;
		bootstrapSecret?: string;
	};

	const bootstrapSecret = platform?.env.BOOTSTRAP_SECRET?.trim();
	if (!bootstrapSecret) {
		return json({ error: 'Setup protection is not configured' }, { status: 503 });
	}
	if (!(await matchesBootstrapSecret(bootstrapSecret, body.bootstrapSecret))) {
		return json({ error: 'Invalid setup key' }, { status: 403 });
	}

	if (!body.domainId) {
		return json({ error: 'Choose a domain first' }, { status: 400 });
	}
	if (!body.name?.trim()) {
		return json({ error: 'Your name is required' }, { status: 400 });
	}
	if (!body.localPart?.trim()) {
		return json({ error: 'Choose an address' }, { status: 400 });
	}
	if (!body.password || body.password.length < 8) {
		return json({ error: 'Password must be at least 8 characters' }, { status: 400 });
	}

	try {
		const provider = dependencies.getEmailProvider(platform);
		const domain = await dependencies.upsertDomain(db, await provider.getDomain(body.domainId));

		const localPart = body.localPart.trim().toLowerCase().replace(/@.*$/, '');
		const address = `${localPart}@${domain.name}`;

		// The mail address doubles as the login — one identity, not two.
		const user = await dependencies.bootstrapAdmin(db, {
			email: address,
			name: body.name,
			password: body.password
		});

		await dependencies.createAddress(db, { userId: user.id, domainId: domain.id, localPart });

		// The provider accepts mail for every mailbox on the domain; without a
		// catch-all anything sent to an unknown address would just pile up unrouted.
		await dependencies.setCatchallUser(db, domain.id, user.id);

		const session = await dependencies.login(db, address, body.password);
		if (session) {
			cookies.set(
				SESSION_COOKIE,
				session.token,
				sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60)
			);
		}

		return json({ ok: true, email: address, signedIn: Boolean(session) });
	} catch (error) {
		const message =
			error instanceof ConfigError || error instanceof ProviderError
				? error.message
				: error instanceof Error
					? error.message
					: 'Setup failed';

		return json({ error: message }, { status: 400 });
	}
	};
};

export const POST = _createSetupPostHandler();
