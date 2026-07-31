/**
 * Tests for the postgres pool configuration surface (ADA-735).
 */

import { describe, expect, it } from 'vitest';

import {
	parseDatabaseUrl,
	parsePoolSettings,
	PoolConfigError,
	POOL_ENV_DEFAULTS,
	resolvePoolEnvName,
	toPoolConfig,
} from '../poolConfig.js';

describe('resolvePoolEnvName', () => {
	it('maps NODE_ENV to the defaults table', () => {
		expect(resolvePoolEnvName({ NODE_ENV: 'production' })).toBe('production');
		expect(resolvePoolEnvName({ NODE_ENV: 'test' })).toBe('test');
		expect(resolvePoolEnvName({ NODE_ENV: 'development' })).toBe('development');
		expect(resolvePoolEnvName({})).toBe('development');
	});
});

describe('parsePoolSettings', () => {
	it('uses per-environment defaults when no overrides are set', () => {
		const production = parsePoolSettings({ NODE_ENV: 'production' });
		expect(production).toEqual(POOL_ENV_DEFAULTS.production);
		expect(production.max).toBe(10);
		expect(production.min).toBe(0);

		const development = parsePoolSettings({ NODE_ENV: 'development' });
		expect(development).toEqual(POOL_ENV_DEFAULTS.development);
		expect(development.max).toBe(5);

		const test = parsePoolSettings({ NODE_ENV: 'test' });
		expect(test).toEqual(POOL_ENV_DEFAULTS.test);
		expect(test.max).toBe(2);
	});

	it('applies PGPOOL_* overrides on top of the defaults', () => {
		const settings = parsePoolSettings({
			NODE_ENV: 'production',
			PGPOOL_MAX: '20',
			PGPOOL_IDLE_TIMEOUT_MS: '15000',
			PGPOOL_HEALTHCHECK_ENABLED: 'false',
		});
		expect(settings.max).toBe(20);
		expect(settings.idleTimeoutMs).toBe(15_000);
		expect(settings.healthCheckEnabled).toBe(false);
		// Unset values keep their defaults.
		expect(settings.connectionTimeoutMs).toBe(10_000);
	});

	it('rejects invalid int overrides with the offending env var named', () => {
		expect(() =>
			parsePoolSettings({ NODE_ENV: 'production', PGPOOL_MAX: 'lots' }),
		).toThrow(PoolConfigError);
		expect(() =>
			parsePoolSettings({ NODE_ENV: 'production', PGPOOL_MAX: '0' }),
		).toThrow(/PGPOOL_MAX must be an integer >= 1/);
	});

	it('rejects invalid boolean overrides', () => {
		expect(() =>
			parsePoolSettings({
				NODE_ENV: 'production',
				PGPOOL_HEALTHCHECK_ENABLED: 'yes',
			}),
		).toThrow(/PGPOOL_HEALTHCHECK_ENABLED must be "true" or "false"/);
	});

	it('rejects min exceeding max', () => {
		expect(() =>
			parsePoolSettings({
				NODE_ENV: 'test',
				PGPOOL_MAX: '1',
				PGPOOL_MIN: '2',
			}),
		).toThrow(/PGPOOL_MIN \(2\) cannot exceed PGPOOL_MAX \(1\)/);
	});
});

describe('parseDatabaseUrl', () => {
	it('accepts postgres and postgresql connection strings', () => {
		expect(
			parseDatabaseUrl({
				DATABASE_URL: 'postgres://user:pass@db:5432/hoursmith',
			}),
		).toBe('postgres://user:pass@db:5432/hoursmith');
		expect(
			parseDatabaseUrl({
				DATABASE_URL: 'postgresql://user:pass@db:5432/hoursmith',
			}),
		).toBe('postgresql://user:pass@db:5432/hoursmith');
	});

	it('rejects a missing DATABASE_URL', () => {
		expect(() => parseDatabaseUrl({})).toThrow(/Missing DATABASE_URL/);
	});

	it('rejects non-postgres protocols', () => {
		expect(() =>
			parseDatabaseUrl({ DATABASE_URL: 'redis://localhost:6379' }),
		).toThrow(/must use postgres:\/\/ or postgresql:\/\//);
	});
});

describe('toPoolConfig', () => {
	it('maps env settings onto pg PoolConfig options', () => {
		const config = toPoolConfig({
			NODE_ENV: 'production',
			DATABASE_URL: 'postgres://user:pass@db:5432/hoursmith',
			PGPOOL_MAX: '6',
		});
		expect(config).toEqual({
			connectionString: 'postgres://user:pass@db:5432/hoursmith',
			max: 6,
			min: 0,
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 10_000,
			statement_timeout: 15_000,
		});
	});
});
