/**
 * Environment configuration interface for persistent-failure alerting (ADA-691).
 *
 * Pure configuration surface: types, env var schema, and validation for the
 * thresholds and notification channels that `alerting` uses to decide when a
 * persistent (dead-lettered) queue failure warrants an alert and where to
 * deliver it. This module deliberately does not perform any network I/O — it
 * only turns environment variables into validated settings.
 *
 * All settings have defaults baked into `ALERT_SETTINGS_DEFAULTS` and can be
 * overridden per environment via the `ALERT_*` variables listed in
 * `ALERT_SETTINGS_SCHEMA`. Invalid values throw `AlertConfigError` so a
 * misconfigured deploy fails loudly at startup instead of alerting silently
 * or spamming notification channels.
 */

export type AlertEnv = Partial<Record<string, string | undefined>>;

export class AlertConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AlertConfigError';
	}
}

/** Validated, resolved alerting settings shared by every premium queue. */
export interface AlertSettings {
	/** Minimum persistent (DLQ) failures in the window before an alert fires. */
	minFailures: number;
	/** Lookback window in milliseconds over which failures are counted. */
	windowMs: number;
	/** Minimum gap in milliseconds between alerts for the same queue. */
	cooldownMs: number;
	/**
	 * Case-insensitive error patterns. A failure counts toward the threshold
	 * only when its message matches at least one pattern; an empty list
	 * matches every failure.
	 */
	errorPatterns: string[];
	/** Slack incoming-webhook URL. Empty string disables the Slack channel. */
	slackWebhookUrl: string;
	/** Recipient addresses for the email channel. Empty list disables it. */
	emailRecipients: string[];
	/** HTTP endpoint that relays an alert email. Empty disables the email channel. */
	emailWebhookUrl: string;
	/** Fetch timeout in ms for webhook POST requests (prevents stalled dispatch). */
	webhookTimeoutMs: number;
}

export const ALERT_SETTINGS_DEFAULTS: AlertSettings = {
	minFailures: 3,
	windowMs: 3_600_000,
	cooldownMs: 900_000,
	errorPatterns: [],
	slackWebhookUrl: '',
	emailRecipients: [],
	emailWebhookUrl: '',
	webhookTimeoutMs: 10_000,
};

type AlertSettingKey = keyof AlertSettings;

/** Keys of `AlertSettings` that hold numeric values (populated by `int` entries). */
type IntSettingKeys = {
	[K in AlertSettingKey]: AlertSettings[K] extends number ? K : never;
}[AlertSettingKey];

/** Assign a validated integer to a numeric settings key. */
function assignIntSetting(
	settings: AlertSettings,
	key: IntSettingKeys,
	value: number,
): void {
	settings[key] = value;
}

/** Keys of `AlertSettings` that hold plain string values. */
type StringSettingKeys = {
	[K in AlertSettingKey]: AlertSettings[K] extends string ? K : never;
}[AlertSettingKey];

interface AlertSettingSchemaEntry {
	/** Environment variable name, e.g. `ALERT_MIN_FAILURES`. */
	env: string;
	/** `AlertSettings` field this env var populates. */
	key: AlertSettingKey;
	/** Validation rule for the raw string value. */
	kind: 'int' | 'string' | 'patternList' | 'recipientList';
	/** Minimum allowed value for `int` entries (inclusive). */
	min?: number;
}

/**
 * Env var schema for alerting settings. Kept as data so the wiring between env
 * names and settings is auditable and testable in one place.
 */
export const ALERT_SETTINGS_SCHEMA: readonly AlertSettingSchemaEntry[] = [
	{ env: 'ALERT_MIN_FAILURES', key: 'minFailures', kind: 'int', min: 1 },
	{ env: 'ALERT_WINDOW_MS', key: 'windowMs', kind: 'int', min: 1 },
	{ env: 'ALERT_COOLDOWN_MS', key: 'cooldownMs', kind: 'int', min: 0 },
	{ env: 'ALERT_WEBHOOK_TIMEOUT_MS', key: 'webhookTimeoutMs', kind: 'int', min: 1 },
	{ env: 'ALERT_ERROR_PATTERNS', key: 'errorPatterns', kind: 'patternList' },
	{ env: 'ALERT_SLACK_WEBHOOK_URL', key: 'slackWebhookUrl', kind: 'string' },
	{ env: 'ALERT_EMAIL_TO', key: 'emailRecipients', kind: 'recipientList' },
	{ env: 'ALERT_EMAIL_WEBHOOK_URL', key: 'emailWebhookUrl', kind: 'string' },
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Split a comma-separated env value into trimmed, non-empty entries. */
function splitList(raw: string): string[] {
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * Resolve alerting settings from the environment, applying
 * `ALERT_SETTINGS_DEFAULTS` for every var that is unset or empty. Throws
 * `AlertConfigError` on any invalid value, naming the offending env var.
 */
export function parseAlertSettings(env: AlertEnv = process.env): AlertSettings {
	const settings: AlertSettings = { ...ALERT_SETTINGS_DEFAULTS };
	for (const entry of ALERT_SETTINGS_SCHEMA) {
		const raw = env[entry.env];
		if (raw === undefined || raw === '') {
			continue; // Unset → keep the default.
		}
		switch (entry.kind) {
			case 'int': {
				const parsed = Number(raw);
				const min = entry.min ?? 0;
				if (!Number.isInteger(parsed) || parsed < min) {
					throw new AlertConfigError(
						`${entry.env} must be an integer >= ${min}, got "${raw}".`,
					);
				}
				// Schema entries pair an int kind with a numeric key.
				assignIntSetting(settings, entry.key as IntSettingKeys, parsed);
				break;
			}
			case 'patternList': {
				for (const pattern of splitList(raw)) {
					try {
						new RegExp(pattern, 'i');
					} catch {
						throw new AlertConfigError(
							`${entry.env} contains an invalid pattern "${pattern}".`,
						);
					}
				}
				settings.errorPatterns = splitList(raw);
				break;
			}
			case 'recipientList': {
				const recipients = splitList(raw);
				for (const recipient of recipients) {
					if (!EMAIL_PATTERN.test(recipient)) {
						throw new AlertConfigError(
							`${entry.env} contains an invalid email "${recipient}".`,
						);
					}
				}
				settings.emailRecipients = recipients;
				break;
			}
			case 'string': {
				// Validate webhook URLs look like real URLs.
				if (entry.key === 'slackWebhookUrl' || entry.key === 'emailWebhookUrl') {
					try {
						const url = new URL(raw);
						if (url.protocol !== 'https:') {
							throw new AlertConfigError(
								`${entry.env} must start with https://, got "${raw}".`,
							);
						}
					} catch (e) {
						if (e instanceof AlertConfigError) throw e;
						throw new AlertConfigError(
							`${entry.env} is not a valid URL: "${raw}".`,
						);
					}
				}
				// Schema entries pair a string kind with a string key.
				settings[entry.key as StringSettingKeys] = raw;
				break;
			}
		}
	}
	return settings;
}
