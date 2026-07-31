/**
 * Environment configuration interface for BullMQ queue settings (ADA-722).
 *
 * Pure configuration surface: types, env var schema, and validation for the
 * tunable queue job settings that `queueProvider` applies to every queue.
 * This module deliberately does not import BullMQ or open any connection —
 * it only turns environment variables into validated settings.
 *
 * All queue settings have defaults baked into `QUEUE_SETTINGS_DEFAULTS` and
 * can be overridden per environment via the `QUEUE_JOB_*` variables listed in
 * `QUEUE_SETTINGS_SCHEMA`. Invalid values throw `QueueConfigError` so a
 * misconfigured deploy fails loudly at startup instead of queueing with
 * surprising retry/retention behavior.
 */

export type QueueEnv = Partial<Record<string, string | undefined>>;

export class QueueConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'QueueConfigError';
	}
}

/** Validated, resolved queue settings shared by every premium queue. */
export interface QueueSettings {
	/** Total attempts per job before it is considered failed. */
	attempts: number;
	/** Backoff strategy applied between retries. */
	backoffType: 'fixed' | 'exponential';
	/** Base delay before the first retry, in milliseconds. */
	backoffDelayMs: number;
	/** Finished jobs are dropped from Redis after this many seconds. */
	removeOnCompleteAgeS: number;
	/** At most this many finished jobs are kept. */
	removeOnCompleteCount: number;
	/** Failed jobs are dropped from Redis after this many seconds. */
	removeOnFailAgeS: number;
	/** At most this many failed jobs are kept. */
	removeOnFailCount: number;
}

export const QUEUE_SETTINGS_DEFAULTS: QueueSettings = {
	attempts: 3,
	backoffType: 'exponential',
	backoffDelayMs: 5_000,
	removeOnCompleteAgeS: 3_600,
	removeOnCompleteCount: 1_000,
	removeOnFailAgeS: 86_400,
	removeOnFailCount: 1_000,
};

type QueueSettingKey = keyof QueueSettings;

/** Keys of `QueueSettings` that hold numeric values (populated by `int` entries). */
type IntSettingKeys = {
	[K in QueueSettingKey]: QueueSettings[K] extends number ? K : never;
}[QueueSettingKey];

/** Assign a validated integer to a numeric settings key. */
function assignIntSetting(
	settings: QueueSettings,
	key: IntSettingKeys,
	value: number,
): void {
	settings[key] = value;
}

interface QueueSettingSchemaEntry {
	/** Environment variable name, e.g. `QUEUE_JOB_ATTEMPTS`. */
	env: string;
	/** `QueueSettings` field this env var populates. */
	key: QueueSettingKey;
	/** Validation rule for the raw string value. */
	kind: 'int' | 'backoffType';
	/** Minimum allowed value for `int` entries (inclusive). */
	min?: number;
}

/**
 * Env var schema for queue settings. Kept as data so the wiring between env
 * names and settings is auditable and testable in one place.
 */
export const QUEUE_SETTINGS_SCHEMA: readonly QueueSettingSchemaEntry[] = [
	{ env: 'QUEUE_JOB_ATTEMPTS', key: 'attempts', kind: 'int', min: 1 },
	{ env: 'QUEUE_JOB_BACKOFF_TYPE', key: 'backoffType', kind: 'backoffType' },
	{
		env: 'QUEUE_JOB_BACKOFF_DELAY_MS',
		key: 'backoffDelayMs',
		kind: 'int',
		min: 0,
	},
	{
		env: 'QUEUE_JOB_REMOVE_ON_COMPLETE_AGE_S',
		key: 'removeOnCompleteAgeS',
		kind: 'int',
		min: 0,
	},
	{
		env: 'QUEUE_JOB_REMOVE_ON_COMPLETE_COUNT',
		key: 'removeOnCompleteCount',
		kind: 'int',
		min: 0,
	},
	{
		env: 'QUEUE_JOB_REMOVE_ON_FAIL_AGE_S',
		key: 'removeOnFailAgeS',
		kind: 'int',
		min: 0,
	},
	{
		env: 'QUEUE_JOB_REMOVE_ON_FAIL_COUNT',
		key: 'removeOnFailCount',
		kind: 'int',
		min: 0,
	},
];

/**
 * Resolve queue settings from the environment, applying `QUEUE_SETTINGS_DEFAULTS`
 * for every var that is unset or empty. Throws `QueueConfigError` on any
 * invalid value, naming the offending env var.
 */
export function parseQueueSettings(env: QueueEnv = process.env): QueueSettings {
	const settings: QueueSettings = { ...QUEUE_SETTINGS_DEFAULTS };
	for (const entry of QUEUE_SETTINGS_SCHEMA) {
		const raw = env[entry.env];
		if (raw === undefined || raw === '') {
			continue; // Unset → keep the default.
		}
		switch (entry.kind) {
			case 'int': {
				const parsed = Number(raw);
				const min = entry.min ?? 0;
				if (!Number.isInteger(parsed) || parsed < min) {
					throw new QueueConfigError(
						`${entry.env} must be an integer >= ${min}, got "${raw}".`,
					);
				}
				// Schema entries pair an int kind with a numeric key.
				assignIntSetting(settings, entry.key as IntSettingKeys, parsed);
				break;
			}
			case 'backoffType': {
				if (raw !== 'fixed' && raw !== 'exponential') {
					throw new QueueConfigError(
						`${entry.env} must be "fixed" or "exponential", got "${raw}".`,
					);
				}
				settings.backoffType = raw;
				break;
			}
		}
	}
	return settings;
}
