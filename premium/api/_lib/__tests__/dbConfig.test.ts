/**
 * Tests for the postgres pool settings environment configuration (ADA-738).
 *
 * Pure config resolution — no network, no `pg`. Exercises per-environment
 * defaults, env overrides, the schema wiring, and fail-fast errors for invalid
 * values.
 */

import { describe, expect, it } from 'vitest';

import {
	parseDatabaseUrl,
	parsePoolSettings,
	POOL_ENV_DEFAULTS,
	POOL_SETTINGS_SCHEMA,
	PoolConfigError,
	resolvePoolEnvName,
	type PoolSettings,
} from '../dbConfig.js';

describe('POOL_SETTINGS_SCHEMA', () => {
	it('covers every PoolSettings field exactly once', () => {
		const keys = POOL_SETTINGS_SCHEMA.map((entry) => entry.key).sort();
		expect(keys).toEqual(
			(
				Object.keys(POOL_ENV_DEFAULTS.production) as (keyof PoolSettings)[]
			).sort(),
		);
	});

	it('gives every int entry a numeric minimum', () => {
		for (const entry of POOL_SETTINGS_SCHEMA) {
			if (entry.kind === 'int') {
				expect(entry.min).toBeTypeOf('number');
			}
		}
	});
});

describe('resolvePoolEnvName', () => {
	it('maps production, test, and anything else', () => {
		expect(resolvePoolEnvName({ NODE_ENV: 'production' })).toBe('production');
		expect(resolvePoolEnvName({ NODE_ENV: 'test' })).toBe('test');
		expect(resolvePoolEnvName({ NODE_ENV: 'development' })).toBe('development');
		expect(resolvePoolEnvName({ NODE_ENV: 'staging' })).toBe('development');
		expect(resolvePoolEnvName({})).toBe('development');
	});
});

describe('parsePoolSettings', () => {
	it('returns the production defaults for a production env', () => {
		expect(parsePoolSettings({ NODE_ENV: 'production' })).toEqual(
			POOL_ENV_DEFAULTS.production,
		);
	});

	it('returns the test defaults for a test env', () => {
		expect(parsePoolSettings({ NODE_ENV: 'test' })).toEqual(
			POOL_ENV_DEFAULTS.test,
		);
	});

	it('returns the development defaults when no env is set', () => {
		expect(parsePoolSettings({})).toEqual(POOL_ENV_DEFAULTS.development);
	});

	it('treats empty strings as unset', () => {
		expect(
			parsePoolSettings({ NODE_ENV: 'production', PGPOOL_MAX: '' }),
		).toEqual(POOL_ENV_DEFAULTS.production);
	});

	it('applies valid env overrides', () => {
		const settings = parsePoolSettings({
			NODE_ENV: 'production',
			PGPOOL_MAX: '20',
			PGPOOL_MIN: '2',
			PGPOOL_IDLE_TIMEOUT_MS: '60000',
			PGPOOL_CONNECTION_TIMEOUT_MS: '5000',
			PGPOOL_QUERY_TIMEOUT_MS: '30000',
			PGPOOL_HEALTHCHECK_ENABLED: 'false',
			PGPOOL_HEALTHCHECK_TIMEOUT_MS: '10000',
		});
		expect(settings).toEqual({
			max: 20,
			min: 2,
			idleTimeoutMs: 60_000,
			connectionTimeoutMs: 5_000,
			queryTimeoutMs: 30_000,
			healthCheckEnabled: false,
			healthCheckTimeoutMs: 10_000,
		});
	});

	it('rejects a non-integer max value', () => {
		expect(() => parsePoolSettings({ PGPOOL_MAX: '10.5' })).toThrow(
			PoolConfigError,
		);
	});

	it('rejects a max value below the minimum', () => {
		expect(() => parsePoolSettings({ PGPOOL_MAX: '0' })).toThrow(
			/PGPOOL_MAX must be an integer >= 1/,
		);
	});

	it('rejects a negative idle timeout', () => {
		expect(() => parsePoolSettings({ PGPOOL_IDLE_TIMEOUT_MS: '-1' })).toThrow(
			/PGPOOL_IDLE_TIMEOUT_MS must be an integer >= 0/,
		);
	});

	it('rejects a non-boolean health check flag', () => {
		expect(() =>
			parsePoolSettings({ PGPOOL_HEALTHCHECK_ENABLED: 'yes' }),
		).toThrow(PoolConfigError);
	});

	it('rejects min exceeding max', () => {
		expect(() =>
			parsePoolSettings({ PGPOOL_MAX: '5', PGPOOL_MIN: '6' }),
		).toThrow(/PGPOOL_MIN \(6\) cannot exceed PGPOOL_MAX \(5\)/);
	});
});

describe('parseDatabaseUrl', () => {
	it('accepts postgres:// and postgresql:// connection strings', () => {
		expect(
			parseDatabaseUrl({
				DATABASE_URL: 'postgres://user:pass@db.example:5432/hoursmith',
			}),
		).toBe('postgres://user:pass@db.example:5432/hoursmith');
		expect(
			parseDatabaseUrl({
				DATABASE_URL: 'postgresql://user:pass@db.example:5432/hoursmith',
			}),
		).toBe('postgresql://user:pass@db.example:5432/hoursmith');
	});

	it('throws when DATABASE_URL is missing', () => {
		expect(() => parseDatabaseUrl({})).toThrow(/Missing DATABASE_URL/);
	});

	it('throws when DATABASE_URL is not a URL', () => {
		expect(() => parseDatabaseUrl({ DATABASE_URL: 'not-a-url' })).toThrow(
			PoolConfigError,
		);
	});

	it('rejects non-postgres protocols', () => {
		expect(() =>
			parseDatabaseUrl({ DATABASE_URL: 'mysql://user:pass@db:3306/x' }),
		).toThrow(/must use postgres:\/\/ or postgresql:\/\//);
	});
});
