/**
 * Tests for the graceful shutdown helper (ADA-696).
 *
 * No real signals are sent to the process — listeners are triggered with
 * `process.emit` so the tests can assert wiring without killing the runner.
 * The registered listeners are unregistered after each test.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
	type Mock,
} from 'vitest';

import type { WorkerLogFn } from '../worker.js';
import { registerGracefulShutdown } from '../gracefulShutdown.js';

type ExitSpy = Mock<(code: number) => never>;

const log = vi.fn() as unknown as WorkerLogFn;
const logMock = vi.mocked(log);

let unregister: () => void = () => {};

function waitForExit(exit: ExitSpy): Promise<number> {
	return new Promise<number>((resolve) => {
		exit.mockImplementation((code: number) => {
			resolve(code);
			return undefined as never;
		});
	});
}

beforeEach(() => {
	vi.useRealTimers();
	logMock.mockClear();
});

afterEach(() => {
	unregister();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe('registerGracefulShutdown', () => {
	it('drains on first signal, then exits 0 once drained', async () => {
		const exit: ExitSpy = vi.fn<(code: number) => never>();
		const drain = vi.fn().mockResolvedValue(undefined);
		const exited = waitForExit(exit);

		unregister = registerGracefulShutdown({ drain, timeoutMs: 500, exit, log });

		process.emit('SIGTERM');
		const code = await exited;

		expect(drain).toHaveBeenCalledTimes(1);
		expect(code).toBe(0);
	});

	it('drains on SIGINT as well', async () => {
		const exit: ExitSpy = vi.fn<(code: number) => never>();
		const drain = vi.fn().mockResolvedValue(undefined);
		const exited = waitForExit(exit);

		unregister = registerGracefulShutdown({ drain, timeoutMs: 500, exit, log });

		process.emit('SIGINT');
		await exited;

		expect(drain).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(0);
	});

	it('exits 1 when draining fails', async () => {
		const exit: ExitSpy = vi.fn<(code: number) => never>();
		const drain = vi.fn().mockRejectedValue(new Error('worker close failed'));
		const exited = waitForExit(exit);

		unregister = registerGracefulShutdown({ drain, timeoutMs: 500, exit, log });

		process.emit('SIGTERM');
		const code = await exited;

		expect(code).toBe(1);
		expect(log).toHaveBeenCalledWith('drain failed; exiting', {
			error: 'worker close failed',
		});
	});

	it('force-exits when the drain exceeds the timeout', async () => {
		vi.useFakeTimers();
		const exit: ExitSpy = vi.fn<(code: number) => never>();
		const drain = vi.fn().mockReturnValue(new Promise(() => {}));
		const exited = waitForExit(exit);

		unregister = registerGracefulShutdown({
			drain,
			timeoutMs: 1_000,
			exit,
			log,
		});

		process.emit('SIGTERM');
		await vi.advanceTimersByTimeAsync(1_001);

		expect(exit).toHaveBeenCalledWith(1);
		expect(log).toHaveBeenCalledWith(
			'drain timed out after 1000ms; forcing exit',
		);
		await exited;
	});

	it('force-exits on a second signal while draining', async () => {
		vi.useFakeTimers();
		const exit: ExitSpy = vi.fn<(code: number) => never>();
		const drain = vi.fn().mockReturnValue(new Promise(() => {}));
		const exited = waitForExit(exit);

		unregister = registerGracefulShutdown({
			drain,
			timeoutMs: 30_000,
			exit,
			log,
		});

		process.emit('SIGTERM');
		process.emit('SIGTERM');
		const code = await exited;

		expect(code).toBe(1);
	});

	it('unregister() removes the signal handlers', () => {
		const exit: ExitSpy = vi.fn<(code: number) => never>();
		const drain = vi.fn().mockResolvedValue(undefined);

		unregister = registerGracefulShutdown({ drain, timeoutMs: 500, exit, log });
		unregister();

		process.emit('SIGTERM');
		expect(drain).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
	});

	it('rejects a non-positive timeout', () => {
		const exit: ExitSpy = vi.fn<(code: number) => never>();
		expect(() =>
			registerGracefulShutdown({ drain: vi.fn(), timeoutMs: 0, exit, log }),
		).toThrow(/timeout/i);
	});
});
