/**
 * Secret management client adapter for the premium queue service (ADA-737).
 *
 * The queue client (BullMQ producers/workers) authenticates to Redis, and its
 * credentials are the most sensitive configuration the premium API holds.
 * This module is the single retrieval point for those credentials:
 *
 *  - The approved secrets backend is Vercel's encrypted environment-var
 *    system (see `docs/privacy.md`) — values live in `process.env`, injected
 *    at deploy time. Nothing here hardcodes a credential or falls back to
 *    one.
 *  - Consumers never read secret env keys directly; they call
 *    `getQueueServiceCredentials()`, so key names and retrieval semantics
 *    live in one documented, testable place.
 *  - Missing configuration fails loudly with `QueueServiceSecretError`, whose
 *    message names the required secrets but never echoes a value —
 *    credentials stay out of logs and error tracking.
 *
 * Parsing (URL → ioredis options, integer coercion) stays in `redisConfig.ts`;
 * this adapter only retrieves and hands over raw values.
 */

import type { RedisEnv } from './redisConfig.js';

/** Canonical secret names the queue service reads from the secrets backend. */
export const QUEUE_SERVICE_SECRET_KEYS = [
	'REDIS_URL',
	'REDIS_HOST',
	'REDIS_PORT',
	'REDIS_PASSWORD',
	'REDIS_DB',
	'REDIS_TLS',
] as const;

export type QueueServiceSecretKey = (typeof QUEUE_SERVICE_SECRET_KEYS)[number];

/** Raw queue-service credentials as retrieved from the secrets backend. */
export interface QueueServiceCredentials {
	/** Full endpoint URI (`redis://` or `rediss://`), preferred form. */
	url?: string;
	/** Endpoint host when using the parts form. */
	host?: string;
	/** Endpoint port when using the parts form. */
	port?: string;
	/** Redis password when using the parts form. */
	password?: string;
	/** Logical database number when using the parts form. */
	db?: string;
	/** TLS toggle when using the parts form (`'true'` / `'1'`). */
	tls?: string;
}

export class QueueServiceSecretError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'QueueServiceSecretError';
	}
}

/**
 * Retrieve queue-service credentials from the approved secrets backend.
 *
 * Returns the endpoint URI when `REDIS_URL` is set (preferred), otherwise the
 * `REDIS_HOST` parts form. Throws `QueueServiceSecretError` when neither is
 * configured — there is deliberately no default, so a misconfigured deploy
 * fails loudly instead of connecting to the wrong store.
 */
export function getQueueServiceCredentials(
	env: RedisEnv = process.env,
): QueueServiceCredentials {
	const url = env.REDIS_URL;
	if (url) {
		return { url };
	}

	const host = env.REDIS_HOST;
	if (host) {
		const credentials: QueueServiceCredentials = { host };
		if (env.REDIS_PORT !== undefined && env.REDIS_PORT !== '') {
			credentials.port = env.REDIS_PORT;
		}
		if (env.REDIS_PASSWORD !== undefined && env.REDIS_PASSWORD !== '') {
			credentials.password = env.REDIS_PASSWORD;
		}
		if (env.REDIS_DB !== undefined && env.REDIS_DB !== '') {
			credentials.db = env.REDIS_DB;
		}
		if (env.REDIS_TLS !== undefined && env.REDIS_TLS !== '') {
			credentials.tls = env.REDIS_TLS;
		}
		return credentials;
	}

	throw new QueueServiceSecretError(
		'Missing queue service credentials in the secrets backend. Set REDIS_URL ' +
			'(redis:// or rediss://) or REDIS_HOST (plus REDIS_PORT/REDIS_PASSWORD/' +
			'REDIS_DB/REDIS_TLS as needed).',
	);
}
