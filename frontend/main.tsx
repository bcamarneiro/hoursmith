import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { initAnalytics } from './analytics';
import { App } from './react/App';
import { queryClient } from './react/queryClient';
import { logger } from './react/utils/logger';
import { registerAppServiceWorker } from './react/utils/pwa';
import { withBasePath } from './react/utils/runtimeConfig';
import './react/styles/global.css';
import { createDefaultConfig, useConfigStore } from './stores/useConfigStore';

// Start MSW only in offline mode
async function startApp() {
	if (process.env.OFFLINE_MODE === 'true') {
		try {
			const { worker } = await import('./mocks/browser');
			await worker.start({
				onUnhandledRequest: 'bypass', // Don't warn about unhandled requests
				serviceWorker: {
					url: withBasePath('/mockServiceWorker.js'),
				},
			});
			logger.debug('[OFFLINE MODE] MSW started successfully');

			// Set up default configuration for offline mode
			const { setConfig } = useConfigStore.getState();
			setConfig({
				...createDefaultConfig(),
				jiraHost: 'mock.atlassian.net',
				email: 'dev@example.com',
				apiToken: 'mock-token',
			});
			logger.debug('[OFFLINE MODE] Default configuration set');

			// Set the current month to October 2025 for testing
			const { useTimesheetStore } = await import('./stores/useTimesheetStore');
			useTimesheetStore.getState().setCurrentMonth(2025, 9); // October (0-indexed)
			logger.debug('[OFFLINE MODE] Set to October 2025 for testing');
		} catch (error) {
			logger.error('[OFFLINE MODE] Failed to start MSW:', error);
		}
	}

	// Product analytics (ADA-377). No-op unless VITE_POSTHOG_KEY is set.
	initAnalytics();

	const container = document.getElementById('root');
	if (container) {
		const root = createRoot(container);
		root.render(
			<QueryClientProvider client={queryClient}>
				<App />
			</QueryClientProvider>,
		);
	}

	if (process.env.NODE_ENV === 'production') {
		await registerAppServiceWorker();
	}
}

startApp();
