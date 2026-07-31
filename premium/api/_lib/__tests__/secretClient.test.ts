/**
 * Tests for the secret management client adapter (ADA-723).
 *
 * Pure retrieval from an injectable env — no network, no real secrets.
 * Exercises the canonical key names, URL/parts retrieval, fail-fast on
 * missing configuration, and credential redaction for safe error paths.
 */

import { describe, expect, it } from 'vitest';

import {
	getQueueServiceCredentials,
	QUEUE_SERVICE_SECRET_KEYS,
	QueueServiceSecretError,
	redactRedisUrl,
} from '../secretClient.js';

describe('QUEUE_SERVICE_SECRET_KEYS', () => {
	it('lists the canonical queue-service secret names', () => {
		expect(QUEUE_SERVICE_SECRET_KEYS).toEqual([
			'REDIS_URL',
			'REDIS_HOST',
			'REDIS_PORT',
			'REDIS_PASSWORD',
			'REDIS_DB',
			'REDIS_TLS',
		]);
	});
});

describe('getQueueServiceCredentials', () => {
	it('returns the REDIS_URL form when present', () => {
		const credentials = getQueueServiceCredentials({
			REDIS_URL: 'redis://user:pass@cache:6379/2',
			REDIS_HOST: 'ignored-host',
		});
		expect(credentials).toEqual({
			url: 'redis://user:pass@cache:6379/2',
		});
	});

	it('returns the parts form when REDIS_URL is absent', () => {
		const credentials = getQueueServiceCredentials({
			REDIS_HOST: 'cache',
			REDIS_PORT: '6380',
			REDIS_PASSWORD: 's3cret',
			REDIS_DB: '4',
			REDIS_TLS: 'true',
		});
		expect(credentials).toEqual({
			host: 'cache',
			port: '6380',
			password: 's3cret',
			db: '4',
			tls: 'true',
		});
	});

	it('omits optional parts that are unset', () => {
		expect(getQueueServiceCredentials({ REDIS_HOST: 'cache' })).toEqual({
			host: 'cache',
		});
	});

	it('throws QueueServiceSecretError when no credentials are configured', () => {
		expect(() => getQueueServiceCredentials({})).toThrow(
			QueueServiceSecretError,
		);
		expect(() => getQueueServiceCredentials({ REDIS_PORT: '6379' })).toThrow(
			QueueServiceSecretError,
		);
	});

	it('throws a message naming the required secrets without echoing values', () => {
		expect(() => getQueueServiceCredentials({})).toThrow(
			/REDIS_URL|REDIS_HOST/,
		);
		// Scheme hints are fine; credential values must never leak.
		expect(() => getQueueServiceCredentials({})).not.toThrow(
			/:\S+@|REDIS_PASSWORD=[^\s]|hunter2|s3cret/,
		);
	});
});

describe('redactRedisUrl', () => {
	it('masks the password portion of a connection string', () => {
		expect(redactRedisUrl('redis://user:hunter2@cache:6379/0')).toBe(
			'redis://user:***@cache:6379/0',
		);
	});

	it('leaves password-less connection strings unchanged', () => {
		expect(redactRedisUrl('redis://cache:6379')).toBe('redis://cache:6379');
	});

	it('returns a safe placeholder for unparseable input', () => {
		expect(redactRedisUrl('not a url')).toBe('<unparseable-url>');
	});
});
