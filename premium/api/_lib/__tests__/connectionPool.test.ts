/**
 * Tests for the postgres connection pool provider (ADA-738).
 *
 * `pg` is mocked at the module boundary so the tests exercise the wiring
 * (config mapping, singleton behavior, health checks, graceful close) without
 * a live database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('pg', () => ({
	Pool: vi.fn(),
}));

import { Pool } from 'pg';

import {
	checkPoolHealth,
	closePool,
	createPool,
	getPool,
	PoolHealthCheckError,
	toPoolConfig,
} from '../connectionPool.js';

const MockPool = vi.mocked(Pool);

function makePool(
	overrides: { query?: unknown; end?: unknown; on?: unknown } = {},
) {
	const query = overrides.query ?? vi.fn().mockResolvedValue({ rows: [] });
	const end = overrides.end ?? vi.fn().mockResolvedValue(undefined);
	const on = overrides.on ?? vi.fn();
	return { query, end, on } as unknown as Pool;
}

beforeEach(() => {
	MockPool.mockReset();
	MockPool.mockImplementation(() => makePool() as unknown as Pool);
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe('toPoolConfig', () => {
	it('maps env settings onto pg PoolConfig options', () => {
		const config = toPoolConfig({
			NODE_ENV: 'production',
			DATABASE_URL: 'postgres://user:pass@db:5432/hoursmith',
		});
		expect(config).toEqual({
			connectionString: 'postgres://user:pass@db:5432/hoursmith',
			max: 10,
			min: 0,
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 10_000,
			statement_timeout: 15_000,
		});
	});

	it('applies PGPOOL_* overrides and development defaults', () => {
		const config = toPoolConfig({
			DATABASE_URL: 'postgres://user:pass@db:5432/hoursmith',
			PGPOOL_MAX: '3',
			PGPOOL_IDLE_TIMEOUT_MS: '5000',
		});
		expect(config).toEqual({
			connectionString: 'postgres://user:pass@db:5432/hoursmith',
			max: 3,
			min: 0,
			idleTimeoutMillis: 5_000,
			connectionTimeoutMillis: 5_000,
			statement_timeout: 15_000,
		});
	});

	it('throws when DATABASE_URL is missing', () => {
		expect(() => toPoolConfig({})).toThrow(/Missing DATABASE_URL/);
	});
});

describe('createPool', () => {
	it('constructs a pg Pool with the shared options', () => {
		const pool = createPool({
			env: {
				DATABASE_URL: 'postgres://user:pass@db:5432/hoursmith',
			},
		});
		expect(MockPool).toHaveBeenCalledTimes(1);
		expect(MockPool).toHaveBeenCalledWith(
			expect.objectContaining({
				connectionString: 'postgres://user:pass@db:5432/hoursmith',
			}),
		);
		expect(pool).toBeDefined();
	});
});

describe('getPool', () => {
	it('returns a singleton pool wired to the env', () => {
		vi.stubEnv('DATABASE_URL', 'postgres://user:pass@db:5432/hoursmith');
		MockPool.mockClear();

		const first = getPool();
		const second = getPool();

		expect(first).toBe(second);
		expect(MockPool).toHaveBeenCalledTimes(1);
		expect(first.on).toHaveBeenCalledWith('error', expect.any(Function));
	});
});

describe('checkPoolHealth', () => {
	it('runs SELECT 1 and reports latency', async () => {
		const pool = makePool({
			query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
		});
		const result = await checkPoolHealth(pool, {
			NODE_ENV: 'development',
		});
		expect(result.ok).toBe(true);
		expect(result.latencyMs).toBeTypeOf('number');
		expect(pool.query).toHaveBeenCalledWith('SELECT 1');
	});

	it('skips the probe when health checks are disabled', async () => {
		const pool = makePool();
		const result = await checkPoolHealth(pool, { NODE_ENV: 'test' });
		expect(result).toEqual({ ok: true, latencyMs: 0 });
		expect(pool.query).not.toHaveBeenCalled();
	});

	it('throws PoolHealthCheckError on timeout', async () => {
		const pool = makePool({
			query: vi.fn().mockImplementation(() => new Promise(() => {})),
		});
		await expect(
			checkPoolHealth(pool, {
				NODE_ENV: 'development',
				PGPOOL_HEALTHCHECK_TIMEOUT_MS: '20',
			}),
		).rejects.toThrow(PoolHealthCheckError);
	});

	it('propagates database errors from the probe', async () => {
		const pool = makePool({
			query: vi.fn().mockRejectedValue(new Error('connection refused')),
		});
		await expect(
			checkPoolHealth(pool, { NODE_ENV: 'development' }),
		).rejects.toThrow('connection refused');
	});
});

describe('closePool', () => {
	it('closes the pool and tolerates repeated calls', async () => {
		const pool = makePool();
		await closePool(pool);
		await closePool(pool);
		expect(pool.end).toHaveBeenCalledTimes(2);
	});

	it('tolerates null and undefined', async () => {
		await expect(closePool(null)).resolves.toBeUndefined();
		await expect(closePool(undefined)).resolves.toBeUndefined();
	});
});
