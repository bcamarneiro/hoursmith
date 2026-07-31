/**
 * Execution Runner & handler registry (ADA-744).
 *
 * The runner is the consumer-side heart of the premium execution pipeline:
 * it connects a serialized job payload (the wire envelope from `wireFormat.ts`)
 * to the handler registered for the payload's execution kind, then validates
 * the handler's output against the wire-format result contract before it is
 * returned (and eventually persisted / ACKed by the worker).
 *
 * Flow (`runJob`):
 *   1. `parseJobData` — refuse messages from another wire-format generation.
 *   2. `parseExecutionPayload` — refuse malformed or stale payload envelopes.
 *   3. Look up the handler registered for `payload.kind` (fail loudly when a
 *      kind has no handler — that is a deploy/wiring bug, not a runtime case).
 *   4. Await the handler. An unexpected throw inside a handler is *not* a
 *      crash: it becomes a structured `failed` result (`code: HANDLER_FAILED`)
 *      so the pipeline always observes a valid execution outcome.
 *   5. Transient (retryable) failures are re-run in-process with exponential
 *      backoff per the retry policy (`retryPolicy.ts`, ADA-739) before the
 *      failure result is returned. Retryable means: a handler `throw`s a
 *      `RetryPolicyError` with `retryable: true` (e.g. upstream 5xx), the
 *      handler `throw`s a network `TypeError`, or the handler *returns* a
 *      `failed` result carrying `error.retryable: true`. Permanent failures
 *      (a `RetryPolicyError` with `retryable: false`, or a returned failure
 *      with `error.retryable: false`) are returned immediately.
 *   6. `parseExecutionResult` — reject a handler result that breaks the wire
 *      contract (unknown fields dropped, per-kind success payload enforced).
 *   7. Consistency gates — the result must carry the same `kind` and the same
 *      `executionId` as the payload that produced it; a mismatch is a handler
 *      bug and surfaces loudly.
 *
 * Handlers are registered once at bootstrap from trusted code (mirroring the
 * static registry philosophy in `staticRegistry.ts`): duplicate registration
 * and unknown kinds throw `ExecutionRunnerError` instead of silently
 * overwriting or ignoring. Import the `executionRunner` singleton for
 * production call sites, or construct fresh instances in tests.
 *
 * Edge-runtime compatible and dependency-free, mirroring executionPayload.ts /
 * wireFormat.ts.
 */

import {
	type ExecutionPayload,
	parseExecutionPayload,
} from './executionPayload.js';
import {
	calculateBackoffDelayMs,
	DEFAULT_RETRY_POLICY,
	isRetryableError,
	type RetryPolicy,
	RetryPolicyError,
	resolveRetryPolicy,
} from './retryPolicy.js';
import {
	type ExecutionFailure,
	type ExecutionKind,
	type ExecutionResult,
	parseExecutionResult,
	parseJobData,
} from './wireFormat.js';

/** Error code stamped on failure results produced by unexpected handler throws. */
export const HANDLER_FAILED_ERROR_CODE = 'HANDLER_FAILED';

/**
 * A handler executes one kind of job. It receives the validated payload and
 * returns the wire-format result it produced; it may also *return* a `failed`
 * result for expected failures (e.g. a Jira API error). Unexpected throws are
 * caught by the runner and converted to `HANDLER_FAILED` failure results.
 */
export type ExecutionHandler = (
	payload: ExecutionPayload,
) => ExecutionResult | Promise<ExecutionResult>;

export type ExecutionRunnerErrorCode =
	| 'duplicate-handler'
	| 'invalid-handler'
	| 'unknown-kind'
	| 'no-handler'
	| 'invalid-result';

export class ExecutionRunnerError extends Error {
	constructor(
		readonly code: ExecutionRunnerErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'ExecutionRunnerError';
	}
}

const EXECUTION_KIND_SET = new Set<string>(['reconcile', 'report-export']);

/** Matches wireFormat.ts `MAX_ERROR_MESSAGE_LENGTH` so failure results validate. */
const MAX_ERROR_MESSAGE_LENGTH = 2_000;

export class ExecutionRunner {
	private readonly handlers = new Map<ExecutionKind, ExecutionHandler>();

	/**
	 * Register a handler for an execution kind. Fails loudly on duplicate
	 * registration and on unknown kinds — both are wiring bugs we want to
	 * surface at bootstrap, not discover at runtime.
	 */
	registerHandler(kind: ExecutionKind, handler: ExecutionHandler): void {
		if (!EXECUTION_KIND_SET.has(kind)) {
			throw new ExecutionRunnerError(
				'unknown-kind',
				`cannot register handler for unknown execution kind "${String(kind)}"`,
			);
		}
		if (typeof handler !== 'function') {
			throw new ExecutionRunnerError(
				'invalid-handler',
				`handler for execution kind "${kind}" must be a function`,
			);
		}
		if (this.handlers.has(kind)) {
			throw new ExecutionRunnerError(
				'duplicate-handler',
				`a handler for execution kind "${kind}" is already registered`,
			);
		}
		this.handlers.set(kind, handler);
	}

	/** Remove a handler. Idempotent — unregistering an absent kind is a no-op. */
	unregisterHandler(kind: ExecutionKind): void {
		this.handlers.delete(kind);
	}

