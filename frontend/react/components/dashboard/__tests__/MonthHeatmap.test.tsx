import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MonthHeatmap } from '../MonthHeatmap';

function buildTestData(
	days: Record<string, number> = {},
): Map<string, number> {
	const map = new Map<string, number>();
	for (const [date, seconds] of Object.entries(days)) {
		map.set(date, seconds);
	}
	return map;
}

describe('MonthHeatmap', () => {
	it('renders cells with role="button" and tabIndex', () => {
		const data = buildTestData({ '2026-07-15': 14400 });
		render(<MonthHeatmap monthData={data} month={6} year={2026} />);
		const cell = screen.getByRole('button', { name: /2026-07-15/ });
		expect(cell).toBeTruthy();
		expect(cell.getAttribute('tabindex')).toBe('0');
	});

	it('opens popover on Enter key and closes on Escape', () => {
		const data = buildTestData({ '2026-07-15': 14400 });
		render(<MonthHeatmap monthData={data} month={6} year={2026} />);

		const cell = screen.getByRole('button', { name: /2026-07-15/ });
		fireEvent.keyDown(cell, { key: 'Enter' });

		const popover = screen.getByRole('dialog');
		expect(popover).toBeTruthy();
		expect(popover.textContent).toContain('2026-07-15');

		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('opens popover on Space key', () => {
		const data = buildTestData({ '2026-07-15': 14400 });
		render(<MonthHeatmap monthData={data} month={6} year={2026} />);

		const cell = screen.getByRole('button', { name: /2026-07-15/ });
		fireEvent.keyDown(cell, { key: ' ' });

		expect(screen.getByRole('dialog')).toBeTruthy();
	});

	it('closes popover on outside pointerdown', () => {
		const data = buildTestData({ '2026-07-15': 14400 });
		render(<MonthHeatmap monthData={data} month={6} year={2026} />);

		const cell = screen.getByRole('button', { name: /2026-07-15/ });
		fireEvent.keyDown(cell, { key: 'Enter' });
		expect(screen.getByRole('dialog')).toBeTruthy();

		fireEvent.pointerDown(document.body);
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('does not close popover on pointerdown inside trigger cell', () => {
		const data = buildTestData({ '2026-07-15': 14400 });
		render(<MonthHeatmap monthData={data} month={6} year={2026} />);

		const cell = screen.getByRole('button', { name: /2026-07-15/ });
		fireEvent.keyDown(cell, { key: 'Enter' });
		expect(screen.getByRole('dialog')).toBeTruthy();

		// pointerdown on the trigger cell should be ignored by the outside-click guard
		fireEvent.pointerDown(cell);
		expect(screen.getByRole('dialog')).toBeTruthy();
	});

	it('toggles aria-expanded between true and false', () => {
		const data = buildTestData({ '2026-07-15': 14400 });
		render(<MonthHeatmap monthData={data} month={6} year={2026} />);

		const cell = screen.getByRole('button', { name: /2026-07-15/ });
		expect(cell.getAttribute('aria-expanded')).toBe('false');

		fireEvent.keyDown(cell, { key: 'Enter' });
		expect(cell.getAttribute('aria-expanded')).toBe('true');

		fireEvent.keyDown(document, { key: 'Escape' });
		expect(cell.getAttribute('aria-expanded')).toBe('false');
	});

	it('popover has role="dialog" with aria-label', () => {
		const data = buildTestData({ '2026-07-15': 14400 });
		render(<MonthHeatmap monthData={data} month={6} year={2026} />);

		const cell = screen.getByRole('button', { name: /2026-07-15/ });
		fireEvent.keyDown(cell, { key: 'Enter' });

		const popover = screen.getByRole('dialog');
		expect(popover).toBeTruthy();
		expect(popover.getAttribute('role')).toBe('dialog');
		expect(popover.getAttribute('aria-label')).toBe(
			'Details for 2026-07-15',
		);
	});

	it('allows keyboard-only operation: Enter to open, Escape to close', () => {
		const data = buildTestData({
			'2026-07-15': 14400,
			'2026-07-16': 7200,
		});
		render(<MonthHeatmap monthData={data} month={6} year={2026} />);

		const day15 = screen.getByRole('button', { name: /2026-07-15/ });
		fireEvent.keyDown(day15, { key: 'Enter' });
		expect(screen.getByRole('dialog')).toBeTruthy();

		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByRole('dialog')).toBeNull();

		const day16 = screen.getByRole('button', { name: /2026-07-16/ });
		fireEvent.keyDown(day16, { key: ' ' });
		expect(screen.getByRole('dialog')).toBeTruthy();
		expect(screen.getByRole('dialog').textContent).toContain('2026-07-16');
	});
});
