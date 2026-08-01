/**
 * Toast dismissal (ADA-766): dismissing an alert must only remove that
 * notification — the toast container stays mounted, the session stays
 * intact, and no forced reload or navigation happens.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer, toast } from '../Toast';

describe('Toast dismissal', () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.spyOn(window.location, 'reload').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('announces error toasts as alerts and success toasts as status', () => {
		render(<ToastContainer />);

		act(() => {
			toast.error('Sync failed');
			toast.success('Saved');
		});

		expect(screen.getByRole('alert')).toHaveTextContent('Sync failed');
		expect(screen.getByRole('status')).toHaveTextContent('Saved');
	});

	it('dismissing one toast removes only that toast', () => {
		render(<ToastContainer />);

		act(() => {
			toast.error('First failure');
			toast.error('Second failure');
		});

		const dismissFirst = screen.getByRole('button', {
			name: 'Dismiss: First failure',
		});
		const dismissSecond = screen.getByRole('button', {
			name: 'Dismiss: Second failure',
		});

		act(() => dismissFirst.click());

		expect(screen.getByRole('alert')).toHaveTextContent('Second failure');
		expect(screen.queryByText('First failure')).not.toBeInTheDocument();
		// Second toast's dismiss button still has its unique label
		expect(dismissSecond).toBeInTheDocument();
	});

	it('keeps the session intact without a forced reload after dismissal', () => {
		render(<ToastContainer />);

		act(() => toast.error('Sync failed'));

		const hrefBefore = window.location.href;

		act(() =>
			screen
				.getByRole('button', { name: 'Dismiss: Sync failed' })
				.click(),
		);

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		// No forced reload, no navigation — the page stays exactly where it was.
		expect(window.location.reload).not.toHaveBeenCalled();
		expect(window.location.href).toBe(hrefBefore);

		// Container is still mounted and reusable: a later alert renders fine.
		act(() => toast.info('Still here'));
		expect(screen.getByRole('status')).toHaveTextContent('Still here');
	});
});