	/** True when a handler is registered for this execution kind. */
	hasHandler(kind: ExecutionKind): boolean {
		return this.handlers.has(kind);
	}

	/** Execution kinds with a registered handler, ordered for stable output. */
	registeredKinds(): readonly ExecutionKind[] {
		return Array.from(this.handlers.keys()).sort((a, b) => a.localeCompare(b));
	}

	/**
	 * Execute a serialized job payload (the wire envelope as stored in e.g.
	 * BullMQ job data) end-to-end: version gate, payload validation, handler
	 * dispatch, and result validation. Resolves with a normalized, validated
	 * `ExecutionResult`; throws `WireFormatError`, `ExecutionPayloadError`, or
	 * `ExecutionRunnerError` for producer/handler wiring bugs.
	 *
	 * Retryable handler failures are re-run in-process with exponential
	 * backoff (see the class doc). Pass `retry: false` to disable in-process
	 * retries, or a partial `RetryPolicy` to tune attempts/backoff. Note:
	 * wire/parse/consistency errors still throw immediately — they are
	 * producer bugs, not transient conditions.
	 */
	async runJob(
		rawJobData: unknown,
		options: RunJobOptions = {},
	): Promise<ExecutionResult> {
		const job = parseJobData(rawJobData);
		const payload = parseExecutionPayload(job.payload);

		const handler = this.handlers.get(payload.kind);
		if (handler === undefined) {
			throw new ExecutionRunnerError(
				'no-handler',
				`no handler registered for execution kind "${payload.kind}"`,
			);
		}

		// `null` disables in-process retries; otherwise resolve + validate now
		// so a bad policy fails fast instead of after the first attempt.
		const policy =
			options.retry === false ? null : resolveRetryPolicy(options.retry);

		let rawResult: ExecutionResult;
		let attempts = 0;
		for (;;) {
			try {
				rawResult = await handler(payload);
			} catch (error) {
				if (policy === null || !isRetryableError(error, policy)) {
					return toFailureResult(payload, error);
				}
				if (attempts >= policy.maxAttempts - 1) {
					return toFailureResult(payload, error);
				}
				await delayBeforeRetry(attempts, policy, retryHintOf(error));
				attempts += 1;
				continue;
			}
			if (
				policy === null ||
				!isRetryableFailureResult(rawResult) ||
				attempts >= policy.maxAttempts - 1
			) {
				break;
			}
			await delayBeforeRetry(attempts, policy, null);
			attempts += 1;
		}

		let result: ExecutionResult;
		try {
			result = parseExecutionResult(rawResult);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new ExecutionRunnerError(
				'invalid-result',
				`handler for execution kind "${payload.kind}" returned a result that breaks the wire contract: ${detail}`,
			);
		}
		assertResultConsistency(result, payload);
		return result;
	}
}

/** Options for {@link ExecutionRunner.runJob}. */
export interface RunJobOptions {
	/**
	 * Retry policy for transient handler failures. Defaults to
	 * {@link DEFAULT_RETRY_POLICY}; pass `false` to disable in-process retries.
	 */
	retry?: Partial<RetryPolicy> | false;
}

/**
 * Wrap an unexpected handler throw into a wire-format `failed` result. The
 * `retryable` flag honors a thrown {@link RetryPolicyError} so handlers can
 * mark permanent failures as such; plain errors stay `retryable: true` so the
 * job scheduler keeps its existing re-run behavior.
 */
function toFailureResult(
	payload: ExecutionPayload,
	error: unknown,
): ExecutionFailure {
	const message = error instanceof Error ? error.message : String(error);
	return {
		executionId: payload.executionId,
		kind: payload.kind,
		status: 'failed',
		failedAt: new Date().toISOString(),
		error: {
			code: HANDLER_FAILED_ERROR_CODE,
			message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
			retryable: error instanceof RetryPolicyError ? error.retryable : true,
		},
	};
}

/** A returned failed result is retryable when it says so on the wire. */
function isRetryableFailureResult(result: ExecutionResult): boolean {
	return result.status === 'failed' && result.error.retryable === true;
}

/** Explicit retry delay from a thrown `RetryPolicyError`, if any. */
function retryHintOf(error: unknown): number | null {
	return error instanceof RetryPolicyError ? error.retryAfterMs : null;
}

/** Backoff sleep between attempts, computed from the policy. */
function delayBeforeRetry(
	attempts: number,
	policy: RetryPolicy,
	retryAfterMs: number | null,
): Promise<void> {
	const ms = calculateBackoffDelayMs(attempts, policy, retryAfterMs);
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * A handler result must be about the execution it was asked to run. `kind` and
 * `executionId` are present on both the success and failure variants, so the
 * check covers every result shape.
 */
function assertResultConsistency(
	result: ExecutionResult,
	payload: ExecutionPayload,
): void {
	if (result.kind !== payload.kind) {
		throw new ExecutionRunnerError(
			'invalid-result',
			`handler returned a result for kind "${result.kind}" but the job payload was "${payload.kind}"`,
		);
	}
	if (result.executionId !== payload.executionId) {
		throw new ExecutionRunnerError(
			'invalid-result',
			`handler returned a result for execution "${result.executionId}" but the job payload was "${payload.executionId}"`,
		);
	}
}

/** Process-wide singleton for production call sites. */
export const executionRunner = new ExecutionRunner();
