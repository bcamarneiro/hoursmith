// @vitest-environment node
/**
 * Tests for the runWorker CLI (ADA-696).
 *
 * The `fail()` helper calls `process.exit`, which would kill the runner —
 * `process.exit` is stubbed per test to throw a sentinel error, so `fail()`
 * behaves like its `never` return type and the exit code can be asserted via
 * the thrown message. `main()` is guarded by an is-main check in runWorker.ts
 * so importing the module for tests does not boot a worker.
 */
import * as path from 'node:path';

import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	loadWorkerProcessor,
	parseRunWorkerArgs,
} from '../runWorker.js';

const PROCESSOR_FIXTURE = path.join(
	__dirname,
	'fixtures',
	'processor.fixture.mjs',
);
const NAMED_FIXTURE = path.join(__dirname, 'fixtures', 'named.fixture.mjs');

let exitSpy: MockInstance<typeof process.exit>;

beforeEach(() => {
	exitSpy = vi
		.spyOn(process, 'exit')
		.mockImplementation((code: number | string | null | undefined): never => {
			throw new Error(`exit(${code})`);
		});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('parseRunWorkerArgs', () => {
	it('applies defaults', () => {
		const options = parseRunWorkerArgs(['--processor', PROCESSOR_FIXTURE]);

		expect(options).toEqual({
			queue: 'raw-commits',
			processor: PROCESSOR_FIXTURE,
			concurrency: 1,
			shutdownTimeoutMs: 30_000,
			help: false,
		});
	});

	it('parses explicit flags', () => {
		const options = parseRunWorkerArgs([
			'--queue',
			'parsed-commits',
			'--processor',
			PROCESSOR_FIXTURE,
			'--concurrency',
			'4',
			'--shutdown-timeout-ms',
			'9000',
		]);

		expect(options).toEqual({
			queue: 'parsed-commits',
			processor: PROCESSOR_FIXTURE,
			concurrency: 4,
			shutdownTimeoutMs: 9_000,
			help: false,
		});
	});

	it('supports --help without a processor', () => {
		const options = parseRunWorkerArgs(['--help']);
		expect(options.help).toBe(true);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('rejects an unknown flag', () => {
		expect(() =>
			parseRunWorkerArgs(['--processor', PROCESSOR_FIXTURE, '--bogus']),
		).toThrow('exit(1)');
	});

	it('rejects a missing flag value', () => {
		expect(() =>
			parseRunWorkerArgs(['--processor', PROCESSOR_FIXTURE, '--concurrency']),
		).toThrow('exit(1)');
	});

	it('rejects a non-positive concurrency', () => {
		expect(() =>
			parseRunWorkerArgs(['--processor', PROCESSOR_FIXTURE, '--concurrency', '0']),
		).toThrow('exit(1)');
	});

	it('rejects a non-numeric shutdown timeout', () => {
		expect(() =>
			parseRunWorkerArgs([
				'--processor',
				PROCESSOR_FIXTURE,
				'--shutdown-timeout-ms',
				'fast',
			]),
		).toThrow('exit(1)');
	});
});

describe('loadWorkerProcessor', () => {
	it('loads the default export', async () => {
		const processor = await loadWorkerProcessor(PROCESSOR_FIXTURE);
		expect(processor).toBeTypeOf('function');
	});

	it('loads a named `processor` export', async () => {
		const processor = await loadWorkerProcessor(NAMED_FIXTURE);
		expect(processor).toBeTypeOf('function');
	});

	it('exits 1 when the module cannot be loaded', async () => {
		await expect(
			loadWorkerProcessor('/nonexistent/does-not-exist.mjs'),
		).rejects.toThrow('exit(1)');
	});
});
