/**
 * Plugin handler contract (ADA-725).
 *
 * Defines the typed contract a premium plugin's handlers must satisfy: the
 * supported hook names, the handler registration shape, the invocation
 * context/result types, and the validation rules that turn a hand-written
 * handler object into a safe, normalized registration.
 *
 * This is the *contract* layer of the plugin system: it is deliberately
 * dependency-free and edge-runtime compatible (mirroring staticRegistry.ts /
 * entitlement.ts / rateLimit.ts) so any dispatcher, transformer, or runtime
 * can import it without pulling in Node-only or browser-only machinery.
 *
 * Contract guarantees:
 *   - Hook names are a closed, documented union. Adding a hook is a
 *     deliberate contract change, not a silent extension.
 *   - Handlers are validated at registration time and fail loudly
 *     (PluginHandlerError) on a malformed handler or an unknown hook — a
 *     mis-wired handler is a plugin bug we want to surface, not ignore.
 *   - normalizePluginHandler() returns an immutable, frozen registration so
 *     callers can never mutate handler metadata after registration.
 */

/** Hook points a plugin handler may be registered for. */
export type PluginHookName =
	| 'lifecycle'
	| 'webhook'
	| 'request'
	| 'schedule';

/** Every valid hook name, in declaration order. Used by validation. */
export const PLUGIN_HOOKS: readonly PluginHookName[] = [
	'lifecycle',
	'webhook',
	'request',
	'schedule',
];

/** Runtime type guard for the PluginHookName union. */
export function isPluginHookName(value: unknown): value is PluginHookName {
	return (
		typeof value === 'string' &&
		(PLUGIN_HOOKS as readonly string[]).includes(value)
	);
}

/** Limits and defaults that define the handler contract's valid range. */
export const HANDLER_CONTRACT = {
	/** Max length of a handler name (lowercase kebab-case). */
	maxNameLength: 64,
	/** Handlers with equal priority run in registration order. */
	defaultPriority: 0,
	/** Inclusive priority bounds; lower priority runs first. */
	minPriority: -1000,
	maxPriority: 1000,
	/** Default per-invocation timeout for a handler. */
	defaultTimeoutMs: 5_000,
	/** Absolute ceiling for a per-handler timeout override. */
	maxTimeoutMs: 60_000,
} as const;

/**
 * Context passed to a handler on every invocation. `event` carries the
 * hook-specific payload; the remaining fields are filled in by the caller
 * (dispatcher / transformer) before the handler runs.
 */
export interface PluginHandlerContext<TEvent = unknown> {
	readonly pluginId: string;
	readonly handlerName: string;
	readonly hook: PluginHookName;
	readonly event: TEvent;
	/** Epoch milliseconds when the invocation started. */
	readonly startedAt: number;
	/** 1-based invocation attempt; retried invocations see attempt > 1. */
	readonly attempt: number;
	/** Optional cancellation signal propagated from the caller. */
	readonly signal?: AbortSignal;
}

/** A handler function: synchronous or async, throwing or rejecting. */
export type PluginHandlerFn<TEvent = unknown, TResult = unknown> = (
	context: PluginHandlerContext<TEvent>,
) => TResult | Promise<TResult>;

/**
 * Handler registration shape a plugin declares. `name` must be unique within
 * the plugin and lowercase kebab-case; `hook` must be a known PluginHookName.
 */
export interface PluginHandler<TEvent = unknown, TResult = unknown> {
	/** Stable unique name within the plugin, lowercase kebab-case. */
	name: string;
	/** Hook this handler is registered for. */
	hook: PluginHookName;
	/** Ordering hint; lower priority runs first. Defaults to 0. */
	priority?: number;
	/** Per-invocation timeout override. Defaults to HANDLER_CONTRACT.defaultTimeoutMs. */
	timeoutMs?: number;
	/** The handler implementation. */
	handle: PluginHandlerFn<TEvent, TResult>;
}

/** A validated handler as stored by a registry/dispatcher. */
export type RegisteredPluginHandler<TEvent = unknown, TResult = unknown> =
	Readonly<{
		pluginId: string;
		name: string;
		hook: PluginHookName;
		priority: number;
		timeoutMs: number;
		handle: PluginHandlerFn<TEvent, TResult>;
	}>;

export type PluginHandlerErrorCode =
	| 'invalid-handler'
	| 'unknown-hook'
	| 'duplicate-handler'
	| 'handler-timeout'
	| 'handler-rejected'
	| 'handler-crash';

