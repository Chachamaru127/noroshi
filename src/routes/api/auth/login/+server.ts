import { json, type RequestHandler } from '@sveltejs/kit';
import {
	login,
	logout,
	readSessionToken,
	sessionCookieOptions,
	SESSION_COOKIE
} from '$lib/server/auth';
import { SESSION_DAYS } from '$lib/server/constants';
import {
	consumeAuthRateLimit,
	pruneAuthRateLimits,
	resetAuthRateLimit
} from '$lib/server/auth-rate-limit';
import { readJsonBody, RequestBodyError } from '$lib/server/request-security';
import { resolveAuthRateLimitSecret } from '$lib/server/bootstrap-secret';

const defaultDependencies = {
	login,
	consumeAuthRateLimit,
	resetAuthRateLimit,
	pruneAuthRateLimits,
	resolveAuthRateLimitSecret
};

export function _createLoginPostHandler(
	overrides: Partial<typeof defaultDependencies> = {}
): RequestHandler {
	const dependencies = { ...defaultDependencies, ...overrides };
	return async ({ request, cookies, platform }) => {
		const db = platform?.env.DB;
		if (!db) return json({ error: 'Database unavailable' }, { status: 503 });
		const rateLimitSecret = dependencies.resolveAuthRateLimitSecret(platform);
		if (!rateLimitSecret || rateLimitSecret.length < 32) {
			return json({ error: 'Login protection is not configured' }, { status: 503 });
		}

		let body: { email?: string; password?: string };
		try {
			body = await readJsonBody(request, 16 * 1024);
		} catch (error) {
			if (error instanceof RequestBodyError)
				return json({ error: error.message }, { status: error.status });
			throw error;
		}
		if (!body.email || !body.password) {
			return json({ error: 'Email and password are required' }, { status: 400 });
		}
		const limit = await dependencies.consumeAuthRateLimit(
			db,
			'login',
			request,
			body.email,
			rateLimitSecret
		);
		platform?.ctx?.waitUntil(dependencies.pruneAuthRateLimits(db));
		if (!limit.allowed) {
			return json(
				{ error: 'Too many login attempts. Try again later.' },
				{ status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
			);
		}

		const result = await dependencies.login(db, body.email, body.password);
		if (!result) {
			return json({ error: 'Invalid email or password' }, { status: 401 });
		}
		await dependencies.resetAuthRateLimit(db, limit.keyHash);

		cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60));

		return json({ user: result.user });
	};
}

export const POST = _createLoginPostHandler();

export const DELETE: RequestHandler = async ({ cookies, platform }) => {
	const db = platform?.env.DB;
	const token = readSessionToken(cookies);

	if (db && token) {
		await logout(db, token);
	}

	cookies.delete(SESSION_COOKIE, { path: '/' });
	return json({ ok: true });
};
