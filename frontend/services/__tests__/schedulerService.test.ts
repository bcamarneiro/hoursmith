/**
 * Tests for the Core Scheduler Service (ADA-662).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../schedulerService';
import type { JobConfig } from '../schedulerService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
	return {
		cronExpression: '0 9 * * 1-5',
		name: 'test-job',
		handler: vi.fn(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scheduler', () => {
	let scheduler: Scheduler;

	beforeEach(() => {
		scheduler = new Scheduler();
	});

	afterEach(() => {
		scheduler.stopAll();
		vi.restoreAllMocks();
	});

	// -- Registration -------------------------------------------------------

	describe('register', () => {
		it('registers a job and returns a Cron instance', () => {
			const job = scheduler.register(makeConfig());
			expect(job).toBeDefined();
			expect(typeof job.stop).toBe('function');
		});

		it('increments the job count', () => {
			expect(scheduler.count).toBe(0);
			scheduler.register(makeConfig({ name: 'a' }));
			expect(scheduler.count).toBe(1);
			scheduler.register(makeConfig({ name: 'b' }));
			expect(scheduler.count).toBe(2);
		});

		it('replaces an existing job with the same name (idempotent re-registration)', () => {
			const handler1 = vi.fn();
			const handler2 = vi.fn();
			scheduler.register(makeConfig({ name: 'dup', handler: handler1 }));
			scheduler.register(makeConfig({ name: 'dup', handler: handler2 }));
			expect(scheduler.count).toBe(1);
		});

		it('starts paused when paused = true', () => {
			scheduler.register(makeConfig({ name: 'paused-job', paused: true }));
			const status = scheduler.getJob('paused-job');
			expect(status).toBeDefined();
			expect(status!.running).toBe(false);
			expect(status!.paused).toBe(true);
		});
	});

	// -- Pause / Resume -----------------------------------------------------

	describe('pause / resume', () => {
		it('pauses a running job', () => {
			scheduler.register(makeConfig({ name: 'runnable' }));
			expect(scheduler.pause('runnable')).toBe(true);
			const status = scheduler.getJob('runnable');
			expect(status!.paused).toBe(true);
			expect(status!.running).toBe(false);
		});

		it('resumes a paused job', () => {
			scheduler.register(makeConfig({ name: 'runnable' }));
			scheduler.pause('runnable');
			expect(scheduler.resume('runnable')).toBe(true);
			const status = scheduler.getJob('runnable');
			expect(status!.running).toBe(true);
			expect(status!.paused).toBe(false);
		});

		it('returns false for a non-existent job', () => {
			expect(scheduler.pause('ghost')).toBe(false);
			expect(scheduler.resume('ghost')).toBe(false);
		});
	});

	// -- Stop ---------------------------------------------------------------

	describe('stop', () => {
		it('stops a single job and removes it from the registry', () => {
			scheduler.register(makeConfig({ name: 'to-stop' }));
			expect(scheduler.count).toBe(1);
			scheduler.stop('to-stop');
			expect(scheduler.count).toBe(0);
			expect(scheduler.getJob('to-stop')).toBeUndefined();
		});

		it('is a no-op for a non-existent job', () => {
			expect(() => scheduler.stop('ghost')).not.toThrow();
		});
	});

	// -- stopAll ------------------------------------------------------------

	describe('stopAll', () => {
		it('stops every registered job', () => {
			scheduler.register(makeConfig({ name: 'a' }));
			scheduler.register(makeConfig({ name: 'b' }));
			scheduler.register(makeConfig({ name: 'c' }));
			scheduler.stopAll();
			expect(scheduler.count).toBe(0);
			expect(scheduler.getJobs()).toHaveLength(0);
		});
	});

	// -- Status queries -----------------------------------------------------

	describe('getJob / getJobs', () => {
		it('returns undefined for an unregistered name', () => {
			expect(scheduler.getJob('nope')).toBeUndefined();
		});

		it('returns the expected status shape for a registered job', () => {
			scheduler.register(makeConfig({ name: 'fetch-data', description: 'Fetches worklogs' }));
			const status = scheduler.getJob('fetch-data')!;
			expect(status.name).toBe('fetch-data');
			expect(status.description).toBe('Fetches worklogs');
			expect(status.running).toBe(true);
			expect(status.stopped).toBe(false);
			expect(status.busy).toBe(false);
			expect(status.errorCount).toBe(0);
			expect(status.lastError).toBeNull();
			expect(status.pattern).toBe('0 9 * * 1-5');
		});

		it('getJobs returns all registered jobs', () => {
			scheduler.register(makeConfig({ name: 'a' }));
			scheduler.register(makeConfig({ name: 'b' }));
			const all = scheduler.getJobs();
			expect(all).toHaveLength(2);
			expect(all.map((j) => j.name).sort()).toEqual(['a', 'b']);
		});

		it('marks a stopped job correctly', () => {
			scheduler.register(makeConfig({ name: 'to-stop' }));
			scheduler.stop('to-stop');
			// After stop the job is removed, so getJob returns undefined
			expect(scheduler.getJob('to-stop')).toBeUndefined();
		});
	});

	// -- Error handling -----------------------------------------------------

	describe('error handling', () => {
		it('tracks errorCount and lastError when the handler throws', () => {
			const error = new Error('boom');
			const handler = () => {
				throw error;
			};
			scheduler.register(makeConfig({ name: 'flaky', handler }));
			const job = scheduler.getJob('flaky')!;
			// Trigger the handler manually — the constructor callback is the one
			// that catches errors. We can reach it via the Cron instance.
			const cronInstance = scheduler.register(
				makeConfig({ name: 'flaky-2', handler }),
			);

			// Force-trigger to exercise the error path.
			try {
				// Access the internal callback via the Cron instance.
				// The callback is stored in the fn property (undocumented but stable).
				const fn = (cronInstance as unknown as { fn?: () => void }).fn;
				if (fn) fn();
			} catch {
				// Expected — the scheduler catches it internally
			}

			const status = scheduler.getJob('flaky-2')!;
			expect(status.errorCount).toBe(1);
			expect(status.lastError).toBeInstanceOf(Date);
		});

		it('calls the custom errorHandler when provided', () => {
			const error = new Error('custom');
			const onError = vi.fn();
			const handler = () => {
				throw error;
			};
			scheduler.register(makeConfig({ name: 'custom-err', handler, errorHandler: onError }));

			// Force-trigger
			const cronInstance = scheduler.register(
				makeConfig({ name: 'custom-err-2', handler, errorHandler: onError }),
			);
			const fn = (cronInstance as unknown as { fn?: () => void }).fn;
			if (fn) fn();

			expect(onError).toHaveBeenCalledTimes(1);
			expect(onError).toHaveBeenCalledWith(error, 'custom-err-2');
		});

		it('defaults to console.error when no errorHandler is given', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const handler = () => {
				throw new Error('silent');
			};
			scheduler.register(makeConfig({ name: 'no-err-handler', handler }));

			const cronInstance = scheduler.register(
				makeConfig({ name: 'no-err-handler-2', handler }),
			);
			const fn = (cronInstance as unknown as { fn?: () => void }).fn;
			if (fn) fn();

			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('catches async handler rejections via the errorHandler (ADA-662 fix)', async () => {
			const error = new Error('async-boom');
			const onError = vi.fn();
			const handler = async () => {
				throw error;
			};
			const cronInstance = scheduler.register(
				makeConfig({ name: 'async-err', handler, errorHandler: onError }),
			);
			const fn = (cronInstance as unknown as { fn?: () => Promise<void> }).fn;
			if (fn) await fn();

			expect(onError).toHaveBeenCalledTimes(1);
			expect(onError).toHaveBeenCalledWith(error, 'async-err');
		});

		it('catches async handler rejections with console.error fallback (ADA-662 fix)', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const handler = async () => {
				throw new Error('async-silent');
			};
			const cronInstance = scheduler.register(
				makeConfig({ name: 'async-no-err', handler }),
			);
			const fn = (cronInstance as unknown as { fn?: () => Promise<void> }).fn;
			if (fn) await fn();

			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});
	});

	// -- maxRuns & protect (ADA-662 regression coverage) -------------------

	describe('maxRuns', () => {
		it('propagates maxRuns to croner at construction (ADA-662 fix)', () => {
			scheduler.register(
				makeConfig({ name: 'limited', maxRuns: 3 }),
			);
			const status = scheduler.getJob('limited')!;
			// croner snapshots maxRuns at construction; runsLeft reflects it.
			// Before the fix, post-construction mutation was ignored → Infinity.
			expect(status.runsLeft).toBe(3);
		});

		it('reports runsLeft as Infinity when maxRuns is not set', () => {
			scheduler.register(makeConfig({ name: 'unlimited' }));
			const status = scheduler.getJob('unlimited')!;
			expect(status.runsLeft).toBe(Infinity);
		});
	});

	describe('protect', () => {
		it(
			'accepts protect at construction so croner tracks the promise (ADA-662 fix)',
			() => {
				const cronInstance = scheduler.register(
					makeConfig({ name: 'protected', protect: true }),
				);
				// protect is now passed at construction — verify croner accepted it.
				expect(cronInstance.options).toBeDefined();
				expect(
					(cronInstance.options as Record<string, unknown>).protect,
				).toBe(true);
			},
		);

		it(
			'protect: false is the default (not set on options)',
			() => {
				const cronInstance = scheduler.register(
					makeConfig({ name: 'unprotected' }),
				);
				expect(
					(cronInstance.options as Record<string, unknown>).protect,
				).toBeUndefined();
			},
		);
	});

	// -- Job description propagation ---------------------------------------

	describe('description propagation', () => {
		it('returns undefined description when none is provided', () => {
			scheduler.register(makeConfig({ name: 'no-desc' }));
			expect(scheduler.getJob('no-desc')!.description).toBeUndefined();
		});

		it('returns the provided description', () => {
			scheduler.register(
				makeConfig({ name: 'with-desc', description: 'Nightly data sync' }),
			);
			expect(scheduler.getJob('with-desc')!.description).toBe('Nightly data sync');
		});
	});

	// -- Singleton ----------------------------------------------------------

	describe('singleton', () => {
		it('exports a default scheduler singleton', async () => {
			const mod = await import('../schedulerService');
			expect(mod.scheduler).toBeDefined();
			expect(mod.scheduler).toBeInstanceOf(Scheduler);
		});
	});
});
