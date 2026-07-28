import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
	postToWorker,
	isProcessingWorkerSupported,
	terminateWorker,
} from '../processingWorkerClient';

describe('processingWorkerClient', () => {
	beforeEach(() => {
		terminateWorker();
	});

	afterEach(() => {
		terminateWorker();
	});

	describe('isProcessingWorkerSupported', () => {
		it('returns false when Worker is not available', () => {
			const originalWorker = globalThis.Worker;
			(globalThis as Record<string, unknown>).Worker = undefined;

			expect(isProcessingWorkerSupported()).toBe(false);

			globalThis.Worker = originalWorker;
		});

		it('returns false when window is not available', () => {
			const originalWindow = globalThis.window;
			(globalThis as Record<string, unknown>).window = undefined;

			expect(isProcessingWorkerSupported()).toBe(false);

			globalThis.window = originalWindow;
		});
	});

	describe('postToWorker', () => {
		it('rejects when worker cannot be created', async () => {
			// Mock Worker as unavailable
			const originalWorker = globalThis.Worker;
			(globalThis as Record<string, unknown>).Worker = undefined;

			await expect(
				postToWorker({ type: 'classify', payload: { worklogs: [] } }),
			).rejects.toThrow('Web Worker not available');

			globalThis.Worker = originalWorker;
		});

		it('assigns unique request IDs', async () => {
			// Mock Worker to capture messages
			const messages: unknown[] = [];
			const mockWorker = {
				postMessage: (msg: unknown) => messages.push(msg),
				addEventListener: vi.fn(),
				terminate: vi.fn(),
			};
			const originalWorker = globalThis.Worker;
			(globalThis as Record<string, unknown>).Worker = vi.fn(() => mockWorker);

			// Fire two requests (don't await — they'll hang since we don't respond)
			const p1 = postToWorker({ type: 'classify', payload: { worklogs: [] } });
			const p2 = postToWorker({ type: 'classify', payload: { worklogs: [] } });

			// Check that IDs are unique
			expect((messages[0] as { id: number }).id).not.toBe(
				(messages[1] as { id: number }).id,
			);

			// Clean up — reject pending promises
			p1.catch(() => {});
			p2.catch(() => {});
			terminateWorker();

			globalThis.Worker = originalWorker;
		});
	});

	describe('terminateWorker', () => {
		it('rejects all pending requests', async () => {
			const mockWorker = {
				postMessage: vi.fn(),
				addEventListener: vi.fn(),
				terminate: vi.fn(),
			};
			const originalWorker = globalThis.Worker;
			// @ts-expect-error - mock
			globalThis.Worker = vi.fn(() => mockWorker);

			const promise = postToWorker({
				type: 'classify',
				payload: { worklogs: [] },
			});

			terminateWorker();

			await expect(promise).rejects.toThrow('Worker terminated');

			globalThis.Worker = originalWorker;
		});
	});
});
