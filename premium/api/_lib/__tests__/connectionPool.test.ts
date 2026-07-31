/**
 * Tests for the postgres connection pool manager (ADA-735).
 *
 * `pg` is mocked at the module boundary so the tests exercise the lifecycle
 * wiring (lazy initialization, max connections, acquire/release, health
 * checks, graceful close) without a live database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('pg', () => ({
	Pool: vi.fn(),
}));

import { Pool } from 'pg';

import {
	_resetConnectionPool,
	getConnectionPool,
	PoolManager,
} from '../connectionPool.js';

const MockPool = vi.mocked(Pool);

function makePool(
	overrides: {
		query?: unknown;
		end?: unknown;
		on?: unknown;
		connect?: unknown;
	} = {},
) {
	const query = overrides.query ?? vi.fn().mockResolvedValue({ rows: [] });
	const end = overrides.end ?? vi.fn().mockResolvedValue(undefined);
	const on = overrides.on ?? vi.fn();
	const connect =
		overrides.connect ?? vi.fn().mockResolvedValue({ query, release: vi.fn() });
	return { query, end, on, connect } as unknown as Pool;
}

function makeClient() {
	return { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
}

function testEnv(extra: Record<string, string | undefined> = {}) {
	return {
		NODE_ENV: 'test',
		DATABASE_URL: 'postgres://u:p@db:5432/hoursmith',
		...extra,
	};
}

beforeEach(() => {
	MockPool.mockReset();
	MockPool.mockImplementation(() => makePool() as unknown as Pool);
	_resetConnectionPool();
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe('PoolManager initialization', () => {
	it('does not construct a pool until ensureInitialized', () => {
		const manager = new PoolManager({ env: testEnv() });
		expect(manager.isInitialized).toBe(false);
		expect(MockPool).not.toHaveBeenCalled();

		manager.ensureInitialized();
		expect(manager.isInitialized).toBe(true);
		expect(MockPool).toHaveBeenCalledTimes(1);
	});

	it('attaches an idle-client error handler so dead clients cannot crash the process', () => {
		const on = vi.fn();
		MockPool.mockImplementation(() => makePool({ on }) as unknown as Pool);
		const manager = new PoolManager({ env: testEnv() });
		manager.ensureInitialized();
		expect(on).toHaveBeenCalledWith('error', expect.any(Function));
	});

	it('returns the same pool on repeated ensureInitialized calls', () => {
		const manager = new PoolManager({ env: testEnv() });
		const first = manager.ensureInitialized();
		const second = manager.ensureInitialized();
		expect(first).toBe(second);
		expect(MockPool).toHaveBeenCalledTimes(1);
	});
});

describe('PoolManager max connections', () => {
	it('exposes the configured max without constructing a pool', () => {
		const manager = new PoolManager({ env: { NODE_ENV: 'production' } });
		expect(manager.maxConnections).toBe(10);
		expect(manager.isInitialized).toBe(false);

		const overridden = new PoolManager({
			env: { NODE_ENV: 'production', PGPOOL_MAX: '25' },
		});
		expect(overridden.maxConnections).toBe(25);
	});

	it('sizes the constructed pool from the resolved config', () => {
		const manager = new PoolManager({
			env: testEnv({ NODE_ENV: 'production', PGPOOL_MAX: '12' }),
		});
		manager.ensureInitialized();
		expect(MockPool).toHaveBeenCalledWith(expect.objectContaining({ max: 12 }));
	});
});

describe('PoolManager lifecycle: withClient', () => {
	it('acquires a client, runs the callback, and always releases', async () => {
		const client = makeClient();
		const connect = vi.fn().mockResolvedValue(client);
		MockPool.mockImplementation(() => makePool({ connect }) as unknown as Pool);
		const manager = new PoolManager({ env: testEnv() });

		const result = await manager.withClient(async (c) => {
			expect(c).toBe(client);
			return 'done';
		});

		expect(result).toBe('done');
		expect(connect).toHaveBeenCalledTimes(1);
		expect(client.release).toHaveBeenCalledTimes(1);
	});

	it('releases the client when the callback throws', async () => {
		const client = makeClient();
		const connect = vi.fn().mockResolvedValue(client);
		MockPool.mockImplementation(() => makePool({ connect }) as unknown as Pool);
		const manager = new PoolManager({ env: testEnv() });

		await expect(
			manager.withClient(async () => {
				throw new Error('query failed');
			}),
		).rejects.toThrow('query failed');
		expect(client.release).toHaveBeenCalledTimes(1);
	});

	it('does not release a client that was never acquired when connect fails', async () => {
		const connect = vi.fn().mockRejectedValue(new Error('connection refused'));
		MockPool.mockImplementation(() => makePool({ connect }) as unknown as Pool);
		const manager = new PoolManager({ env: testEnv() });

		await expect(manager.withClient(async () => 'unreachable')).rejects.toThrow(
			'connection refused',
		);
	});
});

describe('PoolManager lifecycle: health check', () => {
	it('skips the probe when health checks are disabled', async () => {
		const query = vi.fn();
		MockPool.mockImplementation(() => makePool({ query }) as unknown as Pool);
		const manager = new PoolManager({ env: testEnv() });

		const result = await manager.checkHealth();
		expect(result).toEqual({ ok: true, latencyMs: 0 });
		expect(query).not.toHaveBeenCalled();
		// No pool was needed for a disabled probe.
		expect(MockPool).not.toHaveBeenCalled();
	});

	it('probes with SELECT 1 when health checks are enabled', async () => {
		const query = vi.fn().mockResolvedValue({ rows: [] });
		MockPool.mockImplementation(() => makePool({ query }) as unknown as Pool);
		const manager = new PoolManager({
			env: testEnv({ NODE_ENV: 'production' }),
		});

		const result = await manager.checkHealth();
		expect(result.ok).toBe(true);
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(query).toHaveBeenCalledWith('SELECT 1');
	});
});

describe('PoolManager lifecycle: close', () => {
	it('drains and closes the underlying pool', async () => {
		const end = vi.fn().mockResolvedValue(undefined);
		MockPool.mockImplementation(() => makePool({ end }) as unknown as Pool);
		const manager = new PoolManager({ env: testEnv() });
		manager.ensureInitialized();

		await manager.close();
		expect(end).toHaveBeenCalledTimes(1);
		expect(manager.isInitialized).toBe(false);
	});

	it('is a no-op when never initialized', async () => {
		const manager = new PoolManager({ env: testEnv() });
		await manager.close();
		expect(MockPool).not.toHaveBeenCalled();
	});

	it('is safe to call repeatedly', async () => {
		const end = vi.fn().mockResolvedValue(undefined);
		MockPool.mockImplementation(() => makePool({ end }) as unknown as Pool);
		const manager = new PoolManager({ env: testEnv() });
		manager.ensureInitialized();

		await manager.close();
		await manager.close();
		expect(end).toHaveBeenCalledTimes(1);
	});
});

describe('getConnectionPool singleton', () => {
	it('returns the same manager across calls', () => {
		const first = getConnectionPool();
		const second = getConnectionPool();
		expect(first).toBe(second);
	});

	it('resets cleanly for fresh tests', () => {
		const first = getConnectionPool();
		_resetConnectionPool();
		expect(getConnectionPool()).not.toBe(first);
	});
});
