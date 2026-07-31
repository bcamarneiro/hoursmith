/**
 * Tests for the Redis connection config (ADA-695).
 *
 * Pure config resolution — no network. Exercises URL parsing, env parts mode,
 * TLS handling, and the fail-fast error for missing configuration.
 */

import { describe, expect, it } from 'vitest';

import {
	RedisConfigError,
	redisOptions,
	redisOptionsFromUrl,
} from '../redisConfig.js';

describe('redisOptionsFromUrl', () => {
	it('parses a redis:// URL with port and db', () => {
		const opts = redisOptionsFromUrl('redis://cache.internal:6380/2');
		expect(opts).toMatchObject({
			host: 'cache.internal',
			port: 6380,
			db: 2,
			maxRetriesPerRequest: null,
		});
	});

	it('defaults the port to 6379 and omits db', () => {
		const opts = redisOptionsFromUrl('redis://localhost');
		expect(opts).toMatchObject({ host: 'localhost', port: 6379 });
		expect(opts.db).toBeUndefined();
	});

	it('extracts credentials and enables TLS for rediss://', () => {
		const opts = redisOptionsFromUrl('rediss://user:pass@host:6379');
		expect(opts.tls).toEqual({});
		expect(opts.username).toBe('user');
		expect(opts.password).toBe('pass');
	});

	it('rejects non-redis protocols', () => {
		expect(() => redisOptionsFromUrl('postgres://localhost')).toThrow(
			RedisConfigError,
		);
	});

	it('rejects malformed URLs', () => {
		expect(() => redisOptionsFromUrl('not a url')).toThrow(RedisConfigError);
	});

	it('rejects a non-numeric db path', () => {
		expect(() => redisOptionsFromUrl('redis://host/abc')).toThrow(
			RedisConfigError,
		);
	});
});

describe('redisOptions', () => {
	it('prefers REDIS_URL over parts', () => {
		const opts = redisOptions({
			REDIS_URL: 'redis://url-host:6379',
			REDIS_HOST: 'parts-host',
		});
		expect(opts.host).toBe('url-host');
	});

	it('builds options from REDIS_HOST parts', () => {
		const opts = redisOptions({
			REDIS_HOST: 'parts-host',
			REDIS_PORT: '6381',
			REDIS_PASSWORD: 'secret',
			REDIS_DB: '3',
		});
		expect(opts).toMatchObject({
			host: 'parts-host',
			port: 6381,
			password: 'secret',
			db: 3,
			maxRetriesPerRequest: null,
		});
	});

	it('enables TLS in parts mode via REDIS_TLS', () => {
		const opts = redisOptions({ REDIS_HOST: 'h', REDIS_TLS: 'true' });
		expect(opts.tls).toEqual({});
	});

	it('rejects a non-numeric port', () => {
		expect(() => redisOptions({ REDIS_HOST: 'h', REDIS_PORT: 'abc' })).toThrow(
			RedisConfigError,
		);
	});

	it('throws when neither REDIS_URL nor REDIS_HOST is set', () => {
		expect(() => redisOptions({})).toThrow(/REDIS_URL|REDIS_HOST/);
	});

	it('always sets maxRetriesPerRequest to null (BullMQ requirement)', () => {
		expect(
			redisOptions({ REDIS_URL: 'redis://h' }).maxRetriesPerRequest,
		).toBeNull();
		expect(redisOptions({ REDIS_HOST: 'h' }).maxRetriesPerRequest).toBeNull();
	});
});
