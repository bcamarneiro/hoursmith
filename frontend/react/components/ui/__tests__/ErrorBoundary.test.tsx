/**
 * ErrorBoundary recovery (ADA-766): a crashed section shows a fallback, and
 * "Try again" resets the boundary in place — the page, URL and surrounding
 * UI survive without a forced reload or navigation.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary';

function FlakyChild({ crash }: { crash: boolean }) {
	if (crash) throw new Error('boom');
	return <div>recovered content</div>;
}

describe('ErrorBoundary recovery', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(window.location, 'reload').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renders the fallback when a child throws', () => {
		render(
			<ErrorBoundary>
				<FlakyChild crash />
			</ErrorBoundary>,
		);

		expect(
			screen.getByText('Something went wrong rendering this section.'),
		).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'Try again' }),
		).toBeInTheDocument();
		expect(screen.queryByText('recovered content')).not.toBeInTheDocument();
	});

	it('resets the boundary in place without a forced reload or navigation', () => {
		const hrefBefore = window.location.href;

		const { rerender } = render(
			<ErrorBoundary>
				<FlakyChild crash />
			</ErrorBoundary>,
		);
		expect(
			screen.getByRole('button', { name: 'Try again' }),
		).toBeInTheDocument();

		// The underlying error clears (e.g. transient API failure); only then
		// does "Try again" become meaningful.
		rerender(
			<ErrorBoundary>
				<FlakyChild crash={false} />
			</ErrorBoundary>,
		);

		act(() => screen.getByRole('button', { name: 'Try again' }).click());

		// Children re-render successfully — recovery in place, not a reload.
		expect(screen.getByText('recovered content')).toBeInTheDocument();
		expect(window.location.reload).not.toHaveBeenCalled();
		expect(window.location.href).toBe(hrefBefore);
	});
});
