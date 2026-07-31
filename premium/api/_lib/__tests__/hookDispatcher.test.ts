/**
 * Tests for the asynchronous hook dispatcher (ADA-741).
 *
 * Covers registration validation, asynchronous firing, promise
 * aggregation, the per-listener error boundary (sync throws, async
 * rejections, timeouts), once/unsubscribe lifecycle, and snapshot
 * semantics during dispatch.
 */

import { describe, expect, it, vi } from 'vitest';
import { HookDispatcher, hookDispatcher } from '../hookDispatcher.js';

function defer(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('registration', () => {
	it('registers listeners per hook and returns an unsubscribe function', () => {
		const dispatcher = new HookDispatcher();
		const listener = vi.fn();
		const unsubscribe = dispatcher.on('job-started', listener);

		expect(dispatcher.listenerCount('job-started')).toBe(1);
		expect(dispatcher.hasListeners('job-started')).toBe(true);

		unsubscribe();
		expect(dispatcher.listenerCount('job-started')).toBe(0);
		expect(dispatcher.off('job-started', listener)).toBe(false);
	});

	it('rejects malformed hook names with invalid-hook', () => {
		const dispatcher = new HookDispatcher();
		const listener = vi.fn();

		for (const bad of ['', 'Job', 'job started', 'job:started', 'a'.repeat(65)]) {
			expect(() => dispatcher.on(bad, listener)).toThrow(
				expect.objectContaining({ code: 'invalid-hook' }),
			);
			expect(() => dispatcher.emit(bad, undefined)).toThrow(
				expect.objectContaining({ code: 'invalid-hook' }),
			);
		}
	});

	it('rejects non-function listeners with invalid-listener', () => {
		const dispatcher = new HookDispatcher();

		expect(() => dispatcher.on('job-started', 'nope' as never)).toThrow(
			expect.objectContaining({ code: 'invalid-listener' }),
		);
		expect(() => dispatcher.once('job-started', 42 as never)).toThrow(
			expect.objectContaining({ code: 'invalid-listener' }),
		);
		expect(dispatcher.listenerCount('job-started')).toBe(0);
	});

	it('off removes a single listener and prunes empty buckets', () => {
		const dispatcher = new HookDispatcher();
		const a = vi.fn();
		const b = vi.fn();
		dispatcher.on('job-started', a);
		dispatcher.on('job-started', b);

		expect(dispatcher.off('job-started', a)).toBe(true);
		expect(dispatcher.getListeners('job-started')).toEqual([b]);
		expect(dispatcher.off('job-started', a)).toBe(false);
		expect(dispatcher.off('unknown-hook', a)).toBe(false);
		dispatcher.off('job-started', b);
		expect(dispatcher.hasListeners('job-started')).toBe(false);
	});

	it('clear removes one hook or the whole dispatcher', () => {
		const dispatcher = new HookDispatcher();
		dispatcher.on('job-started', vi.fn());
		dispatcher.on('job-finished', vi.fn());

		dispatcher.clear('job-started');
		expect(dispatcher.hasListeners('job-started')).toBe(false);
		expect(dispatcher.hasListeners('job-finished')).toBe(true);

		dispatcher.clear();
		expect(dispatcher.hasListeners('job-finished')).toBe(false);
		expect(dispatcher.listenerCount('job-finished')).toBe(0);
	});

	it('listeners() returns a snapshot in registration order', () => {
		const dispatcher = new HookDispatcher();
		const a = vi.fn();
		const b = vi.fn();
		dispatcher.on('job-started', a);
		dispatcher.on('job-started', b);

		expect(dispatcher.getListeners('job-started')).toEqual([a, b]);
		dispatcher.off('job-started', a);
		expect(dispatcher.getListeners('job-started')).toEqual([b]);
	});
});

describe('async firing', () => {
	it('fires every listener with the payload and aggregates outcomes', async () => {
		const dispatcher = new HookDispatcher();
		const received: unknown[] = [];
		dispatcher.on('job-started', (payload) => {
			received.push(payload);
		});
		dispatcher.on('job-started', async (payload) => {
			await Promise.resolve();
			received.push(payload);
		});

		const result = await dispatcher.emit('job-started', { id: 7 });

		expect(received).toEqual([{ id: 7 }, { id: 7 }]);
		expect(result).toMatchObject({
			hook: 'job-started',
			listenerCount: 2,
			fulfilled: 2,
			rejected: 0,
		});
		expect(result.outcomes).toHaveLength(2);
		expect(result.outcomes[0]).toMatchObject({ ok: true });
	});

	it('never invokes listeners synchronously', async () => {
		const dispatcher = new HookDispatcher();
		let called = false;
		dispatcher.on('job-started', () => {
			called = true;
		});

		const pending = dispatcher.emit('job-started', null);
		expect(called).toBe(false);
		await pending;
		expect(called).toBe(true);
	});

	it('awaits async listeners before resolving emit', async () => {
		const dispatcher = new HookDispatcher();
		const gate = defer();
		let finished = false;
		dispatcher.on('job-started', async () => {
			await gate.promise;
			finished = true;
		});

		const pending = dispatcher.emit('job-started', null);
		await Promise.resolve();
		expect(finished).toBe(false);
		gate.resolve();
		await pending;
		expect(finished).toBe(true);
	});

	it('delivers to the snapshot taken at emit time', async () => {
		const dispatcher = new HookDispatcher();
		const called: string[] = [];
		dispatcher.on('job-started', () => {
			called.push('first');
		});

		const pending = dispatcher.emit('job-started', null);
		dispatcher.on('job-started', () => {
			called.push('late');
		});
		await pending;

		expect(called).toEqual(['first']);
		expect(dispatcher.listenerCount('job-started')).toBe(2);
	});

	it('resolves immediately with zero counts when no listeners exist', async () => {
		const dispatcher = new HookDispatcher();
		const result = await dispatcher.emit('empty-hook', undefined);

		expect(result).toEqual({
			hook: 'empty-hook',
			listenerCount: 0,
			fulfilled: 0,
			rejected: 0,
			outcomes: [],
		});
	});
});

describe('error boundary', () => {
	it('contains a throwing listener without rejecting emit or blocking others', async () => {
		const dispatcher = new HookDispatcher();
		const calls: string[] = [];
		dispatcher.on('job-started', () => {
			throw new Error('boom');
		});
		dispatcher.on('job-started', () => {
			calls.push('second');
		});

		const result = await dispatcher.emit('job-started', null);

		expect(calls).toEqual(['second']);
		expect(result.rejected).toBe(1);
		expect(result.fulfilled).toBe(1);
		expect(result.outcomes[0]).toMatchObject({ ok: false });
		expect(result.outcomes[0].error?.message).toBe('boom');
	});

	it('contains a rejecting async listener and normalizes non-Error values', async () => {
		const dispatcher = new HookDispatcher();
		dispatcher.on('job-started', async () => {
			throw 'string failure';
		});

		const result = await dispatcher.emit('job-started', null);

		expect(result.rejected).toBe(1);
		expect(result.outcomes[0].ok).toBe(false);
		expect(result.outcomes[0].error?.message).toContain('string failure');
	});

	it('reports failures to the error handler', async () => {
		const dispatcher = new HookDispatcher();
		const events: Array<{ hook: string; message: string }> = [];
		dispatcher.setErrorHandler(({ hook, error }) => {
			events.push({ hook, message: error.message });
		});
		dispatcher.on('job-started', () => {
			throw new Error('handler sees me');
		});

		await dispatcher.emit('job-started', null);

		expect(events).toEqual([{ hook: 'job-started', message: 'handler sees me' }]);
	});

	it('never propagates a throwing error handler', async () => {
		const dispatcher = new HookDispatcher();
		dispatcher.setErrorHandler(() => {
			throw new Error('handler bug');
		});
		dispatcher.on('job-started', () => {
			throw new Error('listener failure');
		});

		const result = await dispatcher.emit('job-started', null);

		expect(result.rejected).toBe(1);
	});

	it('reports listener timeouts as rejected outcomes', async () => {
		const dispatcher = new HookDispatcher();
		dispatcher.on('job-started', () => new Promise<void>(() => {}));

		const result = await dispatcher.emit('job-started', null, {
			timeoutMs: 25,
		});

		expect(result.rejected).toBe(1);
		expect(result.outcomes[0].error?.message).toContain('25ms');
	});

	it('does not time out listeners that settle in time', async () => {
		const dispatcher = new HookDispatcher();
		dispatcher.on('job-started', async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});

		const result = await dispatcher.emit('job-started', null, {
			timeoutMs: 500,
		});

		expect(result.fulfilled).toBe(1);
		expect(result.rejected).toBe(0);
	});

	it('rejects invalid timeoutMs with invalid-options', () => {
		const dispatcher = new HookDispatcher();

		expect(() => dispatcher.emit('job-started', null, { timeoutMs: 0 })).toThrow(
			expect.objectContaining({ code: 'invalid-options' }),
		);
		expect(() =>
			dispatcher.emit('job-started', null, { timeoutMs: Number.NaN }),
		).toThrow(expect.objectContaining({ code: 'invalid-options' }));
	});

	it('emitAndForget never produces an unhandled rejection', async () => {
		const dispatcher = new HookDispatcher();
		const errors: string[] = [];
		dispatcher.setErrorHandler(({ error }) => {
			errors.push(error.message);
		});
		dispatcher.on('job-started', async () => {
			throw new Error('fire and forget');
		});

		dispatcher.emitAndForget('job-started', null);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(errors).toEqual(['fire and forget']);
	});
});

