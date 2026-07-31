/**
 * Postgres connection pool configuration (ADA-738).
 *
 * Pure configuration surface: types, env var schema, and per-environment
 * defaults for the tunable `pg` pool settings that `connectionPool` applies
 * when constructing a `Pool`. This module deliberately does not import `pg`
 * or open any connection — it only turns environment variables into validated
 * settings.
 *
 * Defaults are keyed on `NODE_ENV` (`production` / `development` / `test`):
 * serverless functions keep `min` at 0 so no idle connections are held between
 * invocations, production gets the largest bounded `max`, and the test
 * environment disables health probes by default. Every value can be overridden
 * per environment via the `PGPOOL_*` variables listed in `POOL_SETTINGS_SCHEMA`.
 * Invalid values throw `PoolConfigError` so a misconfigured deploy fails loudly
 * at startup instead of connecting with surprising pool behavior.
 */

export type PoolEnv = Partial<Record<string, string | undefined>>;

export type PoolEnvName = 'production' | 'development' | 'test';

export class PoolConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PoolConfigError';
	}
}

/** Validated, resolved pool settings shared by every premium DB pool. */
export interface PoolSettings {
	/** Maximum number of clients the pool may open. */
	max: number;
	/** Minimum number of idle clients the pool keeps open. */
	min: number;
	/** A client idle longer than this is closed, in milliseconds. */
	idleTimeoutMs: number;
	/** Timeout for acquiring a new client from Postgres, in milliseconds. */
	connectionTimeoutMs: number;
	/** `statement_timeout` applied to every pooled query, in milliseconds. */
	queryTimeoutMs: number;
	/** Whether the health probe (`SELECT 1`) is active in this environment. */
	healthCheckEnabled: boolean;
	/** Per-probe timeout for the health check, in milliseconds. */
	healthCheckTimeoutMs: number;
}

/** Per-environment pool defaults. Overridable via `PGPOOL_*` env vars. */
export const POOL_ENV_DEFAULTS: Record<PoolEnvName, PoolSettings> = {
	production: {
		max: 10,
		min: 0,
		idleTimeoutMs: 30_000,
		connectionTimeoutMs: 10_000,
		queryTimeoutMs: 15_000,
		healthCheckEnabled: true,
		healthCheckTimeoutMs: 5_000,
	},
	development: {
		max: 5,
		min: 0,
		idleTimeoutMs: 30_000,
		connectionTimeoutMs: 5_000,
		queryTimeoutMs: 15_000,
		healthCheckEnabled: true,
		healthCheckTimeoutMs: 5_000,
	},
	test: {
		max: 2,
		min: 0,
		idleTimeoutMs: 1_000,
		connectionTimeoutMs: 2_000,
		queryTimeoutMs: 5_000,
		healthCheckEnabled: false,
		healthCheckTimeoutMs: 2_000,
	},
};

type PoolSettingKey = keyof PoolSettings;

/** Keys of `PoolSettings` that hold numeric values (populated by `int` entries). */
type IntSettingKeys = {
	[K in PoolSettingKey]: PoolSettings[K] extends number ? K : never;
}[PoolSettingKey];

/** Assign a validated integer to a numeric settings key. */
function assignIntSetting(
	settings: PoolSettings,
	key: IntSettingKeys,
	value: number,
): void {
	settings[key] = value;
}

/** Assign a validated boolean to the boolean settings key. */
function assignBooleanSetting(
	settings: PoolSettings,
	key: 'healthCheckEnabled',
	value: boolean,
): void {
	settings[key] = value;
}

interface PoolSettingSchemaEntry {
	/** Environment variable name, e.g. `PGPOOL_MAX`. */
	env: string;
	/** `PoolSettings` field this env var populates. */
	key: PoolSettingKey;
	/** Validation rule for the raw string value. */
	kind: 'int' | 'boolean';
	/** Minimum allowed value for `int` entries (inclusive). */
	min?: number;
}

/**
 * Env var schema for pool settings. Kept as data so the wiring between env
 * names and settings is auditable and testable in one place.
 */
