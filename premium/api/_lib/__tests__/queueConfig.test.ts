/**
 * Tests for the queue settings environment configuration (ADA-722).
 *
 * Pure config resolution — no network, no BullMQ. Exercises defaults, env
 * overrides, the schema wiring, and fail-fast errors for invalid values.
 */

import { describe, expect, it } from 'vitest';

import {
	QueueConfigError,
	QUEUE_SETTINGS_DEFAULTS,
	QUEUE_SETTINGS_SCHEMA,
	parseQueueSettings,
	type QueueSettings,
} from '../queueConfig.js';

describe('QUEUE_SETTINGS_SCHEMA', () => {
	it('covers every QueueSettings field exactly once', () => {
		const keys = QUEUE_SETTINGS_SCHEMA.map((entry) => entry.key).sort();
		expect(keys).toEqual(
			(Object.keys(QUEUE_SETTINGS_DEFAULTS) as (keyof QueueSettings)[]).sort(),
		);
	});

	it('gives every int entry a numeric minimum', () => {
		for (const entry of QUEUE_SETTINGS_SCHEMA) {
			if (entry.kind === 'int') {
				expect(entry.min).toBeTypeOf('number');
			}
		}
	});
});

describe('parseQueueSettings', () => {
	it('returns the defaults when no queue vars are set', () => {
		expect(parseQueueSettings({})).toEqual(QUEUE_SETTINGS_DEFAULTS);
	});

	it('treats empty strings as unset', () => {
		expect(
			parseQueueSettings({
				QUEUE_JOB_ATTEMPTS: '',
				QUEUE_JOB_BACKOFF_DELAY_MS: '',
			}),
		).toEqual(QUEUE_SETTINGS_DEFAULTS);
	});

	it('applies valid env overrides', () => {
		const settings = parseQueueSettings({
			QUEUE_JOB_ATTEMPTS: '5',
			QUEUE_JOB_BACKOFF_TYPE: 'fixed',
			QUEUE_JOB_BACKOFF_DELAY_MS: '1000',
			QUEUE_JOB_REMOVE_ON_COMPLETE_AGE_S: '60',
			QUEUE_JOB_REMOVE_ON_COMPLETE_COUNT: '10',
			QUEUE_JOB_REMOVE_ON_FAIL_AGE_S: '120',
			QUEUE_JOB_REMOVE_ON_FAIL_COUNT: '20',
		});
		expect(settings).toEqual({
			attempts: 5,
			backoffType: 'fixed',
			backoffDelayMs: 1_000,
			removeOnCompleteAgeS: 60,
			removeOnCompleteCount: 10,
			removeOnFailAgeS: 120,
			removeOnFailCount: 20,
		});
	});

	it('rejects a non-integer attempts value', () => {
		expect(() => parseQueueSettings({ QUEUE_JOB_ATTEMPTS: '3.5' })).toThrow(
			QueueConfigError,
		);
	});

	it('rejects an attempts value below the minimum', () => {
		expect(() => parseQueueSettings({ QUEUE_JOB_ATTEMPTS: '0' })).toThrow(
			/QUEUE_JOB_ATTEMPTS must be an integer >= 1/,
		);
	});

	it('rejects a negative delay', () => {
		expect(() =>
			parseQueueSettings({ QUEUE_JOB_BACKOFF_DELAY_MS: '-1' }),
		).toThrow(QueueConfigError);
	});

	it('rejects an unknown backoff type', () => {
		expect(() =>
			parseQueueSettings({ QUEUE_JOB_BACKOFF_TYPE: 'linear' }),
		).toThrow(/QUEUE_JOB_BACKOFF_TYPE must be "fixed" or "exponential"/);
	});

	it('names the offending env var in the error', () => {
		try {
			parseQueueSettings({ QUEUE_JOB_REMOVE_ON_FAIL_COUNT: 'abc' });
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(QueueConfigError);
			expect((error as Error).message).toContain(
				'QUEUE_JOB_REMOVE_ON_FAIL_COUNT',
			);
		}
	});

	it('keeps defaults for vars not present in the schema', () => {
		const settings = parseQueueSettings({
			QUEUE_JOB_ATTEMPTS: '7',
			UNRELATED_VAR: 'should be ignored',
		});
		expect(settings.attempts).toBe(7);
		expect(settings.removeOnCompleteAgeS).toBe(
			QUEUE_SETTINGS_DEFAULTS.removeOnCompleteAgeS,
		);
	});
});
