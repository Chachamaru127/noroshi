type PlatformWithBootstrapSecret = { env?: { BOOTSTRAP_SECRET?: string } } | null | undefined;
type PlatformWithAuthRateLimitSecret =
	{ env?: { AUTH_RATE_LIMIT_SECRET?: string } } | null | undefined;

export function resolveBootstrapSecret(
	platform: PlatformWithBootstrapSecret,
	options: { isDev?: boolean; privateEnvironment?: Record<string, string | undefined> } = {}
): string | null {
	const bound = platform?.env?.BOOTSTRAP_SECRET?.trim();
	if (bound) return bound;
	const isDev = options.isDev ?? import.meta.env.DEV;
	if (!isDev) return null;
	const runtimeEnvironment =
		options.privateEnvironment ??
		(typeof process === 'undefined' ? {} : (process.env as Record<string, string | undefined>));
	const value = runtimeEnvironment.BOOTSTRAP_SECRET?.trim();
	return value || null;
}

export function resolveAuthRateLimitSecret(
	platform: PlatformWithAuthRateLimitSecret,
	options: { isDev?: boolean; privateEnvironment?: Record<string, string | undefined> } = {}
): string | null {
	const bound = platform?.env?.AUTH_RATE_LIMIT_SECRET?.trim();
	if (bound) return bound;
	const isDev = options.isDev ?? import.meta.env.DEV;
	if (!isDev) return null;
	const runtimeEnvironment =
		options.privateEnvironment ??
		(typeof process === 'undefined' ? {} : (process.env as Record<string, string | undefined>));
	const value = runtimeEnvironment.AUTH_RATE_LIMIT_SECRET?.trim();
	return value || null;
}
