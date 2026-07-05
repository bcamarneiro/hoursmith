import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Control the analytics seam: `isFeatureEnabled` reads a mutable value and
// `onFeatureFlags` captures the subscriber so the test can simulate a flag load.
const flagState = { value: false as boolean | undefined };
let subscriber: (() => void) | null = null;

vi.mock('../../../analytics', () => ({
	isFeatureEnabled: (_flag: string, fallback = false) =>
		typeof flagState.value === 'boolean' ? flagState.value : fallback,
	onFeatureFlags: (cb: () => void) => {
		subscriber = cb;
		return () => {
			subscriber = null;
		};
	},
}));

import { useFeatureFlag } from '../useFeatureFlag';

afterEach(() => {
	flagState.value = false;
	subscriber = null;
	vi.restoreAllMocks();
});

describe('useFeatureFlag', () => {
	it('starts from the fallback when flags have not loaded', () => {
		flagState.value = undefined; // SDK not ready → hook must use fallback
		const { result } = renderHook(() => useFeatureFlag('reminders-ui', false));
		expect(result.current).toBe(false);
	});

	it('turns on when PostHog loads the flag as enabled', () => {
		flagState.value = undefined;
		const { result } = renderHook(() => useFeatureFlag('reminders-ui', false));
		expect(result.current).toBe(false);
		// simulate PostHog resolving flags with this one enabled
		act(() => {
			flagState.value = true;
			subscriber?.();
		});
		expect(result.current).toBe(true);
	});

	it('reflects a later flip back to off', () => {
		flagState.value = true;
		const { result } = renderHook(() => useFeatureFlag('reminders-ui', false));
		// re-read on mount picks up the already-true value
		expect(result.current).toBe(true);
		act(() => {
			flagState.value = false;
			subscriber?.();
		});
		expect(result.current).toBe(false);
	});

	it('unsubscribes on unmount', () => {
		const { unmount } = renderHook(() => useFeatureFlag('reminders-ui', false));
		expect(subscriber).not.toBeNull();
		unmount();
		expect(subscriber).toBeNull();
	});
});