describe('once', () => {
	it('fires exactly once and removes itself before invocation', async () => {
		const dispatcher = new HookDispatcher();
		const listener = vi.fn();
		dispatcher.once('job-started', listener);

		await dispatcher.emit('job-started', 1);
		await dispatcher.emit('job-started', 2);

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith(1);
		expect(dispatcher.listenerCount('job-started')).toBe(0);
	});

	it('once listeners are still guarded by the error boundary', async () => {
		const dispatcher = new HookDispatcher();
		dispatcher.once('job-started', () => {
			throw new Error('once failure');
		});

		const result = await dispatcher.emit('job-started', null);

		expect(result.rejected).toBe(1);
		expect(dispatcher.listenerCount('job-started')).toBe(0);
	});

	it('returns an unsubscribe that cancels the pending once listener', async () => {
		const dispatcher = new HookDispatcher();
		const listener = vi.fn();
		const unsubscribe = dispatcher.once('job-started', listener);

		unsubscribe();
		await dispatcher.emit('job-started', null);

		expect(listener).not.toHaveBeenCalled();
		expect(dispatcher.listenerCount('job-started')).toBe(0);
	});
});

describe('typed listeners', () => {
	it('delivers typed payloads through generic registration', async () => {
		const dispatcher = new HookDispatcher();
		const received: Array<{ id: number }> = [];
		dispatcher.on<{ id: number }>('job-started', (payload) => {
			received.push(payload);
		});

		await dispatcher.emit('job-started', { id: 42 });

		expect(received).toEqual([{ id: 42 }]);
	});
});

describe('singleton', () => {
	it('exposes a process-wide hookDispatcher', async () => {
		expect(hookDispatcher).toBeInstanceOf(HookDispatcher);
		hookDispatcher.clear();
		const result = await hookDispatcher.emit('test-hook', null);
		expect(result.listenerCount).toBe(0);
	});

	it('defaults to a console.error error handler for observability', async () => {
		const dispatcher = new HookDispatcher();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			dispatcher.on('job-started', () => {
				throw new Error('logged');
			});
			await dispatcher.emit('job-started', null);
			expect(errorSpy).toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});

	it('setErrorHandler(null) disables failure reporting', async () => {
		const dispatcher = new HookDispatcher();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			dispatcher.setErrorHandler(null);
			dispatcher.on('job-started', () => {
				throw new Error('silent');
			});
			await dispatcher.emit('job-started', null);
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});
});
