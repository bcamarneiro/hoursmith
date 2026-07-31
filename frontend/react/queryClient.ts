import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { reportError } from '../services/errorInterceptor';

/**
 * Global error interceptor (ADA-694): every query/mutation error is normalized
 * and surfaced as user feedback here. Queries that render their own dominant
 * error state opt out via `meta: { suppressErrorToast: true }`.
 */
export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 15 * 60 * 1000, // 15 minutes
			gcTime: 30 * 60 * 1000, // 30 minutes
			refetchOnWindowFocus: false,
			retry: 1,
		},
	},
	queryCache: new QueryCache({
		onError: (error, query) => {
			if (query.meta?.suppressErrorToast) return;
			reportError(error);
		},
	}),
	mutationCache: new MutationCache({
		onError: (error, _variables, _context, mutation) => {
			if (mutation.meta?.suppressErrorToast) return;
			reportError(error);
		},
	}),
});
