import { render, screen } from '@testing-library/react';
import type { FC } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary';

const Crash: FC = () => {
	throw new Error('crash');
};

describe('ErrorBoundary', () => {
	it('renders children when no error', () => {
		render(
			<MemoryRouter>
				<ErrorBoundary>
					<div>healthy</div>
				</ErrorBoundary>
			</MemoryRouter>,
		);
		expect(screen.getByText('healthy')).toBeInTheDocument();
	});

	it('renders fallback UI with Go Home link and Try again button on error', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		render(
			<MemoryRouter initialEntries={['/reports']}>
				<ErrorBoundary>
					<Crash />
				</ErrorBoundary>
			</MemoryRouter>,
		);
		// Fallback text is present.
		expect(
			screen.getByText('Something went wrong rendering this section.'),
		).toBeInTheDocument();

		// Go Home link navigates to root.
		const goHome = screen.getByRole('link', { name: 'Go Home' });
		expect(goHome).toHaveAttribute('href', '/');

		// Try again button is rendered (its onClick calls setState to reset the error).
		expect(
			screen.getByRole('button', { name: 'Try again' }),
		).toBeInTheDocument();

		vi.restoreAllMocks();
	});
});
