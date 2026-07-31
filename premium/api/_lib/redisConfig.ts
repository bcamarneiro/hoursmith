/**
 * Redis connection configuration for BullMQ (ADA-695).
 *
 * Every queue/worker in the premium API resolves its Redis connection through
 * this module instead of hardcoding connection strings, so all consumers share
 * one documented, testable config surface.
 *
 * Resolution precedence:
 *   1. `REDIS_URL` — a full connection string (`redis://` or `rediss://`).
 *      A path of `/2` selects logical DB 2.
 *   2. `REDIS_HOST` — plus optional `REDIS_PORT`, `REDIS_PASSWORD`,
 *      `REDIS_DB`, and `REDIS_TLS=true` for TLS in parts mode.
 *   3. Neither — `RedisConfigError` is thrown. There is deliberately no
 *      localhost fallback: a misconfigured deploy fails loudly instead of
 *      churning against a Redis that does not exist.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ's blocking commands
 * (BRPOPLPUSH); ioredis refuses to run them under the default retry budget.
 */

import type { RedisOptions } from 'ioredis';

export type RedisEnv = Partial<Record<string, string | undefined>>;

export class RedisConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RedisConfigError';
	}
}

function parseIntEnv(
	value: string | undefined,
	name: string,
): number | undefined {
	if (value === undefined || value === '') {
		return undefined;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new RedisConfigError(
			`${name} must be a non-negative integer, got "${value}".`,
		);
	}
	return parsed;
}

/** Parse a Redis URL into ioredis options. Supports a `/db` path suffix. */
export function redisOptionsFromUrl(url: string): RedisOptions {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new RedisConfigError(`REDIS_URL is not a valid URL: "${url}"`);
	}
	if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
		throw new RedisConfigError(
			`REDIS_URL must use redis:// or rediss://, got "${parsed.protocol}//".`,
		);
	}

	const options: RedisOptions = {
		host: parsed.hostname,
		port: parsed.port ? Number(parsed.port) : 6379,
		maxRetriesPerRequest: null,
	};
	if (parsed.username) {
		options.username = parsed.username;
	}
	if (parsed.password) {
		options.password = parsed.password;
	}
	if (parsed.pathname && parsed.pathname !== '/') {
		const db = Number(parsed.pathname.slice(1));
		if (!Number.isInteger(db) || db < 0) {
			throw new RedisConfigError(
				`REDIS_URL path must select a non-negative integer DB, got "${parsed.pathname}".`,
			);
		}
		options.db = db;
	}
	if (parsed.protocol === 'rediss:') {
		options.tls = {};
	}
	return options;
}

/**
 * Resolve ioredis options from the environment. Prefers `REDIS_URL`; falls
 * back to `REDIS_HOST` parts. Throws `RedisConfigError` when neither is set.
 */
export function redisOptions(env: RedisEnv = process.env): RedisOptions {
	const url = env.REDIS_URL;
	if (url) {
		return { ...redisOptionsFromUrl(url), maxRetriesPerRequest: null };
	}

	const host = env.REDIS_HOST;
	if (host) {
		const options: RedisOptions = {
			host,
			port: parseIntEnv(env.REDIS_PORT, 'REDIS_PORT') ?? 6379,
			maxRetriesPerRequest: null,
		};
		const password = env.REDIS_PASSWORD;
		if (password) {
			options.password = password;
		}
		const db = parseIntEnv(env.REDIS_DB, 'REDIS_DB');
		if (db !== undefined) {
			options.db = db;
		}
		if (env.REDIS_TLS === 'true' || env.REDIS_TLS === '1') {
			options.tls = {};
		}
		return options;
	}

	throw new RedisConfigError(
		'Missing Redis configuration. Set REDIS_URL (redis:// or rediss://) or REDIS_HOST ' +
			'(plus REDIS_PORT/REDIS_PASSWORD/REDIS_DB as needed).',
	);
}
