/**
 * Tests for the structured JSON logger module (ADA-689).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { resolveLogLevel } from '../logger.js';

describe('resolveLogLevel', () => {
	it('uses LOG_LEVEL when set to a valid value', () => {
		expect(resolveLogLevel({ LOG_LEVEL: 'debug' })).toBe('debug');
		expect(resolveLogLevel({ LOG_LEVEL: 'info' })).toBe('info');
		expect(resolveLogLevel({ LOG_LEVEL: 'warn' })).toBe('warn');
		expect(resolveLogLevel({ LOG_LEVEL: 'error' })).toBe('error');
	});

	it('normalizes LOG_LEVEL case and whitespace', () => {
		expect(resolveLogLevel({ LOG_LEVEL: 'DEBUG' })).toBe('debug');
		expect(resolveLogLevel({ LOG_LEVEL: '  Info  ' })).toBe('info');
	});

	it('falls back to NODE_ENV-based default when LOG_LEVEL is invalid', () => {
		expect(resolveLogLevel({ LOG_LEVEL: 'verbose', NODE_ENV: 'development' })).toBe('debug');
		expect(resolveLogLevel({ LOG_LEVEL: 'trace', NODE_ENV: 'production' })).toBe('info');
		expect(resolveLogLevel({ LOG_LEVEL: '', NODE_ENV: 'test' })).toBe('info');
	});

	it('defaults to debug in development, info otherwise', () => {
		expect(resolveLogLevel({ NODE_ENV: 'development' })).toBe('debug');
		expect(resolveLogLevel({ NODE_ENV: 'production' })).toBe('info');
		expect(resolveLogLevel({ NODE_ENV: 'test' })).toBe('info');
		expect(resolveLogLevel({})).toBe('info');
	});
});

describe('logger', () => {
	const originalEnv = { ...process.env };
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// Clear env for fresh module load
		delete process.env.LOG_LEVEL;
		delete process.env.NODE_ENV;
		// Setup spies
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		// Clear module cache so each test gets a fresh logger
		vi.resetModules();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
	});

	it('outputs all levels when LOG_LEVEL=debug', async () => {
		process.env.LOG_LEVEL = 'debug';
		process.env.NODE_ENV = 'test';
		const { logger: debugLogger } = await import('../logger.js');

		debugLogger.debug('test-svc', 'debug message', { user_id: 'u1' });
		debugLogger.info('test-svc', 'info message');
		debugLogger.warn('test-svc', 'warn message');
		debugLogger.error('test-svc', 'error message');

		expect(consoleLogSpy).toHaveBeenCalledTimes(2); // debug + info
		expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

		const debugLine = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
		expect(debugLine).toMatchObject({
			level: 'debug',
			svc: 'test-svc',
			msg: 'debug message',
			user_id: 'u1',
		});
		expect(debugLine.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	it('filters out debug when LOG_LEVEL=info', async () => {
		process.env.LOG_LEVEL = 'info';
		process.env.NODE_ENV = 'test';
		vi.resetModules();
		const { logger: infoLogger } = await import('../logger.js');

		infoLogger.debug('test-svc', 'debug message');
		infoLogger.info('test-svc', 'info message');
		infoLogger.warn('test-svc', 'warn message');
		infoLogger.error('test-svc', 'error message');

		expect(consoleLogSpy).toHaveBeenCalledTimes(1); // info only
		expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
	});

	it('routes warn to console.warn and error to console.error', async () => {
		process.env.LOG_LEVEL = 'warn';
		process.env.NODE_ENV = 'test';
		vi.resetModules();
		const { logger: warnLogger } = await import('../logger.js');

		warnLogger.debug('test-svc', 'debug');
		warnLogger.info('test-svc', 'info');
		warnLogger.warn('test-svc', 'warning', { code: 'W001' });
		warnLogger.error('test-svc', 'error', { code: 'E001' });

		expect(consoleLogSpy).not.toHaveBeenCalled();
		expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

		const warnLine = JSON.parse(consoleWarnSpy.mock.calls[0][0] as string);
		expect(warnLine).toMatchObject({ level: 'warn', svc: 'test-svc', code: 'W001' });

		const errorLine = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
		expect(errorLine).toMatchObject({ level: 'error', svc: 'test-svc', code: 'E001' });
	});

	it('only outputs error when LOG_LEVEL=error', async () => {
		process.env.LOG_LEVEL = 'error';
		process.env.NODE_ENV = 'test';
		vi.resetModules();
		const { logger: errorLogger } = await import('../logger.js');

		errorLogger.debug('test-svc', 'debug');
		errorLogger.info('test-svc', 'info');
		errorLogger.warn('test-svc', 'warn');
		errorLogger.error('test-svc', 'error only');

		expect(consoleLogSpy).not.toHaveBeenCalled();
		expect(consoleWarnSpy).not.toHaveBeenCalled();
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
	});

	it('outputs structured JSON with reserved fields', async () => {
		process.env.LOG_LEVEL = 'info';
		process.env.NODE_ENV = 'test';
		vi.resetModules();
		const { logger: infoLogger } = await import('../logger.js');

		infoLogger.info('hoursmith-proxy', 'proxy request', {
			user_id: 'abc123',
			status: 200,
			path: '/api/worklogs',
		});

		expect(consoleLogSpy).toHaveBeenCalledTimes(1);
		const line = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
		expect(line).toHaveProperty('ts');
		expect(line).toHaveProperty('level', 'info');
		expect(line).toHaveProperty('svc', 'hoursmith-proxy');
		expect(line).toHaveProperty('msg', 'proxy request');
		expect(line.user_id).toBe('abc123');
		expect(line.status).toBe(200);
		expect(line.path).toBe('/api/worklogs');
	});

	it('preserves field ordering with fields spread last', async () => {
		process.env.LOG_LEVEL = 'info';
		process.env.NODE_ENV = 'test';
		vi.resetModules();
		const { logger: infoLogger } = await import('../logger.js');

		infoLogger.info('test-svc', 'test', { level: 'override' });

		const line = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
		expect(line.level).toBe('override');
	});
});
