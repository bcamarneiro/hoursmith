import { describe, expect, it } from 'vitest';
import {
	computeWeeklyDeadline,
	deriveOnTimeStatus,
	describeOnTimeStatus,
} from '../onTimeStatus';

describe('computeWeeklyDeadline', () => {
	it('resolves the weekday offset + time from the week Monday', () => {
		// Week of Mon 2026-03-02. Friday 18:00 → 2026-03-06 18:00 local.
		const deadline = computeWeeklyDeadline('2026-03-02', 5, '18:00');
		expect(deadline.getFullYear()).toBe(2026);
		expect(deadline.getMonth()).toBe(2); // March (0-indexed)
		expect(deadline.getDate()).toBe(6); // Friday
		expect(deadline.getHours()).toBe(18);
		expect(deadline.getMinutes()).toBe(0);
	});

	it('clamps an out-of-range weekday and defaults a bad time', () => {
		const monday = computeWeeklyDeadline('2026-03-02', 0, '18:00');
		expect(monday.getDate()).toBe(2); // clamped to Monday
		const sunday = computeWeeklyDeadline('2026-03-02', 99, '18:00');
		expect(sunday.getDate()).toBe(8); // clamped to Sunday
		const badTime = computeWeeklyDeadline('2026-03-02', 5, 'nonsense');
		expect(badTime.getHours()).toBe(18); // default 18:00
	});
});

describe('deriveOnTimeStatus', () => {
	const target = 40 * 3600;

	it('on-time when the target is met by the deadline', () => {
		expect(
			deriveOnTimeStatus({
				targetSeconds: target,
				totalSeconds: target,
				onTimeSeconds: target,
				deadlinePassed: true,
			}),
		).toBe('on-time');
	});

	it('late when complete overall but not by the deadline', () => {
		expect(
			deriveOnTimeStatus({
				targetSeconds: target,
				totalSeconds: target,
				onTimeSeconds: 30 * 3600,
				deadlinePassed: true,
			}),
		).toBe('late');
	});

	it('incomplete when short and the deadline has passed', () => {
		expect(
			deriveOnTimeStatus({
				targetSeconds: target,
				totalSeconds: 20 * 3600,
				onTimeSeconds: 20 * 3600,
				deadlinePassed: true,
			}),
		).toBe('incomplete');
	});

	it('pending when short but the deadline is still ahead', () => {
		expect(
			deriveOnTimeStatus({
				targetSeconds: target,
				totalSeconds: 20 * 3600,
				onTimeSeconds: 20 * 3600,
				deadlinePassed: false,
			}),
		).toBe('pending');
	});

	it('a zero target (full PTO week) is trivially on-time', () => {
		expect(
			deriveOnTimeStatus({
				targetSeconds: 0,
				totalSeconds: 0,
				onTimeSeconds: 0,
				deadlinePassed: true,
			}),
		).toBe('on-time');
	});
});

describe('describeOnTimeStatus', () => {
	it('maps each status to a label + tone on the worklog ramp', () => {
		expect(describeOnTimeStatus('on-time')).toEqual({
			label: 'On time',
			tone: 'success',
		});
		expect(describeOnTimeStatus('late')).toEqual({
			label: 'Late',
			tone: 'warning',
		});
		expect(describeOnTimeStatus('incomplete')).toEqual({
			label: 'Incomplete',
			tone: 'error',
		});
		expect(describeOnTimeStatus('pending')).toEqual({
			label: 'In progress',
			tone: 'neutral',
		});
	});
});
