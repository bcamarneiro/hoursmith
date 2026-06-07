import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { capturePageview } from '../../analytics';

/**
 * Fire a PostHog SPA pageview on every route change (and first mount). PostHog's
 * automatic pageview tracking only fires on full page loads, so single-page
 * navigations are invisible without this. No-op until analytics is initialised
 * (ADA-377). Must be called inside the router.
 */
export function usePageViewTracking(): void {
	const { pathname, search } = useLocation();
	useEffect(() => {
		capturePageview(pathname + search);
	}, [pathname, search]);
}