export interface PluginHandlerErrorOptions {
	readonly pluginId?: string;
	readonly handlerName?: string;
	readonly hook?: PluginHookName;
	readonly cause?: unknown;
}

/** Typed error model for handler registration and invocation failures. */
export class PluginHandlerError extends Error {
	readonly code: PluginHandlerErrorCode;
	readonly pluginId?: string;
	readonly handlerName?: string;
	readonly hook?: PluginHookName;
	/** Optional underlying error that caused this failure. */
	readonly cause?: unknown;

	constructor(
		code: PluginHandlerErrorCode,
		message: string,
		options: PluginHandlerErrorOptions = {},
	) {
		super(message);
		this.name = 'PluginHandlerError';
		this.code = code;
		this.pluginId = options.pluginId;
		this.handlerName = options.handlerName;
		this.hook = options.hook;
		this.cause = options.cause;
	}
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function invalidHandler(message: string): never {
	throw new PluginHandlerError('invalid-handler', message);
}

function assertObject(handler: unknown): asserts handler is Record<string, unknown> {
	if (handler === null || typeof handler !== 'object' || Array.isArray(handler)) {
		invalidHandler('plugin handler must be an object');
	}
}

function assertName(name: unknown): asserts name is string {
	if (typeof name !== 'string' || name.length === 0) {
		invalidHandler('plugin handler name must be a non-empty string');
	}
	if (name.length > HANDLER_CONTRACT.maxNameLength) {
		invalidHandler(
			`plugin handler name exceeds ${HANDLER_CONTRACT.maxNameLength} characters`,
		);
	}
	if (!NAME_PATTERN.test(name)) {
		invalidHandler(
			`plugin handler name must be lowercase kebab-case, got "${name}"`,
		);
	}
}

function assertHandle(handle: unknown): asserts handle is PluginHandlerFn {
	if (typeof handle !== 'function') {
		invalidHandler('plugin handler "handle" must be a function');
	}
}

function assertPriority(priority: unknown): asserts priority is number {
	if (priority === undefined) {
		return;
	}
	if (
		typeof priority !== 'number' ||
		!Number.isInteger(priority) ||
		priority < HANDLER_CONTRACT.minPriority ||
		priority > HANDLER_CONTRACT.maxPriority
	) {
		invalidHandler(
			`plugin handler priority must be an integer between ${HANDLER_CONTRACT.minPriority} and ${HANDLER_CONTRACT.maxPriority}`,
		);
	}
}

function assertTimeout(timeoutMs: unknown): asserts timeoutMs is number {
	if (timeoutMs === undefined) {
		return;
	}
	if (
		typeof timeoutMs !== 'number' ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > HANDLER_CONTRACT.maxTimeoutMs
	) {
		invalidHandler(
			`plugin handler timeoutMs must be a positive integer up to ${HANDLER_CONTRACT.maxTimeoutMs}`,
		);
	}
}

/**
 * Validate a handler object. Throws PluginHandlerError('invalid-handler')
 * on a malformed shape or PluginHandlerError('unknown-hook') on an
 * unsupported hook name. Succeeds without returning for valid handlers.
 */
export function validatePluginHandler(handler: unknown): void {
	assertObject(handler);
	assertName(handler.name);
	if (!isPluginHookName(handler.hook)) {
		throw new PluginHandlerError(
			'unknown-hook',
			`unknown plugin hook "${String(handler.hook)}"; expected one of: ${PLUGIN_HOOKS.join(', ')}`,
		);
	}
	assertHandle(handler.handle);
	assertPriority(handler.priority);
	assertTimeout(handler.timeoutMs);
}

/**
 * Validate a handler and produce the immutable registration a
 * registry/dispatcher stores. Throws PluginHandlerError on invalid input.
 */
export function normalizePluginHandler(
	pluginId: string,
	handler: PluginHandler,
): RegisteredPluginHandler {
	validatePluginHandler(handler);
	const registration: RegisteredPluginHandler = {
		pluginId,
		name: handler.name,
		hook: handler.hook,
		priority: handler.priority ?? HANDLER_CONTRACT.defaultPriority,
		timeoutMs: handler.timeoutMs ?? HANDLER_CONTRACT.defaultTimeoutMs,
		handle: handler.handle,
	};
	return Object.freeze(registration);
}
