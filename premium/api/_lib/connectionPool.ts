/**
 * Postgres connection pool provider (ADA-738).
 *
 * Central place for pool construction so every premium API consumer agrees on
 * the connection string and the pool tuning resolved by `dbConfig`. The
 * `pg.Pool` is created with per-environment max/min sizes, idle timeouts, and
 * query timeouts; nothing here touches the network until a query actually runs.
 *
 * `getPool` lazily creates a process-wide singleton — serverless endpoints that
 * never hit the database don't pay connection setup — and attaches the idle
 * client error handler every `pg.Pool` needs so a dying idle connection can't
 * crash the process.
 */

import { Pool, type PoolConfig } from 'pg';

import {
	type PoolEnv,
	parseDatabaseUrl,
	parsePoolSettings,
} from './dbConfig.js';

export type { PoolEnv };

export interface PoolFactoryOptions {
	/** Env to resolve the pool config from; defaults to `process.env`. Tests inject here. */
	env?: PoolEnv;
}

/** Map validated `dbConfig` settings onto `pg.PoolConfig` options. */
export function toPoolConfig(env: PoolEnv = process.env): PoolConfig {
	const settings = parsePoolSettings(env);
	return {
		connectionString: parseDatabaseUrl(env),
		max: settings.max,
		min: settings.min,
		idleTimeoutMillis: settings.idleTimeoutMs,
		connectionTimeoutMillis: settings.connectionTimeoutMs,
		// `statement_timeout` aborts a hung query server-side; mirrors the
		// `queryTimeoutMs` health bar per environment.
		statement_timeout: settings.queryTimeoutMs,
	};
}

/** Build a `pg.Pool` with the shared per-environment options. */
export function createPool({ env }: PoolFactoryOptions = {}): Pool {
	return new Pool(toPoolConfig(env));
}

let sharedPool: Pool | null = null;

/**
 * Process-wide singleton for the premium database pool. Lazily created on first
 * use so endpoints that never query don't pay connection setup. The idle client
 * error handler prevents an error on a background connection from crashing the
 * process (a `pg.Pool` emits `'error'` for idle client failures).
 */
export function getPool(): Pool {
	if (!sharedPool) {
		sharedPool = createPool();
		sharedPool.on('error', (err: Error) => {
			// Log and let the pool recover by replacing the dead client.
			console.error(`[connectionPool] idle client error: ${err.message}`);
		});
	}
	return sharedPool;
}

export class PoolHealthCheckError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PoolHealthCheckError';
	}
}

export interface PoolHealthResult {
	/** `true` when the probe succeeded (or health checks are disabled). */
	ok: boolean;
	/** Round-trip latency of the probe, in milliseconds. 0 when skipped. */
	latencyMs: number;
}

/**
 * Probe the pool with `SELECT 1`, bounded by the per-environment
 * `healthCheckTimeoutMs`. Returns immediately when health checks are disabled
 * for the environment (e.g. `test`). Throws `PoolHealthCheckError` on timeout;
 * a `pg` error propagates as-is so callers can report DB availability.
 */
export async function checkPoolHealth(
	pool: Pool,
	env: PoolEnv = process.env,
): Promise<PoolHealthResult> {
	const settings = parsePoolSettings(env);
	if (!settings.healthCheckEnabled) {
		return { ok: true, latencyMs: 0 };
	}

	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new PoolHealthCheckError(
						`health check timed out after ${settings.healthCheckTimeoutMs}ms`,
					),
				),
			settings.healthCheckTimeoutMs,
		);
	});

	const startedAt = Date.now();
	try {
		await Promise.race([pool.query('SELECT 1'), timeout]);
		return { ok: true, latencyMs: Date.now() - startedAt };
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/** Gracefully close a pool. Safe to call repeatedly. */
export async function closePool(pool: Pool | null | undefined): Promise<void> {
	if (pool && typeof pool.end === 'function') {
		await pool.end();
	}
}
