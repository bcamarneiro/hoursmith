/**
 * Tests for WorkerDaemon.
 *
 * The test environment is happy-dom, which doesn't provide a real Worker
 * implementation. We mock the Worker constructor globally and test the
 * daemon entirely through the mocked interface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerDaemon, type DaemonMessage } from '../workerDaemon';
import { ServiceError } from '@/services/serviceErrors';

// ---------------------------------------------------------------------------
// Mock Worker infrastructure
// ---------------------------------------------------------------------------

/** A fake Worker we control from tests — callbacks stored so tests can simulate messages. */
interface MockWorkerInstance {
	onmessage: ((evt: MessageEvent) => void) | null;
	onerror: ((evt: ErrorEvent) => void) | null;
	postMessage: ReturnType<typeof vi.fn>;
	terminate: ReturnType<typeof vi.fn>;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
}

const mockInstances: MockWorkerInstance[] = [];
let MockWorkerCtor: ReturnType<typeof vi.fn>;

function latestMock(): MockWorkerInstance {
	const inst = mockInstances[mockInstances.length - 1];
	if (!inst) throw new Error('No mock Worker instance — did start() throw?');
	return inst;
}

beforeEach(() => {
	mockInstances.length = 0;

	MockWorkerCtor = vi.fn().mockImplementation(function (this: MockWorkerInstance) {
		const instance = this;
		instance.onmessage = null;
		instance.onerror = null;
		instance.postMessage = vi.fn();
		instance.terminate = vi.fn().mockImplementation(() => {
			// Clearing callbacks simulates the worker being gone.
			instance.onmessage = null;
			instance.onerror = null;
		});
		instance.addEventListener = vi
			.fn()
			.mockImplementation((type: string, handler: unknown) => {
				if (type === 'message') (instance as any).onmessage = handler;
				if (type === 'error') (instance as any).onerror = handler;
			});
		instance.removeEventListener = vi
			.fn()
			.mockImplementation((type: string) => {
				if (type === 'message') (instance as any).onmessage = null;
				if (type === 'error') (instance as any).onerror = null;
			});
		mockInstances.push(instance);
		return instance;
	});

	vi.stubGlobal('Worker', MockWorkerCtor);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// ---- helpers ----

/** Send a mocked message event to the latest worker. */
function sendToWorker(msg: DaemonMessage): void {
	const inst = latestMock();
	const handler = inst.onmessage;
	if (handler) {
		handler(new MessageEvent('message', { data: msg }));
	}
}

/** Send a mocked error event to the latest worker. */
function sendErrorToWorker(message: string): void {
	const inst = latestMock();
	const handler = inst.onerror;
	if (handler) {
		handler(
			new ErrorEvent('error', { message, error: new Error(message) }),
		);
	}
}

/** Helper: create daemon with heartbeats disabled for simpler tests. */
function createDaemon(
	opts?: Parameters<WorkerDaemon['constructor']>[1],
): WorkerDaemon<string, string> {
	return new WorkerDaemon<string, string>('/fake-worker.js', {
		heartbeatIntervalMs: 0,
		idleTimeoutMs: 0,
		label: 'TestDaemon',
		...opts,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerDaemon', () => {
	// -- lifecycle ----------------------------------------------------------

	describe('lifecycle', () => {
		it('starts in idle state', () => {
			const daemon = createDaemon();
			expect(daemon.getState()).toBe('idle');
		});

		it('start() spawns a Worker and transitions to busy', async () => {
			const daemon = createDaemon();
			await daemon.start();
			expect(daemon.getState()).toBe('busy');
			expect(MockWorkerCtor).toHaveBeenCalledOnce();
			expect(MockWorkerCtor).toHaveBeenCalledWith('/fake-worker.js', {
				type: 'module',
			});
		});

		it('start() is idempotent when already busy', async () => {
			const daemon = createDaemon();
			await daemon.start();
			await daemon.start(); // second call
			expect(MockWorkerCtor).toHaveBeenCalledTimes(1);
		});

		it('stop() terminates the worker and goes idle', async () => {
			const daemon = createDaemon();
			await daemon.start();

			daemon.stop();
			expect(daemon.getState()).toBe('idle');
			expect(latestMock().terminate).toHaveBeenCalled();
		});

		it('stop() is idempotent', () => {
			const daemon = createDaemon();
			daemon.stop();
			daemon.stop();
			expect(daemon.getState()).toBe('idle');
		});
	});

	// -- enqueue / request-response ----------------------------------------

	describe('enqueue', () => {
		it('resolves when worker responds with matching id', async () => {
			const daemon = createDaemon();
			await daemon.start();

			const promise = daemon.enqueue('hello');
			expect(latestMock().postMessage).toHaveBeenCalledWith({
				id: expect.any(String),
				type: 'request',
				payload: 'hello',
			});

			// Simulate worker response.
			const sentMsg = latestMock().postMessage.mock.calls[0][0] as DaemonMessage;
			sendToWorker({
				id: sentMsg.id,
				type: 'response',
				payload: 'world',
			});

			await expect(promise).resolves.toBe('world');
		});

		it('rejects when worker responds with error field', async () => {
			const daemon = createDaemon();
			await daemon.start();

			const promise = daemon.enqueue('boom');
			const sentMsg = latestMock().postMessage.mock.calls[0][0] as DaemonMessage;
			sendToWorker({
				id: sentMsg.id,
				type: 'response',
				error: 'something broke',
			});

			await expect(promise).rejects.toThrow(ServiceError);
			await expect(promise).rejects.toThrow(/worker error: something broke/);
		});

		it('starts the worker automatically when idle', async () => {
			const daemon = createDaemon();
			// Don't explicitly start — enqueue should trigger it.
			const promise = daemon.enqueue('auto-start');
			await vi.waitFor(() => expect(daemon.getState()).toBe('busy'));

			const sentMsg = latestMock().postMessage.mock.calls[0][0] as DaemonMessage;
			sendToWorker({ id: sentMsg.id, type: 'response', payload: 'ok' });

			await expect(promise).resolves.toBe('ok');
		});

		it('handles concurrent requests with correct correlation', async () => {
			const daemon = createDaemon();
			await daemon.start();

			const p1 = daemon.enqueue('req1');
			const p2 = daemon.enqueue('req2');
			const p3 = daemon.enqueue('req3');

			const msgs = latestMock().postMessage.mock.calls.map(
				(c) => c[0],
			) as DaemonMessage[];

			// Respond out of order to test correlation.
			sendToWorker({ id: msgs[2].id, type: 'response', payload: 'r3' });
			sendToWorker({ id: msgs[0].id, type: 'response', payload: 'r1' });
			sendToWorker({ id: msgs[1].id, type: 'response', payload: 'r2' });

			await expect(p1).resolves.toBe('r1');
			await expect(p2).resolves.toBe('r2');
			await expect(p3).resolves.toBe('r3');
		});

		it('rejects pending requests when stopped', async () => {
			const daemon = createDaemon();
			await daemon.start();

			const promise = daemon.enqueue('will-be-dropped');
			daemon.stop();

			await expect(promise).rejects.toThrow(ServiceError);
			await expect(promise).rejects.toThrow(
				/worker stopped while request was pending/,
			);
		});

		it('tracks request count in status', async () => {
			const daemon = createDaemon();
			await daemon.start();

			const p = daemon.enqueue('req');
			const sentMsg = latestMock().postMessage.mock.calls[0][0] as DaemonMessage;

			expect(daemon.getStatus().requestCount).toBe(1);

			sendToWorker({ id: sentMsg.id, type: 'response', payload: 'ok' });
			await p;

			expect(daemon.getStatus().requestCount).toBe(1);
		});
	});

	// -- heartbeat ----------------------------------------------------------

	describe('heartbeat', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('sends periodic pings when heartbeats are enabled', async () => {
			const daemon = new WorkerDaemon<string, string>('/fake-worker.js', {
				heartbeatIntervalMs: 5_000,
				idleTimeoutMs: 0,
				label: 'TestDaemon',
			});

			await vi.advanceTimersByTimeAsync(0); // let microtasks flush

			// Start should trigger the first heartbeat timeout.
			const startP = daemon.start();
			// The daemon is 'starting' — waiting for first heartbeat.

			// First heartbeat interval fires (ping).
			await vi.advanceTimersByTimeAsync(5_000);
			expect(latestMock().postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'heartbeat' }),
			);

			// Worker responds with pong → daemon transitions to 'busy'.
			latestMock().postMessage.mockClear();
			sendToWorker({ id: 'hb', type: 'heartbeat' });
			await startP;

			expect(daemon.getState()).toBe('busy');

			// Next ping after another interval.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(latestMock().postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'heartbeat' }),
			);
		});

		it('declares worker dead on heartbeat timeout', async () => {
			const onError = vi.fn();
			const daemon = new WorkerDaemon<string, string>('/fake-worker.js', {
				heartbeatIntervalMs: 5_000,
				heartbeatTimeoutMs: 10_000,
				errorBackoffMs: 50_000, // high so we don't race with restart
				idleTimeoutMs: 0,
				label: 'TestDaemon',
			});
			daemon.onError(onError);

			void daemon.start();

			// First heartbeat fires after interval.
			await vi.advanceTimersByTimeAsync(5_000);
			// Worker responds → goes busy.
			sendToWorker({ id: 'hb', type: 'heartbeat' });
			await vi.advanceTimersByTimeAsync(0); // flush

			// Now the heartbeat timeout clock is ticking.
			// After heartbeatTimeoutMs (10s) without a response, it should error.
			// But note: the interval sends another ping at 10s (second ping), which
			// restarts the timeout. We need to wait long enough for the timeout to
			// fire without a pong response.

			// At t=10s: second ping fires, timeout gets reset to 20s.
			await vi.advanceTimersByTimeAsync(5_000); // t=10s now
			expect(latestMock().postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'heartbeat' }),
			);

			// Wait another 10s (total t=20s) — timeout fires because no pong came.
			await vi.advanceTimersByTimeAsync(10_000);

			expect(onError).toHaveBeenCalled();
			const err = onError.mock.calls[0][0] as Error;
			expect(err.message).toContain('heartbeat timeout');
			expect(daemon.getState()).toBe('error');
		});

		it('records lastHeartbeatAt on pong', async () => {
			vi.useRealTimers(); // need real timers for date comparison
			const daemon = new WorkerDaemon<string, string>('/fake-worker.js', {
				heartbeatIntervalMs: 1_000,
				idleTimeoutMs: 0,
				label: 'TestDaemon',
			});

			const startP = daemon.start();
			// Wait for first ping via setTimeout, then respond.
			await new Promise((r) => setTimeout(r, 1_100));
			sendToWorker({ id: 'hb', type: 'heartbeat' });
			await startP;

			expect(daemon.getStatus().lastHeartbeatAt).not.toBeNull();
		});
	});

	// -- error handling -----------------------------------------------------

	describe('error handling', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('rejects pending requests on worker crash', async () => {
			const daemon = createDaemon({ errorBackoffMs: 50_000 });
			await daemon.start();

			const promise = daemon.enqueue('before-crash');
			sendErrorToWorker('Uncaught ReferenceError: x is not defined');

			await expect(promise).rejects.toThrow(ServiceError);
			await expect(promise).rejects.toThrow(/worker failed/);
			expect(daemon.getState()).toBe('error');
		});

		it('emits error event on worker crash', async () => {
			const onError = vi.fn();
			const daemon = createDaemon({ errorBackoffMs: 50_000 });
			daemon.onError(onError);
			await daemon.start();

			sendErrorToWorker('boom');

			expect(onError).toHaveBeenCalled();
			expect((onError.mock.calls[0][0] as Error).message).toContain('boom');
		});

		it('auto-restarts after error backoff', async () => {
			const daemon = createDaemon({ errorBackoffMs: 2_000 });
			await daemon.start();

			sendErrorToWorker('crash');
			expect(daemon.getState()).toBe('error');

			// After backoff, should restart.
			await vi.advanceTimersByTimeAsync(2_100);
			await vi.advanceTimersByTimeAsync(0); // flush microtasks
			expect(daemon.getState()).toBe('busy');
			expect(MockWorkerCtor).toHaveBeenCalledTimes(2);
		});

		it('does not crash on malformed messages', async () => {
			const onError = vi.fn();
			const daemon = createDaemon();
			daemon.onError(onError);
			await daemon.start();

			// Send garbage.
			sendToWorker({ id: null, type: null } as unknown as DaemonMessage);

			expect(onError).toHaveBeenCalled();
			expect((onError.mock.calls[0][0] as Error).message).toContain(
				'malformed message',
			);
		});

		it('wraps Worker construction failure in ServiceError', async () => {
			MockWorkerCtor.mockImplementationOnce(() => {
				throw new Error('Worker not supported');
			});

			const onError = vi.fn();
			const daemon = createDaemon({ errorBackoffMs: 50_000 });
			daemon.onError(onError);

			await daemon.start();

			expect(daemon.getState()).toBe('error');
			expect(onError).toHaveBeenCalled();
			const err = onError.mock.calls[0][0] as Error;
			expect(err.message).toContain('Failed to construct worker');
			expect(err.message).toContain('Worker not supported');
		});
	});

	// -- idle timeout -------------------------------------------------------

	describe('idle timeout', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('terminates the worker after idle timeout', async () => {
			const daemon = createDaemon({ idleTimeoutMs: 10_000 });
			await daemon.start();

			expect(daemon.getState()).toBe('busy');

			await vi.advanceTimersByTimeAsync(10_100);
			await vi.advanceTimersByTimeAsync(0);

			expect(daemon.getState()).toBe('idle');
			expect(latestMock().terminate).toHaveBeenCalled();
		});

		it('resets idle timer on enqueue activity', async () => {
			const daemon = createDaemon({ idleTimeoutMs: 10_000 });
			await daemon.start();

			// Advance 5s, then enqueue (should reset timer).
			await vi.advanceTimersByTimeAsync(5_000);
			const p = daemon.enqueue('keep-alive');

			// Advance another 8s (total 13s — would have timed out at 10s
			// without the reset). But now should still be alive.
			await vi.advanceTimersByTimeAsync(8_000);

			const sentMsg = latestMock().postMessage.mock.calls[0][0] as DaemonMessage;
			sendToWorker({ id: sentMsg.id, type: 'response', payload: 'ok' });
			await p;

			expect(daemon.getState()).toBe('busy');
		});

		it('resets idle timer when response arrives', async () => {
			const daemon = createDaemon({ idleTimeoutMs: 10_000 });
			await daemon.start();

			const p = daemon.enqueue('req');
			await vi.advanceTimersByTimeAsync(2_000);

			const sentMsg = latestMock().postMessage.mock.calls[0][0] as DaemonMessage;
			sendToWorker({ id: sentMsg.id, type: 'response', payload: 'ok' });
			await p;

			// At this point, timer is reset. Advance 8s (total 10s from original
			// start, but only 8s since last response) — still alive.
			await vi.advanceTimersByTimeAsync(8_000);
			expect(daemon.getState()).toBe('busy');

			// Advance another 3s (total 11s since response) — now timeout.
			await vi.advanceTimersByTimeAsync(3_000);
			await vi.advanceTimersByTimeAsync(0);
			expect(daemon.getState()).toBe('idle');
		});
	});

	// -- events -------------------------------------------------------------

	describe('events', () => {
		it('onStatusChange fires on state transitions', async () => {
			const daemon = createDaemon();
			const handler = vi.fn();
			daemon.onStatusChange(handler);

			await daemon.start();

			expect(handler).toHaveBeenCalledTimes(2); // 'starting', then 'busy'
			expect(handler.mock.calls[0][0].state).toBe('starting');
			expect(handler.mock.calls[1][0].state).toBe('busy');

			daemon.stop();
			expect(handler).toHaveBeenCalledTimes(4); // + 'terminating', 'idle'
		});

		it('onStatusChange unsubscribe works', async () => {
			const daemon = createDaemon();
			const handler = vi.fn();
			const unsub = daemon.onStatusChange(handler);

			await daemon.start();
			expect(handler).toHaveBeenCalled();

			handler.mockClear();
			unsub();
			daemon.stop();
			expect(handler).not.toHaveBeenCalled();
		});

		it('onError unsubscribe works', async () => {
			const daemon = createDaemon({ errorBackoffMs: 50_000 });
			const handler = vi.fn();
			const unsub = daemon.onError(handler);
			await daemon.start();

			unsub();
			sendErrorToWorker('crash');
			expect(handler).not.toHaveBeenCalled();
		});

		it('handler errors do not break other handlers', async () => {
			const daemon = createDaemon({ errorBackoffMs: 50_000 });
			const bad = vi.fn().mockImplementation(() => {
				throw new Error('handler bug');
			});
			const good = vi.fn();

			daemon.onError(bad);
			daemon.onError(good);
			await daemon.start();

			sendErrorToWorker('crash');

			expect(bad).toHaveBeenCalled();
			expect(good).toHaveBeenCalled(); // still called despite bad throwing
		});
	});

	// -- edge cases ---------------------------------------------------------

	describe('edge cases', () => {
		it('enqueue while in error state triggers restart', async () => {
			vi.useFakeTimers();
			const daemon = createDaemon({ errorBackoffMs: 50_000 });
			await daemon.start();

			// Crash the worker.
			sendErrorToWorker('crash');
			expect(daemon.getState()).toBe('error');

			// Enqueue should trigger a restart.
			const p = daemon.enqueue('after-crash');

			// The restart calls start(), which spawns a new worker.
			// Flush microtasks so the .then(dispatchRequest) runs.
			await vi.advanceTimersByTimeAsync(0);

			expect(MockWorkerCtor).toHaveBeenCalledTimes(2);

			const sentMsg = latestMock().postMessage.mock.calls[0][0] as DaemonMessage;
			sendToWorker({ id: sentMsg.id, type: 'response', payload: 'recovered' });
			await p;

			expect(await p).toBe('recovered');
			vi.useRealTimers();
		});

		it('unknown message type is silently ignored', async () => {
			const daemon = createDaemon();
			await daemon.start();

			// This should not throw or change state.
			expect(() => {
				// Simulate an unknown message. We need to reach onWorkerMessage directly
				// or through the mock. Let's just call sendToWorker with an unknown type.
				sendToWorker({ id: 'x', type: 'unknown-type' as any });
			}).not.toThrow();

			expect(daemon.getState()).toBe('busy');
		});

		it('stale response for already-resolved request is ignored', async () => {
			const daemon = createDaemon();
			await daemon.start();

			const p = daemon.enqueue('req');
			const sentMsg = latestMock().postMessage.mock.calls[0][0] as DaemonMessage;

			// First response resolves it.
			sendToWorker({ id: sentMsg.id, type: 'response', payload: 'first' });
			await expect(p).resolves.toBe('first');

			// Second response with same id should be harmless.
			expect(() => {
				sendToWorker({ id: sentMsg.id, type: 'response', payload: 'second' });
			}).not.toThrow();
		});

		it('stop() while starting rejects pending and cleans up', async () => {
			// Create with heartbeat to cause 'starting' state.
			const daemon = new WorkerDaemon<string, string>('/fake-worker.js', {
				heartbeatIntervalMs: 5_000,
				idleTimeoutMs: 0,
				label: 'TestDaemon',
			});

			void daemon.start();
			// It's now 'starting' — waiting for first heartbeat.
			daemon.enqueue('during-start').catch(() => {});

			daemon.stop();
			expect(daemon.getState()).toBe('idle');
		});

		it('does not restart when errorBackoffMs is 0', async () => {
			vi.useFakeTimers();
			const daemon = createDaemon({ errorBackoffMs: 0 });
			await daemon.start();

			sendErrorToWorker('crash');
			expect(daemon.getState()).toBe('error');

			// Advance a long time, should NOT restart.
			await vi.advanceTimersByTimeAsync(10_000);
			expect(daemon.getState()).toBe('error');
			vi.useRealTimers();
		});

		it('status reflects uptime correctly', async () => {
			vi.useFakeTimers();
			const daemon = createDaemon();

			const startP = daemon.start();
			await vi.advanceTimersByTimeAsync(0);

			expect(daemon.getStatus().uptimeMs).toBeGreaterThanOrEqual(0);

			await vi.advanceTimersByTimeAsync(5_000);
			// Should be ~5s uptime.
			expect(daemon.getStatus().uptimeMs).toBeGreaterThanOrEqual(5_000);
			vi.useRealTimers();
		});
	});

	// -- typed generics -----------------------------------------------------

	describe('generic types', () => {
		it('works with object payloads', async () => {
			interface AddReq {
				a: number;
				b: number;
			}
			interface AddRes {
				sum: number;
			}

			const daemon = new WorkerDaemon<AddReq, AddRes>('/fake-worker.js', {
				heartbeatIntervalMs: 0,
				idleTimeoutMs: 0,
				label: 'TestDaemon',
			});
			await daemon.start();

			const promise = daemon.enqueue({ a: 3, b: 4 });
			const sent = latestMock().postMessage.mock.calls[0][0] as DaemonMessage;
			sendToWorker({ id: sent.id, type: 'response', payload: { sum: 7 } });

			await expect(promise).resolves.toEqual({ sum: 7 });
		});
	});
});
