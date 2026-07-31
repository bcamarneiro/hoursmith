/**
 * Structured JSON logger for the serverless functions (ADA-689).
 *
 * Every line is a single JSON object so platform log pipelines (Vercel,
 * Logflare, etc.) can index it without free-text parsing:
 *
 *   {"ts":"...","level":"info","svc":"hoursmith-proxy","msg":"proxy","user_id":"...","status":200}
 *
 * The active level is resolved once at module load:
 *   - `LOG_LEVEL` wins when set (debug | info | warn | error);
 *   - local development defaults to `debug`;
 *   - everything else (tests, production) defaults to `info`.
 * Calls below the active level are dropped before anything is written.
 *
 * Edge-runtime compatible: no external dependencies, no process-global
 * mutation beyond reading `process.env` at import time.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const VALID_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Resolve the active level from env, defaulting by `NODE_ENV`. */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
	const configured = env.LOG_LEVEL?.trim().toLowerCase();
	if (
		configured &&
		(VALID_LEVELS as readonly string[]).includes(configured)
	) {
		return configured as LogLevel;
	}
	return env.NODE_ENV === 'development' ? 'debug' : 'info';
}

const activeLevel = resolveLogLevel();

function write(
	level: LogLevel,
	svc: string,
	message: string,
	fields: LogFields = {},
): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel]) {
		return;
	}
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		svc,
		msg: message,
		...fields,
	});
	if (level === 'error') {
		console.error(line);
	} else if (level === 'warn') {
		console.warn(line);
	} else {
		console.log(line);
	}
}

export interface Logger {
	debug(svc: string, message: string, fields?: LogFields): void;
	info(svc: string, message: string, fields?: LogFields): void;
	warn(svc: string, message: string, fields?: LogFields): void;
	error(svc: string, message: string, fields?: LogFields): void;
}

export const logger: Logger = {
	debug: (svc, message, fields) => write('debug', svc, message, fields),
	info: (svc, message, fields) => write('info', svc, message, fields),
	warn: (svc, message, fields) => write('warn', svc, message, fields),
	error: (svc, message, fields) => write('error', svc, message, fields),
};
