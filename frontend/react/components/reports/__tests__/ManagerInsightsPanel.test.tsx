import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ManagerTrendModel } from '../../../utils/teamReports';
import { ManagerInsightsPanel } from '../ManagerInsightsPanel';

// ADA-479: the manager view must read as aggregate patterns, not a per-person
// dossier. Individual names are an explicit opt-in (collapsed <details>), and an
// in-product line states completeness is a timeliness signal, not productivity.

const model: ManagerTrendModel = {
	weeks: [],
	averageComplianceRate: 82,
	totalTrendGapSeconds: 3600,
	recurringGapMembers: [
		{
			email: 'dana@example.com',
			displayName: 'Dana Lopez',
			gapWeeks: 3,
			currentGapSeconds: 3600,
			averageGapSeconds: 5400,
			currentLoggedSeconds: 7200,
		},
	],
	onTimeHistory: [],
};

const baseProps = {
	trendWeeks: 6,
	onTrendWeeksChange: () => {},
	currentMembers: [],
	isLoading: false,
};

describe('ManagerInsightsPanel (ADA-479 reframing)', () => {
	it('keeps per-person recurring-gap names behind an opt-in disclosure', () => {
		render(<ManagerInsightsPanel {...baseProps} model={model} />);

		// The aggregate framing is the default; the individual breakdown is a
		// deliberate expand, not an open leaderboard.
		const summary = screen.getByText(/show who's had recurring gaps/i);
		const disclosure = summary.closest('details');
		expect(disclosure).not.toBeNull();
		expect(disclosure?.hasAttribute('open')).toBe(false);

		// Old surveillance-flavoured heading is gone; help framing replaces it.
		expect(screen.queryByText(/recurring attention list/i)).toBeNull();
		expect(screen.getByText(/who might need a hand/i)).toBeTruthy();
	});

	it('states completeness is not a productivity measure', () => {
		render(<ManagerInsightsPanel {...baseProps} model={model} />);
		expect(
			screen.getByText(/not a measure of productivity or performance/i),
		).toBeTruthy();
	});
});
