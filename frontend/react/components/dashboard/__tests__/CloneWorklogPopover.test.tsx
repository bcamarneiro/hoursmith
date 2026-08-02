import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CloneWorklogPopover } from '../CloneWorklogPopover';

function renderPopover(
	overrides: Partial<Parameters<typeof CloneWorklogPopover>[0]> = {},
) {
	const onClone = vi.fn();
	const onCancel = vi.fn();
	render(
		<CloneWorklogPopover
			issueKey="PROJ-1"
			timeSpent="8h"
			sourceDate="2026-07-10"
			onClone={onClone}
			onCancel={onCancel}
			{...overrides}
		/>,
	);
	return { onClone, onCancel };
}

describe('CloneWorklogPopover', () => {
	it('renders the source month with the source day disabled', () => {
		renderPopover();
		const source = screen.getByRole('button', { name: '2026-07-10 (source)' });
		expect(source.hasAttribute('disabled')).toBe(true);
		expect(screen.getByRole('button', { name: '2026-07-15' })).toBeTruthy();
	});

	it('toggles a day selection, reflected in the count and a removable chip', () => {
		renderPopover();
		const day = screen.getByRole('button', { name: '2026-07-15' });
		fireEvent.click(day);
		expect(screen.getByText('1 selected')).toBeTruthy();
		expect(day.getAttribute('aria-pressed')).toBe('true');
		expect(
			screen.getByRole('button', { name: 'Remove 2026-07-15' }),
		).toBeTruthy();

		fireEvent.click(day);
		expect(screen.getByText('0 selected')).toBeTruthy();
		expect(
			screen.queryByRole('button', { name: 'Remove 2026-07-15' }),
		).toBeNull();
	});

	it('keeps selections across month navigation', () => {
		renderPopover();
		fireEvent.click(screen.getByRole('button', { name: '2026-07-15' }));

		fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
		// July day is gone from the grid; August days are shown.
		expect(screen.queryByRole('button', { name: '2026-07-15' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: '2026-08-20' }));
		expect(screen.getByText('2 selected')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
		expect(
			screen
				.getByRole('button', { name: '2026-07-15' })
				.getAttribute('aria-pressed'),
		).toBe('true');
	});

	it('disables Clone with no selection and calls onClone with sorted dates', () => {
		const { onClone } = renderPopover();
		const cloneBtn = screen.getByRole('button', { name: /Clone →/ });
		expect(cloneBtn.hasAttribute('disabled')).toBe(true);

		fireEvent.click(screen.getByRole('button', { name: '2026-07-16' }));
		fireEvent.click(screen.getByRole('button', { name: '2026-07-15' }));
		fireEvent.click(screen.getByRole('button', { name: /Clone →/ }));

		expect(onClone).toHaveBeenCalledTimes(1);
		expect(onClone).toHaveBeenCalledWith(['2026-07-15', '2026-07-16']);
	});

	it('disables Clone and Cancel buttons during loading and shows Cloning...', () => {
		renderPopover({ isLoading: true });
		fireEvent.click(screen.getByRole('button', { name: '2026-07-16' }));

		const cloneBtn = screen.getByRole('button', { name: 'Cloning...' });
		expect(cloneBtn.hasAttribute('disabled')).toBe(true);

		const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
		expect(cancelBtn.hasAttribute('disabled')).toBe(true);
	});

	it('renders an error message when error prop is set', () => {
		renderPopover({ error: 'Network error' });
		expect(screen.getByText('Network error')).toBeTruthy();
	});
});
