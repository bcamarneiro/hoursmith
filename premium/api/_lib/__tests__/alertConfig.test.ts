/**
 * Tests for the alerting settings environment configuration (ADA-691).
 *
 * Pure config resolution — no network. Exercises defaults, env overrides, the
 * schema wiring, and fail-fast errors for invalid values.
 */

import { describe, expect, it } from 'vitest';

import {
	AlertConfigError,
	ALERT_SETTINGS_DEFAULTS,
	ALERT_SETTINGS_SCHEMA,
	parseAlertSettings,
	type AlertSettings,
} from '../alertConfig.js';

describe('ALERT_SETTINGS_SCHEMA', () => {
	it('covers every AlertSettings field exactly once', () => {
		const keys = ALERT_SETTINGS_SCHEMA.map((entry) => entry.key).sort();
		expect(keys).toEqual(
			(Object.keys(ALERT_SETTINGS_DEFAULTS) as (keyof AlertSettings)[]).sort(),
		);
	});

	it('gives every int entry a numeric minimum', () => {
		for (const entry of ALERT_SETTINGS_SCHEMA) {
			if (entry.kind === 'int') {
				expect(entry.min).toBeTypeOf('number');
			}
		}
	});
});

describe('parseAlertSettings', () => {
	it('returns the defaults when no alert vars are set', () => {
		expect(parseAlertSettings({})).toEqual(ALERT_SETTINGS_DEFAULTS);
	});

	it('treats empty strings as unset', () => {
		expect(
			parseAlertSettings({
				ALERT_MIN_FAILURES: '',
				ALERT_ERROR_PATTERNS: '',
				ALERT_EMAIL_TO: '',
			}),
		).toEqual(ALERT_SETTINGS_DEFAULTS);
	});

	it('applies valid env overrides', () => {
		const settings = parseAlertSettings({
			ALERT_MIN_FAILURES: '5',
			ALERT_WINDOW_MS: '60000',
			ALERT_COOLDOWN_MS: '30000',
			ALERT_ERROR_PATTERNS: 'ECONNRESET, timeout',
			ALERT_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T1/B2/x',
			ALERT_EMAIL_TO: 'ops@hoursmith.dev, oncall@hoursmith.dev',
			ALERT_EMAIL_WEBHOOK_URL: 'https://mail.hoursmith.dev/send',
		});
		expect(settings).toEqual({
			minFailures: 5,
			windowMs: 60_000,
			cooldownMs: 30_000,
			errorPatterns: ['ECONNRESET', 'timeout'],
			slackWebhookUrl: 'https://hooks.slack.com/services/T1/B2/x',
			emailRecipients: ['ops@hoursmith.dev', 'oncall@hoursmith.dev'],
			emailWebhookUrl: 'https://mail.hoursmith.dev/send',
		});
	});

	it('rejects a non-integer minFailures', () => {
		expect(() => parseAlertSettings({ ALERT_MIN_FAILURES: 'many' })).toThrow(
			AlertConfigError,
		);
	});

	it('rejects a minFailures below the minimum', () => {
		expect(() => parseAlertSettings({ ALERT_MIN_FAILURES: '0' })).toThrow(
			'ALERT_MIN_FAILURES must be an integer >= 1',
		);
	});

	it('rejects an uncompilable error pattern', () => {
		expect(() =>
			parseAlertSettings({ ALERT_ERROR_PATTERNS: 'ECONNRESET,[' }),
		).toThrow('ALERT_ERROR_PATTERNS contains an invalid pattern "["');
	});

	it('rejects an invalid email recipient', () => {
		expect(() =>
			parseAlertSettings({ ALERT_EMAIL_TO: 'ops@hoursmith.dev,not-an-email' }),
		).toThrow('ALERT_EMAIL_TO contains an invalid email "not-an-email"');
	});

	it('accepts regex special characters in error patterns', () => {
		const settings = parseAlertSettings({
			ALERT_ERROR_PATTERNS: '503 Service Unavailable, timeout.*504',
		});
		expect(settings.errorPatterns).toEqual([
			'503 Service Unavailable',
			'timeout.*504',
		]);
	});
});
