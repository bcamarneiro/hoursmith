/**
 * Postgres connection pool manager (ADA-735).
 *
 * Central place for pool construction so every premium API consumer agrees on
 * the connection string and the pool tuning resolved by `poolConfig`. The
 * `PoolManager` owns the full lifecycle of a `pg.Pool`:
 *
 *   - **Initialization**: `ensureInitialized()` lazily creates a process-wide
 *     pool on first use, so serverless endpoints that never hit the database
 *     don't pay connection setup. The idle-client error handler is attached at
 *     construction so a dying background connection can't crash the process.
 *   - **Max connections**: the pool is sized from `poolConfig`'s per-environment
 *     `max`/`min` (overridable via `PGPOOL_*`), and `maxConnections` is exposed
 *     for observability and admission decisions.
 *   - **Lifecycle management**: `withClient` bounds every operation to a single
 *     acquired client and guarantees release; `checkHealth` probes the pool
 *     with `SELECT 1`; `close` drains and shuts the pool down idempotently.
 *
 * `getConnectionPool()` returns a process-wide singleton; tests construct their
 * own `PoolManager` instances with an injected env.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';

import { type PoolEnv, parsePoolSettings, toPoolConfig } from './poolConfig.js';

export type { PoolEnv };

export interface PoolManagerOptions {
	/** Env to resolve the pool config from; defaults to `process.env`. Tests inject here. */
	env?: PoolEnv;
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

export class PoolManager {
	private readonly env: PoolEnv;
	private pool: Pool | null = null;

	constructor(options: PoolManagerOptions = {}) {
		this.env = options.env ?? process.env;
	}

	/**
	 * Maximum number of clients the configured pool may open. Resolved from
	 * the environment (per-env defaults plus `PGPOOL_*` overrides) without
	 * constructing a pool.
	 */
	get maxConnections(): number {
		return parsePoolSettings(this.env).max;
	}

	/** Whether the underlying `pg.Pool` has been created yet. */
	get isInitialized(): boolean {
		return this.pool !== null;
	}

	/**
	 * Lazily create (or return the existing) process-wide pool. Attaches the
	 * idle-client error handler every `pg.Pool` needs so a dead idle
	 * connection is logged and replaced instead of crashing the process.
	 */
	ensureInitialized(): Pool {
		if (this.pool) {
			return this.pool;
		}
		const pool = new Pool(this.buildPoolConfig());
		pool.on('error', (err: Error) => {
			// Log and let the pool recover by replacing the dead client.
			console.error(`[connectionPool] idle client error: ${err.message}`);
		});
		this.pool = pool;
		return pool;
	}

	/** Resolve the `pg.PoolConfig` for this manager's env. */
	buildPoolConfig(): PoolConfig {
		return toPoolConfig(this.env);
	}

	/**
	 * Run `fn` with a single client acquired from the pool, releasing it back
	 * to the pool in a `finally` whether `fn` succeeds or throws. The caller's
	 * connection stays checked out for the shortest possible window, which
	 * keeps the pool from exhausting `maxConnections` under load.
	 */
	async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
		const pool = this.ensureInitialized();
		const client = await pool.connect();
		try {
			return await fn(client);
		} finally {
			client.release();
		}
	}

	/**
	 * Probe the pool with `SELECT 1`, bounded by the per-environment
	 * `healthCheckTimeoutMs`. Returns immediately when health checks are
	 * disabled for the environment (e.g. `test`). Throws
	 * `PoolHealthCheckError` on timeout; a `pg` error propagates as-is so
	 * callers can report DB availability.
	 */
	async checkHealth(): Promise<PoolHealthResult> {
		const settings = parsePoolSettings(this.env);
		if (!settings.healthCheckEnabled) {
			return { ok: true, latencyMs: 0 };
		}

		const pool = this.ensureInitialized();
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

	/**
	 * Gracefully close the pool, waiting for in-flight clients to be released
	 * (`pg` drains before ending). Safe to call repeatedly; after closing, the
	 * pool is reset so a later `ensureInitialized` starts fresh.
	 */
	async close(): Promise<void> {
		if (!this.pool) {
			return;
		}
		const pool = this.pool;
		this.pool = null;
		await pool.end();
	}
}

let sharedManager: PoolManager | null = null;

/**
 * Process-wide singleton for the premium database pool. Created on first use
 * and shared by every premium API consumer so connection counts stay bounded
 * by one configured `max` per runtime.
 */
export function getConnectionPool(): PoolManager {
	if (!sharedManager) {
		sharedManager = new PoolManager();
	}
	return sharedManager;
}

/** Test hook: reset the singleton so tests get a fresh manager. */
export function _resetConnectionPool(): void {
	sharedManager = null;
}
