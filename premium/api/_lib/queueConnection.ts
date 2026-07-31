/**
 * Secure queue connection integration (ADA-737).
 *
 * Single validated entry point that connects the queue client (BullMQ
 * producers/workers) to the secret manager for its credentials and endpoint
 * URI. Retrieval goes through `secretClient` — the secrets-managed
 * environment (Vercel encrypted env vars, see `docs/privacy.md`) — and the
 * format is validated through `redisConfig` before any queue touches the
 * network:
 *
 *  - `REDIS_URL` (preferred): full endpoint URI including credentials.
 *  - `REDIS_HOST` parts: endpoint + credentials as separate secrets.
 *
 * No credential is ever hardcoded or defaulted, and error messages are
 * redacted so passwords cannot leak into logs or error tracking.
 */

import type { RedisOptions } from 'ioredis';

import {
	RedisConfigError,
	redisOptions,
	redisOptionsFromUrl,
	type RedisEnv,
} from './redisConfig.js';
import {
	getQueueServiceCredentials,
	type QueueServiceCredentials,
} from './secretClient.js';

export class QueueConnectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'QueueConnectionError';
	}
}

/** Validated, redaction-safe description of a queue connection. */
export interface QueueConnectionConfig {
	/** Endpoint host. */
	host: string;
	/** Endpoint port. */
	port: number;
	/** Logical database number, when selected. */
	db?: number;
	/** Whether TLS is enabled. */
	tls: boolean;
	/** Whether a password is configured — never the password itself. */
	hasPassword: boolean;
	/** ioredis options ready for the queue client. */
	options: RedisOptions;
}

/**
 * Mask the password (userinfo) of a connection string for logs. Leaves the
 * string untouched when there is nothing to mask, so failures remain
 * debuggable.
 */
export function redactQueueUrl(url: string): string {
	const match = /^([a-z][a-z0-9+.-]*:\/\/)[^@/]*:([^@]*)@/i.exec(url);
	if (!match) {
		return url;
	}
	return `${match[1]}***:***@${url.slice(match[0].length)}`;
}

/**
 * Render a connection as a single log-safe line. Presence is reported, never
 * the password itself.
 */
export function describeQueueConnection(config: QueueConnectionConfig): string {
	const fields = [
		`host=${config.host}`,
		`port=${config.port}`,
		`db=${config.db ?? 'default'}`,
		`tls=${config.tls ? 'on' : 'off'}`,
		`auth=${config.hasPassword ? 'password-set' : 'none'}`,
	];
	return `queue connection: ${fields.join(', ')}`;
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
 * Load and validate the queue connection from the secrets backend.
 *
 * Prefers `REDIS_URL` (full endpoint URI), falls back to the `REDIS_HOST`
 * parts form. Errors are wrapped in `QueueConnectionError` with any embedded
 * credentials redacted; `QueueServiceSecretError` (nothing configured) passes
 * through as-is.
 */
export function loadQueueConnectionConfig(
	env: RedisEnv = process.env,
): QueueConnectionConfig {
	const credentials: QueueServiceCredentials = getQueueServiceCredentials(env);

	if (credentials.url) {
		try {
			return toConfig(redisOptionsFromUrl(credentials.url));
		} catch (error) {
			if (error instanceof RedisConfigError) {
				throw new QueueConnectionError(
					error.message
						.split(credentials.url)
						.join(redactQueueUrl(credentials.url)),
				);
			}
			throw new QueueConnectionError(redactQueueUrl(String(error)));
		}
	}

	try {
		return toConfig(redisOptions(env));
	} catch (error) {
		if (error instanceof RedisConfigError) {
			throw new QueueConnectionError(redactQueueUrl(error.message));
		}
		throw new QueueConnectionError(redactQueueUrl(String(error)));
	}
}
