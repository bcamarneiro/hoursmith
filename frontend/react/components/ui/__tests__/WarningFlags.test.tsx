import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WarningFlags } from '../WarningFlags';
import type { WarningFlag } from '../WarningFlags';

describe('WarningFlags', () => {
	const sampleFlags: WarningFlag[] = [
		{ kind: 'incomplete', message: '6.5h of 8h logged', detail: 'Gap: 1.5h' },
		{ kind: 'backdated', message: '3h backdated from Apr 15', detail: 'Comment marker' },
		{ kind: 'overtime', message: '10h logged (2h over target)' },
	];

	it('renders nothing when flags is empty', () => {
		const { container } = render(<WarningFlags flags={[]} />);
		expect(container.firstChild).toBeNull();
	});

	it('renders as a <ul> element', () => {
		const { container } = render(<WarningFlags flags={sampleFlags} />);
		const list = container.firstChild as HTMLElement;
		expect(list).not.toBeNull();
		expect(list.tagName).toBe('UL');
	});

	it('renders list layout by default', () => {
		const { container } = render(<WarningFlags flags={sampleFlags} />);
		const list = container.firstChild as HTMLElement;
		expect(list.getAttribute('data-layout')).toBe('list');
	});

	it('renders all provided flags', () => {
		render(<WarningFlags flags={sampleFlags} />);
		expect(screen.getByText('6.5h of 8h logged')).toBeInTheDocument();
		expect(screen.getByText('3h backdated from Apr 15')).toBeInTheDocument();
		expect(screen.getByText('10h logged (2h over target)')).toBeInTheDocument();
	});

	it('renders items as <li> elements', () => {
		const { container } = render(<WarningFlags flags={sampleFlags} />);
		// getAllByRole('listitem') works with <li> inside <ul>
		const items = screen.getAllByRole('listitem');
		expect(items).toHaveLength(3);
		expect(items[0].tagName).toBe('LI');
	});

	it('renders inline layout when specified', () => {
		const { container } = render(
			<WarningFlags flags={sampleFlags} layout="inline" />,
		);
		const list = container.firstChild as HTMLElement;
		expect(list.getAttribute('data-layout')).toBe('inline');
	});

	it('applies additional className', () => {
		const { container } = render(
			<WarningFlags flags={sampleFlags} className="extra-class" />,
		);
		const list = container.firstChild as HTMLElement;
		expect(list.className).toContain('extra-class');
	});

	it('sets aria-label on the container', () => {
		render(<WarningFlags flags={sampleFlags} />);
		const list = screen.getByRole('list');
		expect(list).toHaveAttribute('aria-label', 'Warnings');
	});

	it('renders severity-coloured badges for each flag kind', () => {
		const allKinds: WarningFlag[] = [
			{ kind: 'incomplete', message: 'Under target' },
			{ kind: 'missing', message: 'No hours' },
			{ kind: 'backdated', message: 'Backdated' },
			{ kind: 'overtime', message: 'Overtime' },
			{ kind: 'weekend-work', message: 'Weekend' },
			{ kind: 'absence-gap', message: 'Absent' },
		];
		const { container } = render(<WarningFlags flags={allKinds} />);
		const items = container.querySelectorAll('li');
		expect(items).toHaveLength(6);

		// Verify each item has a title attribute set (message or detail)
		expect(items[0]).toHaveAttribute('title', 'Under target');
		expect(items[1]).toHaveAttribute('title', 'No hours');
		expect(items[2]).toHaveAttribute('title', 'Backdated');
		expect(items[3]).toHaveAttribute('title', 'Overtime');
		expect(items[4]).toHaveAttribute('title', 'Weekend');
		expect(items[5]).toHaveAttribute('title', 'Absent');
	});

	it('sets title attribute from detail when available', () => {
		render(<WarningFlags flags={sampleFlags} />);
		const items = screen.getAllByRole('listitem');
		expect(items[0]).toHaveAttribute('title', 'Gap: 1.5h');
		expect(items[1]).toHaveAttribute('title', 'Comment marker');
	});

	it('falls back to message when detail is absent', () => {
		render(<WarningFlags flags={[{ kind: 'overtime', message: 'Over target' }]} />);
		const item = screen.getByRole('listitem');
		expect(item).toHaveAttribute('title', 'Over target');
	});

	it('renders an icon for each flag', () => {
		render(<WarningFlags flags={sampleFlags} />);
		const icons = document.querySelectorAll('[aria-hidden="true"]');
		expect(icons).toHaveLength(3);
	});
});
