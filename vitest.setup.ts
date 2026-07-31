import '@testing-library/jest-dom';
import { configureRetryClient } from './frontend/services/retryClient';

// Keep retry backoff near-instant under test so every retry-wired call site
// (services + settings store) runs deterministically without real sleeps.
// Production defaults (1s base, 30s cap, full jitter) are untouched; the
// retryClient suite resets to DEFAULT_RETRY_CONFIG in its own beforeEach.
configureRetryClient({
	maxRetries: 3,
	baseDelayMs: 1,
	maxDelayMs: 5,
	factor: 2,
	jitter: 'none',
	retryOnNetworkError: true,
	maxConcurrent: 4,
});
