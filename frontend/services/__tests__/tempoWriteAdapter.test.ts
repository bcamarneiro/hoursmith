import { describe, expect, it } from 'vitest';
import { toTempoWriteInput } from '../tempoWriteService';

/**
 * The UI speaks Jira's vocabulary — `timeSpent: '1h 30m'` and a single ISO
 * `started` instant. Tempo wants seconds plus a split local date and time.
 * A wrong split here writes time to the wrong day, so the boundary cases
 * matter more than the happy path.
 */
describe('toTempoWriteInput', () => {
	it('converts a Jira duration string to seconds', () => {
		const out = toTempoWriteInput({
			issueKey: 'PAY-1',
			timeSpent: '1h 30m',
			comment: 'work',
			started: '2026-07-27T09:00:00.000+0100',
		});
		expect(out.timeSpentSeconds).toBe(5400);
	});

	it('splits started into the local date and time Tempo expects', () => {
		const out = toTempoWriteInput({
			issueKey: 'PAY-1',
			timeSpent: '1h',
			comment: 'work',
			started: '2026-07-27T09:00:00.000+0100',
		});
		expect(out.startDate).toBe('2026-07-27');
		expect(out.startTime).toBe('09:00:00');
	});

	it('keeps the wall-clock day rather than shifting it to UTC', () => {
		// 00:30 local at +02:00 is the previous day in UTC. Tempo's startDate is
		// the worker's wall clock, so converting to UTC here would move the
		// worklog to the wrong day.
		const out = toTempoWriteInput({
			issueKey: 'PAY-1',
			timeSpent: '1h',
			comment: 'work',
			started: '2026-07-27T00:30:00.000+0200',
		});
		expect(out.startDate).toBe('2026-07-27');
		expect(out.startTime).toBe('00:30:00');
	});

	it('passes the comment through as the Tempo description', () => {
		const out = toTempoWriteInput({
			issueKey: 'PAY-1',
			timeSpent: '1h',
			comment: 'fixed the thing',
			started: '2026-07-27T09:00:00.000+0100',
		});
		expect(out.description).toBe('fixed the thing');
	});

	it('defaults to midnight when started carries no time component', () => {
		const out = toTempoWriteInput({
			issueKey: 'PAY-1',
			timeSpent: '1h',
			comment: '',
			started: '2026-07-27',
		});
		expect(out.startDate).toBe('2026-07-27');
		expect(out.startTime).toBe('00:00:00');
	});
});
