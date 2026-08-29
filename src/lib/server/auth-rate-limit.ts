import type { D1Database } from '@cloudflare/workers-types';

type AuthRateLimitScope = 'login' | 'setup';

const POLICIES: Record<AuthRateLimitScope, { maximum: number; windowMs: number }> = {
	login: { maximum: 5, windowMs: 15 * 60 * 1000 },
	setup: { maximum: 5, windowMs: 30 * 60 * 1000 }
};
const RETENTION_MS = 24 * 60 * 60 * 1000;

export type AuthRateLimitResult = {
	allowed: boolean;
	attempts: number;
	retryAfterSeconds: number;
	keyHash: string;
};

export async function consumeAuthRateLimit(
	db: D1Database,
	scope: AuthRateLimitScope,
	request: Request,
	discriminator: string,
	pepper: string,
	now = new Date()
): Promise<AuthRateLimitResult> {
	const policy = POLICIES[scope];
	if (pepper.length < 32) throw new Error('Authentication rate-limit secret is unavailable');
	const keyHash = await authRateLimitKey(scope, request, discriminator, pepper);
	const cutoff = new Date(now.getTime() - policy.windowMs).toISOString();
	const expiresAt = new Date(now.getTime() + RETENTION_MS).toISOString();
	const row = await db
		.prepare(
			`INSERT INTO auth_rate_limits
			 (scope, key_hash, window_started_at, attempts, expires_at)
			 VALUES (?1, ?2, ?3, 1, ?4)
			 ON CONFLICT(scope, key_hash) DO UPDATE SET
			   attempts = CASE
			     WHEN julianday(auth_rate_limits.window_started_at) <= julianday(?5) THEN 1
			     ELSE auth_rate_limits.attempts + 1
			   END,
			   window_started_at = CASE
			     WHEN julianday(auth_rate_limits.window_started_at) <= julianday(?5) THEN excluded.window_started_at
			     ELSE auth_rate_limits.window_started_at
			   END,
			   expires_at = excluded.expires_at
			 RETURNING attempts, window_started_at`
		)
		.bind(scope, keyHash, now.toISOString(), expiresAt, cutoff)
		.first<{ attempts: number; window_started_at: string }>();
	if (!row) throw new Error('Authentication rate-limit claim failed');

	const elapsed = Math.max(0, now.getTime() - new Date(row.window_started_at).getTime());
	return {
		allowed: row.attempts <= policy.maximum,
		attempts: row.attempts,
		retryAfterSeconds: Math.max(1, Math.ceil((policy.windowMs - elapsed) / 1000)),
		keyHash
	};
}

export async function resetAuthRateLimit(db: D1Database, keyHash: string): Promise<void> {
	await db.prepare('DELETE FROM auth_rate_limits WHERE key_hash = ?').bind(keyHash).run();
}

export async function pruneAuthRateLimits(db: D1Database, now = new Date()): Promise<void> {
	await db
		.prepare('DELETE FROM auth_rate_limits WHERE julianday(expires_at) <= julianday(?)')
		.bind(now.toISOString())
		.run();
}

export async function claimSetupBootstrap(
	db: D1Database,
	now = new Date()
): Promise<string | null> {
	const token = crypto.randomUUID();
	const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
	const row = await db
		.prepare(
			`INSERT INTO setup_bootstrap_claim (singleton, lease_token, expires_at)
			 VALUES (1, ?1, ?2)
			 ON CONFLICT(singleton) DO UPDATE SET lease_token = excluded.lease_token,
			   expires_at = excluded.expires_at
			 WHERE julianday(setup_bootstrap_claim.expires_at) <= julianday(?3)
			 RETURNING lease_token`
		)
		.bind(token, expiresAt, now.toISOString())
		.first<{ lease_token: string }>();
	return row?.lease_token === token ? token : null;
}

export async function releaseSetupBootstrap(db: D1Database, token: string): Promise<void> {
	await db
		.prepare('DELETE FROM setup_bootstrap_claim WHERE singleton = 1 AND lease_token = ?')
		.bind(token)
		.run();
}

export async function renewSetupBootstrap(db: D1Database, token: string): Promise<boolean> {
	const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
	const result = await db
		.prepare(
			`UPDATE setup_bootstrap_claim SET expires_at = ?
			 WHERE singleton = 1 AND lease_token = ? AND julianday(expires_at) > julianday('now')`
		)
		.bind(expiresAt, token)
		.run();
	return (result.meta.changes ?? 0) === 1;
}

async function authRateLimitKey(
	scope: AuthRateLimitScope,
	request: Request,
	discriminator: string,
	pepper: string
): Promise<string> {
	const clientAddress = request.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
	const normalized = discriminator.trim().toLowerCase().slice(0, 320);
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(pepper),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const bytes = encoder.encode(`${scope}\u0000${clientAddress}\u0000${normalized}`);
	const digest = await crypto.subtle.sign('HMAC', key, bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
