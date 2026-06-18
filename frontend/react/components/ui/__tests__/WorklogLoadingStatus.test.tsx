// @vitest-environment happy-dom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { WorklogFetchProgress } from '../../../../../types/worklogLoading';
import { WorklogLoadingStatus } from '../WorklogLoadingStatus';

describe('WorklogLoadingStatus', () => {
	const progressbar = (container: HTMLElement) =>
		container.querySelector('[role="progressbar"]') as HTMLElement | null;
	const fill = (container: HTMLElement) =>
		progressbar(container)?.firstElementChild as HTMLElement | null;

	it('renders a determinate percentage bar when a Server/DC total drives progress', () => {
		const progress: WorklogFetchProgress = {
			phase: 'searching',
			percent: 45,
			message: 'Searching Jira issues with worklogs',
			detail: 'Loaded search page 2 of 4',
		};
		const { container } = render(
			<WorklogLoadingStatus title="Loading worklogs" progress={progress} />,
		);

		// "page X of Y" is a real denominator → show the percentage.
		expect(container.textContent).toContain('45%');
		expect(progressbar(container)?.getAttribute('aria-valuenow')).toBe('45');
		expect(fill(container)?.style.width).toBe('45%');
	});

	it('renders a running count + indeterminate bar on Jira Cloud (no total)', () => {
		// Cloud cursor pagination: fixed placeholder percent + "Loaded N" detail.
		const progress: WorklogFetchProgress = {
			phase: 'searching',
			percent: 45,
			message: 'Searching Jira issues with worklogs',
			detail: 'Loaded 137 issues',
		};
		const { container } = render(
			<WorklogLoadingStatus title="Loading worklogs" progress={progress} />,
		);

		// No misleading fixed percentage in the header.
		expect(container.textContent).not.toContain('45%');
		// Running count is surfaced instead.
		expect(container.textContent).toContain('137');
		expect(container.textContent).toContain('fetched');

		// Bar is indeterminate: no aria-valuenow and no inline width.
		const bar = progressbar(container);
		expect(bar?.getAttribute('aria-valuenow')).toBeNull();
		expect(fill(container)?.style.width).toBe('');
	});

	it('shows the completed percentage when the fetch finishes', () => {
		const progress: WorklogFetchProgress = {
			phase: 'complete',
			percent: 100,
			message: 'Worklogs loaded',
			detail: '512 worklogs ready',
		};
		const { container } = render(
			<WorklogLoadingStatus title="Loading worklogs" progress={progress} />,
		);
		expect(container.textContent).toContain('100%');
		expect(progressbar(container)?.getAttribute('aria-valuenow')).toBe('100');
	});

	it('is indeterminate while preparing (null progress)', () => {
		const { container } = render(
			<WorklogLoadingStatus title="Loading worklogs" progress={null} />,
		);
		expect(container.textContent).toContain('Preparing worklog fetch');
		expect(container.textContent).not.toContain('%');
		expect(progressbar(container)?.getAttribute('aria-valuenow')).toBeNull();
	});
});
