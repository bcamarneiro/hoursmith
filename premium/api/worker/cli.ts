#!/usr/bin/env node
/**
 * CLI entrypoint for the premium batch worker (ADA-710).
 *
 * Runs the generic batch worker against a BullMQ queue with an explicit
 * processor module, so the CLI itself carries no business logic:
 *
 *   npm run worker:premium -- --queue raw-commits \
 *     --processor ./dist/processRawCommits.js
 *
 * The processor module must default-export (or export `processor`)
 * `(payload) => Promise<result>`. Job-level retries come from the queue's
 * default job options (`attempts` + exponential `backoff`); connection
 * failures (Redis down) are retried by the worker with its own backoff policy
 * until the connection returns.
 *
 * Exit codes: 0 on clean stop (signal or `--once` drain complete), 1 on usage
 * or startup errors.
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { closeQueue, createQueue, QUEUE_NAMES } from '../_lib/queueProvider.js';
import type { BackoffOptions } from './backoff.js';
import { type BatchWorker, createBatchWorker } from './batchWorker.js';

const USAGE = `Usage:
  tsx premium/api/worker/cli.ts --queue <name> --processor <module> [options]

Required:
  --queue <name>          Queue to drain (default: ${QUEUE_NAMES.RAW_COMMITS}).
  --processor <module>    Path to a module exporting the processor function.

Options:
  --batch-size <n>        Jobs per batch (default 10).
  --concurrency <n>       Concurrent payloads inside a batch (default: batch size).
  --poll-interval-ms <n>  Idle delay between batches when empty (default 5000).
  --connection-initial-delay-ms <n>  First connection-retry delay (default 1000).
  --connection-max-delay-ms <n>      Cap for connection-retry delay (default 30000).
  --connection-factor <n>            Backoff growth factor (default 2).
  --once                  Drain until the queue is empty, then exit 0.
  --help                  Show this help and exit.`;

interface CliOptions {
	queue: string;
	processor: string;
	batchSize: number;
	concurrency: number;
	pollIntervalMs: number;
	connectionBackoff: BackoffOptions;
	once: boolean;
	help: boolean;
}

const DEFAULTS = {
	queue: QUEUE_NAMES.RAW_COMMITS,
	batchSize: 10,
	pollIntervalMs: 5_000,
	initialDelayMs: 1_000,
	maxDelayMs: 30_000,
	factor: 2,
} as const;

function fail(message: string): never {
	console.error(`[cli] ${message}`);
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

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		queue: DEFAULTS.queue,
		processor: '',
		batchSize: DEFAULTS.batchSize,
		concurrency: 0,
		pollIntervalMs: DEFAULTS.pollIntervalMs,
		connectionBackoff: {
			initialDelayMs: DEFAULTS.initialDelayMs,
			maxDelayMs: DEFAULTS.maxDelayMs,
			factor: DEFAULTS.factor,
			jitter: true,
		},
		once: false,
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
				break;
			case '--processor':
				options.processor = value();
				break;
			case '--batch-size':
				options.batchSize = parsePositiveInt(value(), 'batch-size');
				break;
			case '--concurrency':
				options.concurrency = parsePositiveInt(value(), 'concurrency');
				break;
			case '--poll-interval-ms':
				options.pollIntervalMs = parsePositiveInt(value(), 'poll-interval-ms');
				break;
			case '--connection-initial-delay-ms':
				options.connectionBackoff.initialDelayMs = parsePositiveInt(
					value(),
					'connection-initial-delay-ms',
				);
				break;
			case '--connection-max-delay-ms':
				options.connectionBackoff.maxDelayMs = parsePositiveInt(
					value(),
					'connection-max-delay-ms',
				);
				break;
			case '--connection-factor': {
				const raw = value();
				const factor = Number(raw);
				if (!Number.isFinite(factor) || factor < 1) {
					fail(`--connection-factor expects a number >= 1, got "${raw}".`);
				}
				options.connectionBackoff.factor = factor;
				break;
			}
			case '--once':
				options.once = true;
				break;
			default:
				fail(`unknown flag "${flag}".`);
		}
	}
	return options;
}

async function loadProcessor(
	processorPath: string,
): Promise<(payload: unknown) => Promise<unknown>> {
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
			`processor module "${processorPath}" must export a function (default export or \`processor\`).`,
		);
	}
	return processor as (payload: unknown) => Promise<unknown>;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return;
	}
	if (!options.processor) {
		fail('--processor is required.');
	}
	if (options.connectionBackoff.maxDelayMs < options.connectionBackoff.initialDelayMs) {
		fail('--connection-max-delay-ms must be >= --connection-initial-delay-ms.');
	}

	const processor = await loadProcessor(options.processor);
	const queue = createQueue(options.queue);
	const worker: BatchWorker = createBatchWorker({
		queue,
		processor,
		batchSize: options.batchSize,
		concurrency: options.concurrency || options.batchSize,
		pollIntervalMs: options.pollIntervalMs,
		connectionBackoff: options.connectionBackoff,
		log: (message, extra) => {
			const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
			console.log(`[worker] ${message}${suffix}`);
		},
		onBatchComplete:
			options.once
				? async (batch) => {
						console.log(
							`[cli] drained batch (${batch.succeeded} ok, ${batch.failed} failed); checking for more…`,
						);
						const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
						if (counts.waiting + counts.active + counts.delayed === 0) {
							console.log('[cli] queue empty; exiting (--once).');
							// Do not await here: stop() waits for the loop, which is
							// currently inside this callback. Fire-and-forget lets the
							// current iteration finish and the loop observe `stopped`.
							void worker.stop();
						}
				  }
				: undefined,
	});

	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		console.log(`[cli] ${signal} received; stopping worker…`);
		await worker.stop();
		await closeQueue(queue);
		process.exit(0);
	};
	process.on('SIGINT', () => {
		void shutdown('SIGINT');
	});
	process.on('SIGTERM', () => {
		void shutdown('SIGTERM');
	});

	console.log(
		`[cli] starting worker queue="${options.queue}" batchSize=${options.batchSize} concurrency=${options.concurrency || options.batchSize} once=${options.once}`,
	);
	await worker.start();
}

main().catch((error: unknown) => {
	console.error(
		'[cli] fatal:',
		error instanceof Error ? error.message : String(error),
	);
	process.exit(1);
});
