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
		vi.spyOn(window.location, 'reload').mockImplementation(() => {});
	});

	afterEach(() => {
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

		const dismissButtons = screen.getAllByRole('button', {
			name: 'Dismiss notification',
		});
		expect(dismissButtons).toHaveLength(2);

		act(() => dismissButtons[0].click());

		expect(screen.getByRole('alert')).toHaveTextContent('Second failure');
		expect(screen.queryByText('First failure')).not.toBeInTheDocument();
	});

	it('keeps the session intact without a forced reload after dismissal', () => {
		render(<ToastContainer />);

		act(() => toast.error('Sync failed'));

		const hrefBefore = window.location.href;

		act(() =>
			screen.getByRole('button', { name: 'Dismiss notification' }).click(),
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
