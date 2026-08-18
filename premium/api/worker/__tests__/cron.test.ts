/**
 * Tests for the cron task registry and validation (ADA-697).
 *
 * Pure logic only — no BullMQ, no Redis. Covers the pattern/timezone
 * validation and the built-in registry's structural integrity.
 */

import { describe, expect, it } from 'vitest';

import { CRON_TASKS, validateCronPattern, validateCronTasks } from '../cron.js';

describe('validateCronPattern', () => {
	it('accepts a standard 5-field pattern', () => {
		expect(validateCronPattern('*/5 * * * *')).toEqual([]);
		expect(validateCronPattern('0 2 * * 1-5')).toEqual([]);
		expect(validateCronPattern('30 4 * JAN,MAR *')).toEqual([]);
	});

	it('accepts a 6-field pattern with seconds', () => {
		expect(validateCronPattern('0 0 3 * * *')).toEqual([]);
	});

	it('rejects an empty pattern', () => {
		expect(validateCronPattern('')).not.toEqual([]);
		expect(validateCronPattern('   ')).not.toEqual([]);
	});

	it('rejects a pattern with the wrong number of fields', () => {
		expect(validateCronPattern('* * * *')).not.toEqual([]);
		expect(validateCronPattern('* * * * * * *')).not.toEqual([]);
	});

	it('rejects fields with illegal characters', () => {
		expect(validateCronPattern('*/5 * * * !')).not.toEqual([]);
		expect(validateCronPattern('*/5 * * * * :')).not.toEqual([]);
		expect(validateCronPattern('*/5 * * * * ;')).not.toEqual([]);
	});
});

describe('validateCronTasks', () => {
	it('returns no problems for a valid registry', () => {
		expect(validateCronTasks(CRON_TASKS)).toEqual([]);
	});

	it('flags duplicate ids', () => {
		const tasks = [
			{ id: 'a', queue: 'q', pattern: '* * * * *' },
			{ id: 'a', queue: 'q', pattern: '* * * * *' },
		];
		const problems = validateCronTasks(tasks);
		expect(
			problems.some((problem) => problem.includes('duplicate task id')),
		).toBe(true);
	});

	it('flags empty ids and empty queue names', () => {
		const problems = validateCronTasks([
			{ id: '', queue: '', pattern: '* * * * *' },
		]);
		expect(
			problems.some((problem) => problem.includes('non-empty string')),
		).toBe(true);
	});

	it('flags malformed patterns with the task id in context', () => {
		const problems = validateCronTasks([
			{ id: 'bad-task', queue: 'q', pattern: 'not-a-cron' },
		]);
		expect(problems.some((problem) => problem.includes('bad-task'))).toBe(true);
	});

	it('flags unknown IANA timezones', () => {
		const problems = validateCronTasks([
			{
				id: 'tz-task',
				queue: 'q',
				pattern: '* * * * *',
				timezone: 'Mars/Olympus',
			},
		]);
		expect(
			problems.some((problem) => problem.includes('unknown IANA timezone')),
		).toBe(true);
	});

	it('accepts a valid IANA timezone', () => {
		const problems = validateCronTasks([
			{
				id: 'tz-task',
				queue: 'q',
				pattern: '* * * * *',
				timezone: 'America/New_York',
			},
		]);
		expect(problems).toEqual([]);
	});
});

describe('CRON_TASKS', () => {
	it('defines at least one schedule for the raw-commits queue', () => {
		expect(CRON_TASKS.length).toBeGreaterThan(0);
		expect(CRON_TASKS[0].queue).toBe('raw-commits');
	});

	it('has unique, stable ids', () => {
		const ids = CRON_TASKS.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
