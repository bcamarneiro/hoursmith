// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ManualFlagToggle } from '../ManualFlagToggle';

describe('ManualFlagToggle', () => {
	it('renders as unchecked by default', () => {
		render(<ManualFlagToggle checked={false} onChange={() => {}} />);
		const toggle = screen.getByRole('switch');
		expect(toggle).toHaveAttribute('aria-checked', 'false');
	});

	it('renders as checked when checked=true', () => {
		render(<ManualFlagToggle checked={true} onChange={() => {}} />);
		expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
	});

	it('calls onChange with true when clicked while off', () => {
		const onChange = vi.fn();
		render(<ManualFlagToggle checked={false} onChange={onChange} />);
		fireEvent.click(screen.getByRole('switch'));
		expect(onChange).toHaveBeenCalledWith(true);
	});

	it('calls onChange with false when clicked while on', () => {
		const onChange = vi.fn();
		render(<ManualFlagToggle checked={true} onChange={onChange} />);
		fireEvent.click(screen.getByRole('switch'));
		expect(onChange).toHaveBeenCalledWith(false);
	});

	it('does not call onChange when disabled', () => {
		const onChange = vi.fn();
		render(<ManualFlagToggle checked={false} onChange={onChange} disabled />);
		fireEvent.click(screen.getByRole('switch'));
		expect(onChange).not.toHaveBeenCalled();
	});

	it('renders with aria-disabled when disabled', () => {
		render(<ManualFlagToggle checked={false} onChange={() => {}} disabled />);
		expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true');
	});

	it('renders the label text', () => {
		render(
			<ManualFlagToggle
				checked={false}
				onChange={() => {}}
				label="Test flag"
			/>,
		);
		expect(screen.getByText('Test flag')).toBeTruthy();
	});

	it('uses aria-label when no label prop is provided', () => {
		render(<ManualFlagToggle checked={false} onChange={() => {}} />);
		expect(screen.getByRole('switch')).toHaveAttribute('aria-label', 'Flag');
	});

	it('toggles via Space key', () => {
		const onChange = vi.fn();
		render(<ManualFlagToggle checked={false} onChange={onChange} />);
		fireEvent.keyDown(screen.getByRole('switch'), { key: ' ' });
		expect(onChange).toHaveBeenCalledWith(true);
	});

	it('toggles via Enter key', () => {
		const onChange = vi.fn();
		render(<ManualFlagToggle checked={true} onChange={onChange} />);
		fireEvent.keyDown(screen.getByRole('switch'), { key: 'Enter' });
		expect(onChange).toHaveBeenCalledWith(false);
	});

	it('does not toggle on key press when disabled', () => {
		const onChange = vi.fn();
		render(<ManualFlagToggle checked={false} onChange={onChange} disabled />);
		fireEvent.keyDown(screen.getByRole('switch'), { key: ' ' });
		expect(onChange).not.toHaveBeenCalled();
	});
});
