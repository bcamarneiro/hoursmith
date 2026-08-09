import { QueryClient, QueryCache } from '@tanstack/react-query';

const MAX_CACHE_ENTRIES = 30;

/**
 * Bounded QueryCache that enforces a maximum number of cached entries.
 * When the cap is exceeded, the least-recently-used entries (by data update time)
 * with no active observers are evicted first, keeping memory usage bounded.
 */
const queryCache = new QueryCache();

queryCache.subscribe((event) => {
	if (event.type === 'added' || event.type === 'updated') {
		const queries = queryCache.getAll();
		if (queries.length > MAX_CACHE_ENTRIES) {
			// Only evict queries with no active observers (not currently rendered)
			// Sorted by dataUpdatedAt ascending -> oldest first
			const evictable = queries
				.filter((q) => q.getObserversCount() === 0)
				.sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);

			const overage = queries.length - MAX_CACHE_ENTRIES;
			for (let i = 0; i < Math.min(overage, evictable.length); i++) {
				queryCache.remove(evictable[i]);
			}
		}
	}
});

export const queryClient = new QueryClient({
	queryCache,
	defaultOptions: {
		queries: {
			staleTime: 15 * 60 * 1000, // 15 minutes
			gcTime: 30 * 60 * 1000, // 30 minutes
			refetchOnWindowFocus: false,
			retry: 1,
		},
	},
});
