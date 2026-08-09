/**
 * useFlags — operational flags for the SPA (ADA-341).
 *
 * A dependency-free hook with a tiny module-level cache: the anonymous snapshot
 * is fetched once and shared across all consumers (maintenance gate, pricing
 * CTAs). A token-bearing call (the signed-in Account page) bypasses the anon
 * cache so the user gets their personalised `paywallOpenForMe`.
 *
 * Returns safe defaults while loading / on error so callers can read fields
 * unconditionally without a loading branch.
 */

import { useEffect, useState, useCallback } from 'react';
import {
	DEFAULT_FLAGS,
	fetchFlags,
	updateFlags as updateFlagsService,
	type PublicFlags,
} from '../../services/flagsService';

let anonCache: PublicFlags | null = null;
let anonInflight: Promise<PublicFlags> | null = null;

function loadAnon(): Promise<PublicFlags> {
	if (anonCache) return Promise.resolve(anonCache);
	if (!anonInflight) {
		anonInflight = fetchFlags().then((flags) => {
			anonCache = flags;
			anonInflight = null;
			return flags;
		});
	}
	return anonInflight;
}

export function useFlags(token?: string | null): PublicFlags {
	const [flags, setFlags] = useState<PublicFlags>(anonCache ?? DEFAULT_FLAGS);

	useEffect(() => {
		let active = true;
		const promise = token ? fetchFlags(token) : loadAnon();
		promise.then((next) => {
			if (active) setFlags(next);
		});
		return () => {
			active = false;
		};
	}, [token]);

	return flags;
}

/** Test hook: clear the module cache between cases. */
export function __resetFlagsCache(): void {
	anonCache = null;
	anonInflight = null;
}

export interface UpdateFlagsState {
	/** True while the PATCH request is in flight. */
	isUpdating: boolean;
	/** Non-null when the last update failed. */
	error: string | null;
	/** Call to write flags. Returns the full updated snapshot on success. */
	update: (patch: Partial<PublicFlags>) => Promise<PublicFlags>;
}

/**
 * Hook to write flag values to Edge Config.
 *
 * Returns `{ isUpdating, error, update }`. Call `update(patch)` to persist
 * changes; the returned flags reflect the server's post-write snapshot.
 *
 * The caller is expected to catch the returned promise if they want to react
 * to success immediately; the hook's `error` state tracks the last failure.
 */
export function useUpdateFlags(): UpdateFlagsState {
	const [isUpdating, setIsUpdating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const update = useCallback(async (patch: Partial<PublicFlags>) => {
		setIsUpdating(true);
		setError(null);
		try {
			const result = await updateFlagsService(patch);
			// Bump the anon cache so the next read sees the new state.
			anonCache = result;
			return result;
		} catch (err) {
			const message =
				err instanceof Error ? err.message : 'Failed to update flags';
			setError(message);
			throw err;
		} finally {
			setIsUpdating(false);
		}
	}, []);

	return { isUpdating, error, update };
}
