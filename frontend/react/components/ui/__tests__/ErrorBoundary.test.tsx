import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary';

const Bomb = ({ shouldThrow }: { shouldThrow: boolean }) => {
	if (shouldThrow) throw new Error('test crash');
	return <div>ok</div>;
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

	it('renders fallback UI with Go Home link on error', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		render(
			<MemoryRouter initialEntries={['/reports']}>
				<ErrorBoundary>
					<Bomb shouldThrow />
				</ErrorBoundary>
			</MemoryRouter>,
		);
		expect(screen.getByText('Go Home')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Go Home' })).toHaveAttribute(
			'href',
			'/',
		);
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
		vi.restoreAllMocks();
	});

	it('Try again resets error state', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		render(
			<MemoryRouter>
				<ErrorBoundary>
					<Bomb shouldThrow />
				</ErrorBoundary>
			</MemoryRouter>,
		);
		expect(screen.getByText('Go Home')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(screen.queryByText('Go Home')).not.toBeInTheDocument();
		vi.restoreAllMocks();
	});
});
