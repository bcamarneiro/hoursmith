/**
 * Frontend transport for operational flags (ADA-341).
 *
 * The static SPA can't read Edge Config directly, so it fetches the resolved
 * snapshot from `GET /api/flags`. An optional bearer token personalises
 * `paywallOpenForMe` for the signed-in (premium) user.
 *
 * Fail policy: fail-OPEN for availability (no false maintenance screen, checkout
 * stays usable), fail-CLOSED for the paywall (an unreachable endpoint must never
 * leak a pre-launch checkout to an anonymous visitor).
 */

export interface PublicFlags {
	maintenanceMode: boolean;
	checkoutEnabled: boolean;
	paywallPublic: boolean;
	paywallOpenForMe: boolean;
	announcementBanner: string | null;
}

export const DEFAULT_FLAGS: PublicFlags = {
	maintenanceMode: false,
	checkoutEnabled: true,
	paywallPublic: false,
	paywallOpenForMe: false,
	announcementBanner: null,
};

export async function fetchFlags(token?: string): Promise<PublicFlags> {
	try {
		const res = await fetch('/api/flags', {
			headers: token ? { authorization: `Bearer ${token}` } : undefined,
		});
		if (!res.ok) return DEFAULT_FLAGS;
		const data = (await res.json()) as Partial<PublicFlags>;
		return { ...DEFAULT_FLAGS, ...data };
	} catch {
		return DEFAULT_FLAGS;
	}
}
