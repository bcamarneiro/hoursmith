// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreferencesSection } from '../PreferencesSection';

const baseProps = {
	handleSelectChange: vi.fn(),
	handleChange: vi.fn(),
	themeId: 'theme',
	timeRoundingId: 'round',
	includeAbsenceInCsvId: 'include-absence',
	includeCsvProvenance: false,
	includeCsvProvenanceId: 'include-csv-provenance',
};

describe('PreferencesSection', () => {
	it('renders Theme and Time Rounding selects with the supplied values', () => {
		render(
			<PreferencesSection
				{...baseProps}
				theme="dark"
				timeRounding="15m"
				includeAbsenceInCsv
			/>,
		);
		expect(screen.getByLabelText('Theme')).toHaveValue('dark');
		expect(screen.getByLabelText('Time Rounding')).toHaveValue('15m');
	});

	it('forwards select changes via handleSelectChange', () => {
		const handleSelectChange = vi.fn();
		render(
			<PreferencesSection
				{...baseProps}
				handleSelectChange={handleSelectChange}
				theme="system"
				timeRounding="off"
				includeAbsenceInCsv
			/>,
		);
		fireEvent.change(screen.getByLabelText('Theme'), {
			target: { value: 'light' },
		});
		expect(handleSelectChange).toHaveBeenCalled();
	});

	it('applies the selected theme live to the document root (ADA-451)', () => {
		document.documentElement.removeAttribute('data-theme');
		const { rerender } = render(
			<PreferencesSection
				{...baseProps}
				theme="dark"
				timeRounding="off"
				includeAbsenceInCsv
			/>,
		);
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

		rerender(
			<PreferencesSection
				{...baseProps}
				theme="light"
				timeRounding="off"
				includeAbsenceInCsv
			/>,
		);
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');

		rerender(
			<PreferencesSection
				{...baseProps}
				theme="system"
				timeRounding="off"
				includeAbsenceInCsv
			/>,
		);
		expect(document.documentElement.getAttribute('data-theme')).toBeNull();
	});

	it('reflects includeAbsenceInCsv state and forwards toggle changes', () => {
		const handleChange = vi.fn();
		render(
			<PreferencesSection
				{...baseProps}
				handleChange={handleChange}
				theme="system"
				timeRounding="off"
				includeAbsenceInCsv={false}
			/>,
		);
		const toggle = screen.getByRole('checkbox', {
			name: /Include absence columns in CSV exports/,
		});
		expect(toggle).not.toBeChecked();
		fireEvent.click(toggle);
		expect(handleChange).toHaveBeenCalled();
	});
});
