/**
 * Queue connection integration wrapper (ADA-731).
 *
 * Single secure entry point that loads the queue's Redis URL and credentials
 * from the secrets backend (Vercel encrypted env vars, see `docs/privacy.md`)
 * and validates the format before any BullMQ queue/worker touches the network.
 *
 *  - Loads `REDIS_URL` (full connection string, preferred) or the `REDIS_HOST`
 *    parts (`REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB` / `REDIS_TLS`)
 *    straight from the secrets-managed environment. Nothing here hardcodes a
 *    credential or falls back to a default.
 *  - Validates the format through `redisConfig`: the scheme must be `redis://`
 *    or `rediss://`, ports and DB indexes must be non-negative integers, and
 *    the TLS flag is boolean. Invalid configuration throws
 *    `QueueConnectionError` naming the offending variable — never echoing a
 *    credential value.
 *  - `describeQueueConnection()` returns a logging-safe summary with the
 *    password redacted, so operators can confirm which Redis a worker points
 *    at without leaking secrets into logs or error tracking.
 *
 * Format parsing (URL → ioredis options) stays in `redisConfig.js`; this
 * module only loads the raw values, validates them, and presents a redacted
 * view.
 */

import type { RedisOptions } from 'ioredis';

import {
	type RedisEnv,
	RedisConfigError,
	redisOptions,
	redisOptionsFromUrl,
} from './redisConfig.js';

export class QueueConnectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'QueueConnectionError';
	}
}

/** Validated queue connection as resolved from the secrets backend. */
export interface QueueConnectionConfig {
	/** Redis host. */
	host: string;
	/** Redis port (defaults to 6379 when not specified). */
	port: number;
	/** Logical Redis DB index (`/N` path or `REDIS_DB`); absent means default. */
	db?: number;
	/** Whether the connection uses TLS (`rediss://` or `REDIS_TLS=true`). */
	tls: boolean;
	/** Whether the connection authenticates with a password. */
	hasPassword: boolean;
	/** Validated ioredis options ready for BullMQ. */
	options: RedisOptions;
}

/**
 * Mask the password portion of a `redis://` / `rediss://` URL for safe
 * logging. Falls back to a credential-masked snippet when the URL is not
 * parseable, so error paths never echo raw credentials.
 */
export function redactQueueUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.password) {
			parsed.password = '***';
		}
		return parsed.toString();
	} catch {
		const masked = url.replace(/\/\/[^:@/\s]*:[^@/\s]*/, '//***:***');
		return `<unparseable-url: "${masked}">`;
	}
}

function toConfig(options: RedisOptions): QueueConnectionConfig {
	return {
		host: options.host ?? 'localhost',
		port: options.port ?? 6379,
		db: options.db,
		tls: options.tls !== undefined,
		hasPassword: options.password !== undefined,
		options,
	};
}

/**
 * Load the queue's Redis URL and credentials from the secrets-managed
 * environment and validate the format. Prefers `REDIS_URL`; falls back to the
 * `REDIS_HOST` parts form. Throws `QueueConnectionError` when neither is
 * configured or when either form fails validation — a misconfigured deploy
 * fails loudly instead of connecting to the wrong store.
 */
export function loadQueueConnectionConfig(
	env: RedisEnv = process.env,
): QueueConnectionConfig {
	const url = env.REDIS_URL;
	if (url) {
		try {
			return toConfig(redisOptionsFromUrl(url));
		} catch (error) {
			if (error instanceof RedisConfigError) {
				// redisConfig errors may embed the raw URL (and thus the
				// password); redact before they reach logs / error tracking.
				const redacted = error.message.split(url).join(redactQueueUrl(url));
				throw new QueueConnectionError(redacted);
			}
			throw new QueueConnectionError(redactQueueUrl(String(error)));
		}
	}

	const host = env.REDIS_HOST;
	if (host) {
		try {
			return toConfig(redisOptions(env));
		} catch (error) {
			if (error instanceof RedisConfigError) {
				throw new QueueConnectionError(error.message);
			}
			throw new QueueConnectionError(redactQueueUrl(String(error)));
		}
	}

	throw new QueueConnectionError(
		'Missing queue connection configuration. Set REDIS_URL (redis:// or rediss://) ' +
			'or REDIS_HOST (plus REDIS_PORT/REDIS_PASSWORD/REDIS_DB/REDIS_TLS as needed).',
	);
}

/**
 * Human-readable, logging-safe description of a validated connection. The
 * password is never included — only whether one is set.
 */
export function describeQueueConnection(config: QueueConnectionConfig): string {
	const protocol = config.tls ? 'rediss' : 'redis';
	const db = config.db !== undefined ? `/${config.db}` : '';
	const features = [
		...(config.tls ? ['TLS'] : []),
		config.hasPassword ? 'password set' : 'no password',
	];
	return `${protocol}://${config.host}:${config.port}${db} (${features.join(', ')})`;
}
