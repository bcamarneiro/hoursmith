/**
 * Tests for the secret client adapter (ADA-737).
 *
 * Pure retrieval — never parses or connects. Verifies the canonical secret
 * keys, URL-over-parts precedence, and loud failure when nothing is set.
 */

import { describe, expect, it } from 'vitest';

import {
	getQueueServiceCredentials,
	QUEUE_SERVICE_SECRET_KEYS,
	QueueServiceSecretError,
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
	it('returns the endpoint URI when REDIS_URL is set', () => {
		expect(
			getQueueServiceCredentials({ REDIS_URL: 'redis://cache:6379/2' }),
		).toEqual({ url: 'redis://cache:6379/2' });
	});

	it('prefers REDIS_URL over REDIS_HOST parts', () => {
		expect(
			getQueueServiceCredentials({
				REDIS_URL: 'redis://url-host',
				REDIS_HOST: 'parts-host',
			}),
		).toEqual({ url: 'redis://url-host' });
	});

	it('returns the parts form when only REDIS_HOST is set', () => {
		expect(
			getQueueServiceCredentials({
				REDIS_HOST: 'parts-host',
				REDIS_PORT: '6381',
				REDIS_PASSWORD: 'secret',
				REDIS_DB: '3',
				REDIS_TLS: 'true',
			}),
		).toEqual({
			host: 'parts-host',
			port: '6381',
			password: 'secret',
			db: '3',
			tls: 'true',
		});
	});

	it('omits empty optional parts', () => {
		expect(
			getQueueServiceCredentials({
				REDIS_HOST: 'parts-host',
				REDIS_PORT: '',
				REDIS_PASSWORD: '',
			}),
		).toEqual({ host: 'parts-host' });
	});

	it('throws QueueServiceSecretError when nothing is configured', () => {
		expect(() => getQueueServiceCredentials({})).toThrow(
			QueueServiceSecretError,
		);
	});

	it('names the required secrets but never a value in the error', () => {
		try {
			getQueueServiceCredentials({
				REDIS_HOST: '',
				REDIS_PASSWORD: 'hunter2-value',
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain('REDIS_URL');
			expect(message).toContain('REDIS_HOST');
			expect(message).not.toContain('hunter2-value');
		}
	});

	it('defaults to process.env', () => {
		const original = process.env.REDIS_URL;
		process.env.REDIS_URL = 'redis://proc-env';
		try {
			expect(getQueueServiceCredentials().url).toBe('redis://proc-env');
		} finally {
			if (original === undefined) {
				delete process.env.REDIS_URL;
			} else {
				process.env.REDIS_URL = original;
			}
		}
	});
});
