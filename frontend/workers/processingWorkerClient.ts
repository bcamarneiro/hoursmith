/**
 * Singleton client for the processing Web Worker.
 *
 * Lazily creates the worker on first use, multiplexes concurrent requests
 * via a request-id protocol, and terminates the worker after an idle
 * timeout to free resources.
 *
 * Falls back to a synchronous in-line execution when Workers are not
 * available (SSR, very old browsers, test environments without worker
 * support).
 */

import type {
	ProcessingWorkerRequest,
	ProcessingWorkerResponse,
} from './processingWorker.types';

type PendingResolver = {
	resolve: (data: ProcessingWorkerResponse) => void;
	reject: (err: Error) => void;
};

const IDLE_TIMEOUT_MS = 30_000; // Terminate worker after 30s idle

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingResolver>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function isWorkerAvailable(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof Worker !== 'undefined' &&
		typeof import.meta?.url !== 'undefined'
	);
}

function getOrCreateWorker(): Worker | null {
	if (worker) return worker;
	if (!isWorkerAvailable()) return null;

	try {
		worker = new Worker(
			new URL('./processingWorker.ts', import.meta.url),
			{ type: 'module' },
		);
		worker.addEventListener('message', (event: MessageEvent<ProcessingWorkerResponse>) => {
			const msg = event.data;
			const resolver = pending.get(msg.id);
			if (!resolver) return; // stale or unknown response
			pending.delete(msg.id);
			resolver.resolve(msg);
			resetIdleTimer();
		});
		worker.addEventListener('error', () => {
			// Worker script failed to load — reject all pending and clean up
			for (const [, resolver] of pending) {
				resolver.reject(new Error('Processing worker failed'));
			}
			pending.clear();
			worker = null;
			clearIdleTimer();
		});
		return worker;
	} catch {
		worker = null;
		return null;
	}
}

function resetIdleTimer() {
	clearIdleTimer();
	if (pending.size === 0) {
		idleTimer = setTimeout(() => {
			if (pending.size === 0) {
				worker?.terminate();
				worker = null;
			}
		}, IDLE_TIMEOUT_MS);
	}
}

function clearIdleTimer() {
	if (idleTimer !== null) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
}

/**
 * Send a request to the processing worker and return a promise for the
 * response. If the worker is unavailable, the promise rejects with an
 * error — callers should handle this by falling back to main-thread
 * processing.
 */
export function postToWorker(
	request: Omit<ProcessingWorkerRequest, 'id'>,
): Promise<ProcessingWorkerResponse> {
	const w = getOrCreateWorker();
	if (!w) {
		return Promise.reject(new Error('Web Worker not available'));
	}

	const id = nextId++;
	const msg = { ...request, id } as ProcessingWorkerRequest;

	return new Promise<ProcessingWorkerResponse>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		w.postMessage(msg);
	});
}

/**
 * Returns true if the processing worker is available in this environment.
 */
export function isProcessingWorkerSupported(): boolean {
	return isWorkerAvailable();
}

/**
 * Force-terminate the worker (for tests or manual cleanup).
 */
export function terminateWorker(): void {
	worker?.terminate();
	worker = null;
	for (const [, resolver] of pending) {
		resolver.reject(new Error('Worker terminated'));
	}
	pending.clear();
	clearIdleTimer();
}
