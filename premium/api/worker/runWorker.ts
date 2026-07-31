#!/usr/bin/env node
/**
 * CLI entrypoint for the premium background worker (ADA-696).
 *
 * Boots a BullMQ worker for a named queue with an explicit processor module,
 * and wires graceful shutdown for SIGINT/SIGTERM. The CLI carries no business
 * logic — the processor module does:
 *
 *   npx tsx premium/api/worker/runWorker.ts --queue raw-commits \
 *     --processor ./dist/processRawCommits.js
 *
 * The processor module must export (default export, `processor`, `process` or
 * `handler`) a BullMQ processor `(job) => Promise<result>`. Job-level retries come from
 * the queue's default job options (`attempts` + exponential `backoff`);
 * connection failures (Redis down) are retried by BullMQ until they clear.
 *
 * Exit codes: 0 on clean shutdown (signal), 1 on usage/startup errors or a
 * forced shutdown (drain timeout / second signal).
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Processor } from 'bullmq';

import { QUEUE_NAMES } from '../_lib/queueProvider.js';
import { registerGracefulShutdown } from './gracefulShutdown.js';
import { createWorker, defaultWorkerLog, type WorkerHandle } from './worker.js';

const USAGE = `Usage:
  npx tsx premium/api/worker/runWorker.ts --queue <name> --processor <module> [options]

Required:
  --processor <module>    Path to a module exporting the processor function
                          (default export, \`processor\`, \`process\` or \`handler\`).

Options:
  --queue <name>          Queue to listen on (default: ${QUEUE_NAMES.RAW_COMMITS}).
  --concurrency <n>       Jobs processed concurrently (default 1).
  --shutdown-timeout-ms <n>  Grace period for in-flight jobs on shutdown (default 30000).
  --help                  Show this help and exit.`;

export interface RunWorkerOptions {
	queue: string;
	processor: string;
	concurrency: number;
	shutdownTimeoutMs: number;
	help: boolean;
}

const DEFAULTS = {
	queue: QUEUE_NAMES.RAW_COMMITS,
	concurrency: 1,
	shutdownTimeoutMs: 30_000,
} as const;

function fail(message: string): never {
	console.error(`[run-worker] ${message}`);
	console.error(USAGE);
	process.exit(1);
}

function parsePositiveInt(raw: string, flag: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		fail(`--${flag} expects a positive integer, got "${raw}".`);
	}
	return value;
}

/** Parse CLI args (exported for tests). */
export function parseRunWorkerArgs(argv: string[]): RunWorkerOptions {
	const options: RunWorkerOptions = {
		queue: DEFAULTS.queue,
		processor: '',
		concurrency: DEFAULTS.concurrency,
		shutdownTimeoutMs: DEFAULTS.shutdownTimeoutMs,
		help: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = (): string => {
			const next = argv[i + 1];
			if (next === undefined) {
				fail(`--${flag} requires a value.`);
			}
			i += 1;
			return next;
		};
		switch (flag) {
			case '--help':
			case '-h':
				options.help = true;
				break;
			case '--queue':
				options.queue = value();
				if (
					!(Object.values(QUEUE_NAMES) as readonly string[]).includes(
						options.queue,
					)
				) {
					fail(
						`unknown queue "${options.queue}". Valid: ${Object.values(QUEUE_NAMES).join(', ')}.`,
					);
				}
				break;
			case '--processor':
				options.processor = value();
				break;
			case '--concurrency':
				options.concurrency = parsePositiveInt(value(), 'concurrency');
				break;
			case '--shutdown-timeout-ms':
				options.shutdownTimeoutMs = parsePositiveInt(
					value(),
					'shutdown-timeout-ms',
				);
				break;
			default:
				fail(`unknown flag "${flag}".`);
		}
	}
	return options;
}

/** Load a processor module (default export or `processor`) — exported for tests. */
export async function loadWorkerProcessor(
	processorPath: string,
): Promise<Processor<unknown, unknown>> {
	const resolved = path.resolve(process.cwd(), processorPath);
	let module: unknown;
	try {
		module = await import(pathToFileURL(resolved).href);
	} catch (error) {
		fail(
			`could not load processor module "${processorPath}": ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const record = module as Record<string, unknown>;
	const processor =
		record.default ?? record.processor ?? record.process ?? record.handler;
	if (typeof processor !== 'function') {
		fail(
			`processor module "${processorPath}" must export a function (default export, \`processor\`, \`process\` or \`handler\`).`,
		);
	}
	return processor as Processor<unknown, unknown>;
}

async function main(): Promise<void> {
	const options = parseRunWorkerArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return;
	}
	if (!options.processor) {
		fail('--processor is required.');
	}

	const processor = await loadWorkerProcessor(options.processor);

	const handle: WorkerHandle<unknown, unknown> = createWorker({
		queueName: options.queue,
		processor,
		concurrency: options.concurrency,
		log: defaultWorkerLog,
	});

	registerGracefulShutdown({
		drain: () => handle.close(),
		timeoutMs: options.shutdownTimeoutMs,
		log: defaultWorkerLog,
	});

	defaultWorkerLog(`listening`, {
		queue: options.queue,
		concurrency: options.concurrency,
	});
}

/** Check whether the current process is running this module as the main entrypoint. */
export function isMainModule(argv1: string | undefined): boolean {
	if (argv1 === undefined) return false;
	const resolved = path.resolve(argv1);
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolved);
	} catch {
		return false;
	}
}

if (isMainModule(process.argv[1])) {
	main().catch((error: unknown) => {
		console.error(
			'[run-worker] fatal:',
			error instanceof Error ? error.message : String(error),
		);
		process.exit(1);
	});
}