export const POOL_SETTINGS_SCHEMA: readonly PoolSettingSchemaEntry[] = [
	{ env: 'PGPOOL_MAX', key: 'max', kind: 'int', min: 1 },
	{ env: 'PGPOOL_MIN', key: 'min', kind: 'int', min: 0 },
	{
		env: 'PGPOOL_IDLE_TIMEOUT_MS',
		key: 'idleTimeoutMs',
		kind: 'int',
		min: 0,
	},
	{
		env: 'PGPOOL_CONNECTION_TIMEOUT_MS',
		key: 'connectionTimeoutMs',
		kind: 'int',
		min: 0,
	},
	{
		env: 'PGPOOL_QUERY_TIMEOUT_MS',
		key: 'queryTimeoutMs',
		kind: 'int',
		min: 0,
	},
	{
		env: 'PGPOOL_HEALTHCHECK_ENABLED',
		key: 'healthCheckEnabled',
		kind: 'boolean',
	},
	{
		env: 'PGPOOL_HEALTHCHECK_TIMEOUT_MS',
		key: 'healthCheckTimeoutMs',
		kind: 'int',
		min: 0,
	},
];

/** Map `NODE_ENV` to the defaults table, defaulting to `development`. */
export function resolvePoolEnvName(env: PoolEnv = process.env): PoolEnvName {
	if (env.NODE_ENV === 'production') {
		return 'production';
	}
	if (env.NODE_ENV === 'test') {
		return 'test';
	}
	return 'development';
}

/**
 * Resolve pool settings from the environment, starting from the per-environment
 * defaults for `NODE_ENV` and applying `PGPOOL_*` overrides. Throws
 * `PoolConfigError` on any invalid value, naming the offending env var.
 */
export function parsePoolSettings(env: PoolEnv = process.env): PoolSettings {
	const settings: PoolSettings = {
		...POOL_ENV_DEFAULTS[resolvePoolEnvName(env)],
	};
	for (const entry of POOL_SETTINGS_SCHEMA) {
		const raw = env[entry.env];
		if (raw === undefined || raw === '') {
			continue; // Unset → keep the per-environment default.
		}
		switch (entry.kind) {
			case 'int': {
				const parsed = Number(raw);
				const min = entry.min ?? 0;
				if (!Number.isInteger(parsed) || parsed < min) {
					throw new PoolConfigError(
						`${entry.env} must be an integer >= ${min}, got "${raw}".`,
					);
				}
				// Schema entries pair an int kind with a numeric key.
				assignIntSetting(settings, entry.key as IntSettingKeys, parsed);
				break;
			}
			case 'boolean': {
				if (raw !== 'true' && raw !== 'false') {
					throw new PoolConfigError(
						`${entry.env} must be "true" or "false", got "${raw}".`,
					);
				}
				// Schema entries pair a boolean kind with the boolean key.
				assignBooleanSetting(
					settings,
					entry.key as 'healthCheckEnabled',
					raw === 'true',
				);
				break;
			}
		}
	}
	if (settings.min > settings.max) {
		throw new PoolConfigError(
			`PGPOOL_MIN (${settings.min}) cannot exceed PGPOOL_MAX (${settings.max}).`,
		);
	}
	return settings;
}

/**
 * Resolve and validate the Postgres connection string. `DATABASE_URL` is
 * required — there is deliberately no localhost fallback, mirroring
 * `redisConfig`: a misconfigured deploy fails loudly at startup instead of
 * churning against a database that does not exist.
 */
export function parseDatabaseUrl(env: PoolEnv = process.env): string {
	const url = env.DATABASE_URL;
	if (!url) {
		throw new PoolConfigError(
			'Missing DATABASE_URL. Set it to a postgres:// or postgresql:// connection string.',
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new PoolConfigError(`DATABASE_URL is not a valid URL: "${url}"`);
	}
	if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
		throw new PoolConfigError(
			`DATABASE_URL must use postgres:// or postgresql://, got "${parsed.protocol}//".`,
		);
	}
	return url;
}
