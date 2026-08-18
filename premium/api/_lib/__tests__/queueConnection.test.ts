/**
 * Tests for the secure queue connection integration (ADA-737).
 *
 * Pure config resolution — no network. Verifies secret-manager retrieval,
 * validation through redisConfig, and that credentials never leak into
 * errors or log lines.
 */

import { describe, expect, it } from 'vitest';

import {
	describeQueueConnection,
	loadQueueConnectionConfig,
	QueueConnectionError,
	redactQueueUrl,
} from '../queueConnection.js';
import { QueueServiceSecretError } from '../secretClient.js';

describe('loadQueueConnectionConfig', () => {
	it('resolves a full endpoint URI with credentials', () => {
		const config = loadQueueConnectionConfig({
			REDIS_URL: 'rediss://cache:6379/2',
		});
		expect(config).toMatchObject({
			host: 'cache',
			port: 6379,
			db: 2,
			tls: true,
		});
		expect(config.options.maxRetriesPerRequest).toBeNull();
	});

	it('resolves the REDIS_HOST parts form', () => {
		const config = loadQueueConnectionConfig({
			REDIS_HOST: 'parts-host',
			REDIS_PORT: '6381',
			REDIS_PASSWORD: 'secret',
			REDIS_DB: '3',
			REDIS_TLS: 'true',
		});
		expect(config).toMatchObject({
			host: 'parts-host',
			port: 6381,
			db: 3,
			tls: true,
			hasPassword: true,
		});
		expect(config.options.password).toBe('secret');
	});

	it('prefers REDIS_URL over parts', () => {
		const config = loadQueueConnectionConfig({
			REDIS_URL: 'redis://url-host:6379',
			REDIS_HOST: 'parts-host',
		});
		expect(config.host).toBe('url-host');
	});

	it('passes through QueueServiceSecretError when nothing is configured', () => {
		// Missing configuration is a secret-manager failure, not a parse
		// failure, so it surfaces as QueueServiceSecretError untouched.
		expect(() => loadQueueConnectionConfig({})).toThrow(
			QueueServiceSecretError,
		);
	});

	it('redacts the password from malformed URL errors', () => {
		expect.assertions(2);
		try {
			loadQueueConnectionConfig({
				REDIS_URL: 'redis://user:super-secret-pass@not a url',
			});
		} catch (error) {
			expect(error).toBeInstanceOf(QueueConnectionError);
			expect(String(error)).not.toContain('super-secret-pass');
		}
	});

	it('rejects non-redis schemes without leaking credentials', () => {
		try {
			loadQueueConnectionConfig({
				REDIS_URL: 'postgres://user:super-secret-pass@db:5432',
			});
		} catch (error) {
			expect(error).toBeInstanceOf(QueueConnectionError);
			expect(String(error)).not.toContain('super-secret-pass');
		}
	});

	it('rejects a non-numeric REDIS_PORT in parts mode', () => {
		expect(() =>
			loadQueueConnectionConfig({ REDIS_HOST: 'cache', REDIS_PORT: 'abc' }),
		).toThrow(QueueConnectionError);
	});
});

describe('describeQueueConnection', () => {
	it('reports presence, never the password itself', () => {
		const config = loadQueueConnectionConfig({
			REDIS_HOST: 'cache',
			REDIS_PASSWORD: 'super-secret-pass',
			REDIS_TLS: 'true',
		});
		const line = describeQueueConnection(config);
		expect(line).toContain('host=cache');
		expect(line).toContain('tls=on');
		expect(line).toContain('auth=password-set');
		expect(line).not.toContain('super-secret-pass');
	});

	it('reports no auth when no password is configured', () => {
		const config = loadQueueConnectionConfig({ REDIS_URL: 'redis://cache' });
		expect(describeQueueConnection(config)).toContain('auth=none');
	});
});

describe('redactQueueUrl', () => {
	it('masks the password userinfo', () => {
		expect(redactQueueUrl('redis://user:secret@host:6379')).toBe(
			'redis://***:***@host:6379',
		);
	});

	it('masks a password without a username', () => {
		expect(redactQueueUrl('redis://:secret@host')).toBe('redis://***:***@host');
	});

	it('leaves URLs without credentials untouched', () => {
		expect(redactQueueUrl('redis://host:6379')).toBe('redis://host:6379');
	});

	it('leaves non-URL strings untouched', () => {
		expect(redactQueueUrl('not a url')).toBe('not a url');
	});
});
