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

import { useEffect, useState } from 'react';
import {
	DEFAULT_FLAGS,
	fetchFlags,
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
