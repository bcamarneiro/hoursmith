/**
 * Core Scheduler Service — job registration, lifecycle management, and status
 * tracking for cron-based recurring tasks (ADA-662).
 *
 * Wraps the croner library to provide a clean, typed interface for the Hoursmith
 * frontend. Each job is keyed by name, supports pause/resume/stop, and exposes
 * runtime status for UI introspection.
 *
 * Croner is browser-compatible — no Node.js runtime dependency. The underlying
 * timer is setTimeout-based; this service adds typed configuration, error
 * handling, and a lifecycle API on top.
 */

import { Cron } from 'croner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback signature for a scheduled job. Receives the Cron instance. */
export type JobHandler = (job: Cron) => void | Promise<void>;

/** Error handler — invoked when a job handler throws. */
export type ErrorHandler = (error: unknown, jobName: string) => void;

/** User-facing configuration for registering a scheduled job. */
export interface JobConfig {
	/** Cron expression (5–7 parts, e.g. `'0 9 * * 1-5'`). */
	cronExpression: string;
	/** Unique name — used for lookup and status reporting. */
	name: string;
	/** Function executed on each tick. */
	handler: JobHandler;
	/** Optional human-readable description. */
	description?: string;
	/** Start paused? Defaults to false (auto-starts on registration). */
	paused?: boolean;
	/** Max number of runs before the job self-stops. */
	maxRuns?: number;
	/** Skip the tick if the previous invocation is still in flight. */
	protect?: boolean;
	/** Called when the handler throws. Defaults to console.error. */
	errorHandler?: ErrorHandler;
}

/** Runtime status for a single job, suitable for UI rendering. */
export interface JobStatus {
	name: string;
	description?: string;
	running: boolean;
	paused: boolean;
	stopped: boolean;
	busy: boolean;
	nextRun: Date | null;
	lastRun: Date | null;
	previousRun: Date | null;
	runsLeft: number | undefined;
	pattern: string | undefined;
	/** Total number of handler errors since registration. */
	errorCount: number;
	/** Timestamp of the most recent handler error, if any. */
	lastError: Date | null;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Bookkeeping tracked alongside each Cron instance. */
interface JobMeta {
	config: JobConfig;
	errorCount: number;
	lastError: Date | null;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
	private readonly jobs = new Map<string, Cron>();
	private readonly meta = new Map<string, JobMeta>();

	/**
	 * Register a new cron job. If a job with the same name already exists it is
	 * stopped first (idempotent re-registration).
	 */
	register(config: JobConfig): Cron {
		// Idempotent — if re-registering, stop the old one first.
		if (this.jobs.has(config.name)) {
			this.stop(config.name);
		}

		const job = new Cron(config.cronExpression, { name: config.name }, () => {
			try {
				config.handler(job);
			} catch (err: unknown) {
				const meta = this.meta.get(config.name);
				if (meta) {
					meta.errorCount += 1;
					meta.lastError = new Date();
				}
				if (config.errorHandler) {
					config.errorHandler(err, config.name);
				} else {
					console.error(`[Scheduler] Unhandled error in job "${config.name}":`, err);
				}
			}
		});

		if (config.maxRuns !== undefined) {
			// croner accepts maxRuns via options at construction time, but the
			// constructor signature doesn't expose it directly. Set on options.
			(job.options as Record<string, unknown>).maxRuns = config.maxRuns;
		}
		if (config.protect) {
			(job.options as Record<string, unknown>).protect = true;
		}

		this.jobs.set(config.name, job);
		this.meta.set(config.name, {
			config,
			errorCount: 0,
			lastError: null,
		});

		if (config.paused) {
			job.pause();
		}

		return job;
	}

	/** Pause a running job. No-op if the job doesn't exist. */
	pause(name: string): boolean {
		const job = this.jobs.get(name);
		if (!job) return false;
		return job.pause();
	}

	/** Resume a paused job. No-op if the job doesn't exist. */
	resume(name: string): boolean {
		const job = this.jobs.get(name);
		if (!job) return false;
		return job.resume();
	}

	/** Permanently stop a single job. */
	stop(name: string): void {
		const job = this.jobs.get(name);
		if (!job) return;
		job.stop();
		this.jobs.delete(name);
		this.meta.delete(name);
	}

	/** Permanently stop all registered jobs. */
	stopAll(): void {
		this.jobs.forEach((job) => {
			job.stop();
		});
		this.jobs.clear();
		this.meta.clear();
	}

	/** Return runtime status for every registered job. */
	getJobs(): JobStatus[] {
		const result: JobStatus[] = [];
		this.jobs.forEach((job, name) => {
			const m = this.meta.get(name);
			result.push(this._buildStatus(name, job, m));
		});
		return result;
	}

	/** Return runtime status for a single job, or undefined. */
	getJob(name: string): JobStatus | undefined {
		const job = this.jobs.get(name);
		if (!job) return undefined;
		return this._buildStatus(name, job, this.meta.get(name));
	}

	/** Number of currently registered jobs. */
	get count(): number {
		return this.jobs.size;
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private _buildStatus(name: string, job: Cron, meta?: JobMeta): JobStatus {
		return {
			name,
			description: meta?.config.description,
			running: job.isRunning(),
			paused: !job.isRunning() && !job.isStopped(),
			stopped: job.isStopped(),
			busy: job.isBusy(),
			nextRun: job.nextRun(),
			lastRun: job.currentRun(),
			previousRun: job.previousRun(),
			runsLeft: job.runsLeft(),
			pattern: job.getPattern() ?? undefined,
			errorCount: meta?.errorCount ?? 0,
			lastError: meta?.lastError ?? null,
		};
	}
}

/**
 * Default scheduler singleton. Import this for shared state across the app.
 * For test isolation, instantiate a new Scheduler() directly.
 */
export const scheduler = new Scheduler();
