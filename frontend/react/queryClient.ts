import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 15 * 60 * 1000, // 15 minutes
			gcTime: 30 * 60 * 1000, // 30 minutes
			refetchOnWindowFocus: false,
			retry: 1,
		},
	},
});
