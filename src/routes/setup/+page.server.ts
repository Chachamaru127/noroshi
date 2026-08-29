import type { PageServerLoad } from './$types';
import {
	ConfigError,
	safeEmailProviderKind,
	listSetupAvailableDomains,
	hasSetupProviderConfigured,
	providerLoadError
} from '$lib/server/context';
import type { AvailableDomain } from '$lib/types';

/**
 * Loads the domains the configured provider can reach so the first screen is a
 * domain choice rather than a form. Only reachable while the app has no users
 * — the hook redirects away once setup is done.
 */
export const load: PageServerLoad = async ({ platform }) => {
	const providerKind = safeEmailProviderKind(platform);

	try {
		const available = await listSetupAvailableDomains(platform, import.meta.env.DEV);
		return {
			available,
			receiveOnlyLocal: available.length > 0 && available.every((domain) => !domain.can_send),
			providerKind,
			providerConfigured: true,
			loadError: null
		};
	} catch (error) {
		return {
			available: [] as AvailableDomain[],
			receiveOnlyLocal: false,
			providerKind,
			providerConfigured:
				!(error instanceof ConfigError) &&
				hasSetupProviderConfigured(platform, import.meta.env.DEV),
			loadError: providerLoadError(providerKind, error)
		};
	}
};
