/**
 * Graceful shutdown for background workers (ADA-696).
 *
 * Installs SIGINT/SIGTERM handlers that drain the worker before exiting:
 *
 *   - First signal: log, run the `drain` callback (the worker stops accepting
 *     new jobs and waits for active ones), then `exit(0)`.
 *   - Drain error or timeout: log and `exit(1)` — a hung job must not leave
 *     the process alive forever; BullMQ will re-queue stalled jobs.
 *   - Second signal: `exit(1)` immediately (operator asked twice).
 *
 * Returns an `unregister` fn so tests (and other callers) can remove the
 * handlers without affecting the process.
 */

import type { WorkerLogFn } from './worker.js';

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
export const DEFAULT_SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export interface GracefulShutdownOptions {
	/** Runs once on the first signal; must drain in-flight work. */
	drain: () => Promise<void>;
	/** How long `drain` may take before forcing exit(1) (default 30s). */
	timeoutMs?: number;
	/** Signals to listen for (default SIGINT + SIGTERM). */
	signals?: NodeJS.Signals[];
	/** Exit override — tests inject a spy here. Defaults to `process.exit`. */
	exit?: (code: number) => never;
	/** Log sink (defaults to the worker's console log). */
	log?: WorkerLogFn;
}

/** Install graceful-shutdown handlers; returns an `unregister` function. */
export function registerGracefulShutdown(
	options: GracefulShutdownOptions,
): () => void {
	const {
		drain,
		timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
		signals = DEFAULT_SHUTDOWN_SIGNALS,
		exit = (code: number): never => process.exit(code),
		log = (message: string): void => console.log(`[worker] ${message}`),
	} = options;

	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error(`timeoutMs must be a positive number, got "${timeoutMs}".`);
	}

	let shuttingDown = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const finish = (code: number): never => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		return exit(code);
	};

	const onSignal = (signal: NodeJS.Signals): void => {
		if (shuttingDown) {
			log(`second ${signal} received; exiting immediately`);
			exit(1);
			return;
		}
		shuttingDown = true;
		log(`${signal} received; draining…`);

		timer = setTimeout(() => {
			log(`drain timed out after ${timeoutMs}ms; forcing exit`);
			exit(1);
		}, timeoutMs);

		drain()
			.then(() => {
				log('drain complete; exiting');
				finish(0);
			})
			.catch((error: unknown) => {
				log('drain failed; exiting', {
					error: error instanceof Error ? error.message : String(error),
				});
				finish(1);
			});
	};

	for (const signal of signals) {
		process.on(signal, onSignal);
	}

	return () => {
		for (const signal of signals) {
			process.off(signal, onSignal);
		}
	};
}
