import { json, type RequestHandler } from '@sveltejs/kit';
import { countUsers, login, sessionCookieOptions, SESSION_COOKIE } from '$lib/server/auth';
import { SESSION_DAYS } from '$lib/server/constants';
import {
	ConfigError,
	getEmailProvider,
	safeEmailProviderKind,
	hasProviderConfigured,
	ProviderError
} from '$lib/server/context';
import {
	claimSetupBootstrap,
	consumeAuthRateLimit,
	pruneAuthRateLimits,
	releaseSetupBootstrap,
	renewSetupBootstrap
} from '$lib/server/auth-rate-limit';
import { finalizeSetup } from '$lib/server/setup-finalize';
import { readJsonBody, RequestBodyError } from '$lib/server/request-security';

async function matchesBootstrapSecret(
	expected: string,
	provided: string | undefined
): Promise<boolean> {
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
	countUsers,
	login,
	getEmailProvider,
	finalizeSetup,
	consumeAuthRateLimit,
	pruneAuthRateLimits,
	claimSetupBootstrap,
	releaseSetupBootstrap,
	renewSetupBootstrap
};

export const GET: RequestHandler = async ({ platform }) => {
	const db = platform?.env.DB;
	if (!db) {
		return json({
			ready: false,
			needsSetup: true,
			providerConfigured: false,
			providerKind: 'resend'
		});
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
		const rateLimitSecret = platform?.env.AUTH_RATE_LIMIT_SECRET?.trim();
		if (!rateLimitSecret || rateLimitSecret.length < 32) {
			return json({ error: 'Setup protection is not configured' }, { status: 503 });
		}

		const limit = await dependencies.consumeAuthRateLimit(
			db,
			'setup',
			request,
			'first-admin',
			rateLimitSecret
		);
		platform?.ctx?.waitUntil(dependencies.pruneAuthRateLimits(db));
		if (!limit.allowed) {
			return json(
				{ error: 'Too many setup attempts. Try again later.' },
				{ status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
			);
		}

		// The whole endpoint is only open while the app is uninitialised.
		if ((await dependencies.countUsers(db)) > 0) {
			return json({ error: 'Setup already completed' }, { status: 400 });
		}

		let body: {
			domainId?: string;
			localPart?: string;
			name?: string;
			password?: string;
			bootstrapSecret?: string;
		};
		try {
			body = await readJsonBody(request, 32 * 1024);
		} catch (error) {
			if (error instanceof RequestBodyError) {
				return json({ error: error.message }, { status: error.status });
			}
			throw error;
		}

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
		const bootstrapClaim = await dependencies.claimSetupBootstrap(db);
		if (!bootstrapClaim) {
			return json({ error: 'Setup already completed or in progress' }, { status: 409 });
		}

		try {
			const provider = dependencies.getEmailProvider(platform);
			const domain = await provider.getDomain(body.domainId);
			if (!(await dependencies.renewSetupBootstrap(db, bootstrapClaim))) {
				throw new Error('Setup lease expired');
			}
			const { address } = await dependencies.finalizeSetup(db, bootstrapClaim, {
				domain,
				localPart: body.localPart,
				name: body.name,
				password: body.password
			});
			if (!(await dependencies.renewSetupBootstrap(db, bootstrapClaim))) {
				throw new Error('Setup lease expired');
			}
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
			await dependencies.releaseSetupBootstrap(db, bootstrapClaim);
			const message =
				error instanceof ConfigError || error instanceof ProviderError
					? error.message
					: error instanceof Error
						? error.message
						: 'Setup failed';

			return json({ error: message }, { status: 400 });
		}
	};
}

export const POST = _createSetupPostHandler();
