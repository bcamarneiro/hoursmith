import { describe, expect, it } from 'vitest';
import { classifyWorklog } from '../worklogClassifier';

describe('classifyWorklog', () => {
	it('returns source=none for a same-day entry', () => {
		const result = classifyWorklog({
			started: '2026-03-15T09:00:00.000Z',
			created: '2026-03-15T09:00:30.000Z',
			comment: 'Regular work',
		});

		expect(result.source).toBe('none');
		expect(result.isBackdated).toBe(false);
		expect(result.daysLate).toBe(0);
		expect(result.loggedOn).toBe('2026-03-15');
		expect(result.intendedFor).toBe('2026-03-15');
	});

	it('detects Pattern A (comment marker, started=loggedDate)', () => {
		const result = classifyWorklog({
			started: '2025-10-05T14:00:00.000-0300',
			created: '2025-10-05T14:00:00.000-0300',
			comment: 'Late entry. Original Worklog Date was: 2025/09/25',
		});

		expect(result.source).toBe('comment');
		expect(result.isBackdated).toBe(true);
		expect(result.intendedFor).toBe('2025-09-25');
		expect(result.loggedOn).toBe('2025-10-05');
		expect(result.daysLate).toBe(10);
	});

	it('detects Pattern B (jira-native, created in different month than started)', () => {
		const result = classifyWorklog({
			started: '2025-09-28T10:00:00.000Z',
			created: '2025-10-02T11:00:00.000Z',
			comment: 'No marker',
		});

		expect(result.source).toBe('jira-native');
		expect(result.isBackdated).toBe(true);
		expect(result.intendedFor).toBe('2025-09-28');
		expect(result.loggedOn).toBe('2025-10-02');
		expect(result.daysLate).toBe(4);
	});

	it('does not flag jira-native within the same month even if days differ', () => {
		const result = classifyWorklog({
			started: '2025-10-01T10:00:00.000Z',
			created: '2025-10-08T11:00:00.000Z',
		});

		expect(result.source).toBe('none');
		expect(result.isBackdated).toBe(false);
	});

	it('handles year boundary in jira-native', () => {
		const result = classifyWorklog({
			started: '2025-12-30T10:00:00.000Z',
			created: '2026-01-05T11:00:00.000Z',
		});

		expect(result.source).toBe('jira-native');
		expect(result.daysLate).toBe(6);
	});

	it('comment marker takes precedence over jira-native heuristic', () => {
		const result = classifyWorklog({
			started: '2025-10-05T10:00:00.000Z',
			created: '2025-11-03T10:00:00.000Z',
			comment: 'Original Worklog Date was: 2025/09/20',
		});

		expect(result.source).toBe('comment');
		expect(result.intendedFor).toBe('2025-09-20');
		expect(result.loggedOn).toBe('2025-10-05');
	});

	it('accepts ISO-style separators in the comment marker', () => {
		const result = classifyWorklog({
			started: '2025-10-05T10:00:00.000Z',
			created: '2025-10-05T10:00:00.000Z',
			comment: 'Original Worklog Date was: 2025-09-25',
		});

		expect(result.source).toBe('comment');
		expect(result.intendedFor).toBe('2025-09-25');
	});

	it('returns source=none when comment text is missing markers', () => {
		const result = classifyWorklog({
			started: '2025-10-05T10:00:00.000Z',
			created: '2025-10-05T10:00:00.000Z',
			comment: 'Just a regular note',
		});

		expect(result.source).toBe('none');
	});

	it('does not flag negative drift (created before started)', () => {
		const result = classifyWorklog({
			started: '2025-10-15T10:00:00.000Z',
			created: '2025-09-01T10:00:00.000Z',
		});

		expect(result.daysLate).toBe(0);
		expect(result.source).toBe('none');
	});

	it('handles missing dates gracefully', () => {
		const result = classifyWorklog({});
		expect(result.loggedOn).toBe('');
		expect(result.intendedFor).toBe('');
		expect(result.source).toBe('none');
	});

	it('respects a higher threshold to suppress small lateness', () => {
		const result = classifyWorklog(
			{
				started: '2025-09-28T10:00:00.000Z',
				created: '2025-10-02T11:00:00.000Z',
			},
			{ thresholdDays: 7 },
		);

		expect(result.source).toBe('jira-native');
		expect(result.daysLate).toBe(4);
		expect(result.isBackdated).toBe(false);
	});

	it('does not flag a same-evening log in a negative-offset TZ crossing a month boundary (ADA-457/463)', () => {
		// Author in -0300 logs at 23:30 on Oct 31 (their wall clock). Jira stores
		// `created` shortly after but serialises it in UTC: 2025-11-01T02:35:00Z.
		// Slicing created's own prefix gives 2025-11-01 (UTC day) vs started day
		// 2025-10-31 — a spurious cross-month "jira-native" backdate. Re-basing
		// created onto started's -0300 frame yields 2025-10-31 for both.
		const result = classifyWorklog({
			started: '2025-10-31T23:30:00.000-0300',
			created: '2025-11-01T02:35:00.000Z',
		});

		expect(result.source).toBe('none');
		expect(result.isBackdated).toBe(false);
		expect(result.loggedOn).toBe('2025-10-31');
		expect(result.intendedFor).toBe('2025-10-31');
	});

	it('still flags a genuine cross-month backdate when offsets are accounted for', () => {
		// started Sep 28 (-0300 wall clock), created Oct 2 — a real late entry.
		const result = classifyWorklog({
			started: '2025-09-28T10:00:00.000-0300',
			created: '2025-10-02T10:00:00.000-0300',
		});

		expect(result.source).toBe('jira-native');
		expect(result.isBackdated).toBe(true);
		expect(result.intendedFor).toBe('2025-09-28');
		expect(result.loggedOn).toBe('2025-10-02');
	});

	it('accepts custom comment patterns', () => {
		const result = classifyWorklog(
			{
				started: '2025-10-05T10:00:00.000Z',
				created: '2025-10-05T10:00:00.000Z',
				comment: 'Refers to: 2025/09/20',
			},
			{ commentPatterns: [/Refers to:\s*(\d{4})\/(\d{2})\/(\d{2})/] },
		);

		expect(result.source).toBe('comment');
		expect(result.intendedFor).toBe('2025-09-20');
	});
});
