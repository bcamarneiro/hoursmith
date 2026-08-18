/**
 * Tests for the queue connection integration wrapper (ADA-731).
 *
 * Pure config resolution — no network, no BullMQ. Exercises credential
 * loading from the secrets-managed env surface, format validation, fail-loud
 * errors, and the redacted description surface.
 */

import { describe, expect, it } from 'vitest';

import {
	describeQueueConnection,
	loadQueueConnectionConfig,
	QueueConnectionError,
	redactQueueUrl,
} from '../queueConnection.js';

describe('loadQueueConnectionConfig', () => {
	it('loads and validates a redis:// URL', () => {
		const config = loadQueueConnectionConfig({
			REDIS_URL: 'redis://cache:6379/2',
		});
		expect(config).toMatchObject({
			host: 'cache',
			port: 6379,
			db: 2,
			tls: false,
			hasPassword: false,
		});
		expect(config.options.maxRetriesPerRequest).toBeNull();
	});

	it('extracts credentials from a URL', () => {
		const config = loadQueueConnectionConfig({
			REDIS_URL: 'redis://user:secret@cache:6379/0',
		});
		expect(config.hasPassword).toBe(true);
		expect(config.options.username).toBe('user');
		expect(config.options.password).toBe('secret');
	});

	it('marks rediss:// URLs as TLS', () => {
		const config = loadQueueConnectionConfig({
			REDIS_URL: 'rediss://cache:6380',
		});
		expect(config.tls).toBe(true);
		expect(config.options.tls).toEqual({});
	});

	it('loads and validates the REDIS_HOST parts form', () => {
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
		expect(config.options.maxRetriesPerRequest).toBeNull();
	});

	it('prefers REDIS_URL over the parts form', () => {
		const config = loadQueueConnectionConfig({
			REDIS_URL: 'redis://url-host:6379',
			REDIS_HOST: 'parts-host',
		});
		expect(config.host).toBe('url-host');
	});

	it('defaults the port when omitted', () => {
		const config = loadQueueConnectionConfig({ REDIS_URL: 'redis://cache' });
		expect(config.port).toBe(6379);
	});

	it('throws QueueConnectionError when neither REDIS_URL nor REDIS_HOST is set', () => {
		expect(() => loadQueueConnectionConfig({})).toThrow(QueueConnectionError);
		expect(() => loadQueueConnectionConfig({})).toThrow(/REDIS_URL|REDIS_HOST/);
	});

	it('throws QueueConnectionError on a malformed URL without echoing the password', () => {
		expect(() =>
			loadQueueConnectionConfig({
				REDIS_URL: 'redis://user:s3cr3t@cache:6379/not-a-db',
			}),
		).toThrow(QueueConnectionError);
		expect(() =>
			loadQueueConnectionConfig({
				REDIS_URL: 'redis://user:s3cr3t@cache:6379/not-a-db',
			}),
		).not.toThrow(/s3cr3t/);
	});

	it('throws QueueConnectionError on an unparseable URL without echoing it raw', () => {
		expect(() => loadQueueConnectionConfig({ REDIS_URL: 'not a url' })).toThrow(
			QueueConnectionError,
		);
		expect(() =>
			loadQueueConnectionConfig({ REDIS_URL: 'not a url' }),
		).not.toThrow(/^REDIS_URL is not a valid URL: "not a url"/);
	});

	it('throws QueueConnectionError on a non-redis protocol', () => {
		expect(() =>
			loadQueueConnectionConfig({ REDIS_URL: 'postgres://localhost' }),
		).toThrow(QueueConnectionError);
	});

	it('throws QueueConnectionError on invalid parts', () => {
		expect(() =>
			loadQueueConnectionConfig({ REDIS_HOST: 'h', REDIS_PORT: 'abc' }),
		).toThrow(QueueConnectionError);
		expect(() =>
			loadQueueConnectionConfig({ REDIS_HOST: 'h', REDIS_DB: '-1' }),
		).toThrow(QueueConnectionError);
	});
});

describe('redactQueueUrl', () => {
	it('masks the password in a parseable URL', () => {
		expect(redactQueueUrl('redis://user:secret@cache:6379/2')).toBe(
			'redis://user:***@cache:6379/2',
		);
	});

	it('leaves a URL without a password untouched', () => {
		expect(redactQueueUrl('redis://cache:6379/2')).toBe('redis://cache:6379/2');
	});

	it('masks credentials in an unparseable URL', () => {
		expect(redactQueueUrl('redis://user:secret@cache host:6379')).toBe(
			'<unparseable-url: "redis://***:***@cache host:6379">',
		);
	});
});

describe('describeQueueConnection', () => {
	it('describes a plain connection without credentials', () => {
		const config = loadQueueConnectionConfig({
			REDIS_URL: 'redis://cache:6379/2',
		});
		expect(describeQueueConnection(config)).toBe(
			'redis://cache:6379/2 (no password)',
		);
	});

	it('describes a TLS connection with a password set, never echoing it', () => {
		const config = loadQueueConnectionConfig({
			REDIS_URL: 'rediss://user:secret@cache:6380',
		});
		const description = describeQueueConnection(config);
		expect(description).toBe('rediss://cache:6380 (TLS, password set)');
		expect(description).not.toContain('secret');
	});

	it('describes the parts form', () => {
		const config = loadQueueConnectionConfig({
			REDIS_HOST: 'h',
			REDIS_PORT: '6381',
			REDIS_PASSWORD: 'secret',
			REDIS_DB: '3',
		});
		expect(describeQueueConnection(config)).toBe(
			'redis://h:6381/3 (password set)',
		);
	});
});
