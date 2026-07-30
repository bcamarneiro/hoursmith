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

import { fromHttpResponseAsync, fromNetworkError, ServiceError } from './serviceErrors';

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

/**
 * Write flag values to the server-side Edge Config via PATCH /api/flags.
 *
 * Only the fields present in `patch` are sent; unknown fields are rejected by
 * the server with 422. On success the full updated snapshot is returned.
 *
 * Throws a `ServiceError` on network or server error so the caller can surface
 * meaningful copy (see `describeServiceError`). The static SPA should be the
 * caller — the premium app gets a direct-edge-config write path instead.
 */
export async function updateFlags(
	patch: Partial<PublicFlags>,
): Promise<PublicFlags> {
	try {
		const res = await fetch('/api/flags', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(patch),
		});
		if (!res.ok) {
			throw await fromHttpResponseAsync(
				'flags',
				{ status: res.status, clone: () => res.clone() },
				'updateFlags',
			);
		}
		return (await res.json()) as PublicFlags;
	} catch (err) {
		if (err instanceof ServiceError) throw err;
		throw fromNetworkError('flags', err);
	}
}

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
