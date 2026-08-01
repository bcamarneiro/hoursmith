/**
 * Tests for the plugin handler contract (ADA-725).
 *
 * Covers hook-name validation, handler registration validation (kebab-case
 * names, known hooks, priority/timeout bounds), the typed error model, and
 * the immutability of normalized registrations.
 */

import { describe, expect, it } from 'vitest';
import {
	HANDLER_CONTRACT,
	PLUGIN_HOOKS,
	PluginHandlerError,
	isPluginHookName,
	normalizePluginHandler,
	validatePluginHandler,
	type PluginHandler,
	type RegisteredPluginHandler,
} from '../pluginHandlers.js';

function validHandler(
	overrides: Partial<Omit<PluginHandler, 'hook'>> & { hook?: unknown } = {},
): PluginHandler {
	return {
		name: 'audit-events',
		hook: 'webhook',
		handle: () => ({ ok: true }),
		...overrides,
	} as PluginHandler;
}

describe('PluginHookName', () => {
	it('declares every hook in the union, in declaration order', () => {
		expect(PLUGIN_HOOKS).toEqual([
			'lifecycle',
			'webhook',
			'request',
			'schedule',
		]);
	});

	it('type guard accepts every declared hook', () => {
		for (const hook of PLUGIN_HOOKS) {
			expect(isPluginHookName(hook)).toBe(true);
		}
	});

	it('type guard rejects unknown values', () => {
		expect(isPluginHookName('export')).toBe(false);
		expect(isPluginHookName('')).toBe(false);
		expect(isPluginHookName(undefined)).toBe(false);
		expect(isPluginHookName(42)).toBe(false);
	});
});

describe('validatePluginHandler', () => {
	it('accepts a valid handler', () => {
		expect(() => validatePluginHandler(validHandler())).not.toThrow();
	});

	it('accepts every declared hook', () => {
		for (const hook of PLUGIN_HOOKS) {
			expect(() => validatePluginHandler(validHandler({ hook }))).not.toThrow();
		}
	});

	it('rejects non-object handlers', () => {
		for (const bad of [null, undefined, 'handler', 42, [], () => {}]) {
			expect(() => validatePluginHandler(bad)).toThrow(PluginHandlerError);
		}
	});

	it('rejects a missing or empty name', () => {
		expect(() => validatePluginHandler(validHandler({ name: '' }))).toThrow(
			PluginHandlerError,
		);
		expect(() =>
			validatePluginHandler(validHandler({ name: undefined })),
		).toThrow(PluginHandlerError);
	});

	it('rejects a non-kebab-case name', () => {
		expect(() =>
			validatePluginHandler(validHandler({ name: 'AuditEvents' })),
		).toThrow(PluginHandlerError);
		expect(() =>
			validatePluginHandler(validHandler({ name: 'audit events' })),
		).toThrow(PluginHandlerError);
	});

	it('rejects an over-long name', () => {
		expect(() =>
			validatePluginHandler(
				validHandler({ name: 'a'.repeat(HANDLER_CONTRACT.maxNameLength + 1) }),
			),
		).toThrow(PluginHandlerError);
	});

	it('rejects an unknown hook with the unknown-hook code', () => {
		try {
			validatePluginHandler(validHandler({ hook: 'export' }));
			throw new Error('expected validatePluginHandler to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(PluginHandlerError);
			expect((error as PluginHandlerError).code).toBe('unknown-hook');
		}
	});

	it('rejects a missing handle', () => {
		expect(() =>
			validatePluginHandler(validHandler({ handle: undefined })),
		).toThrow(PluginHandlerError);
	});

	it('rejects an out-of-range priority', () => {
		expect(() =>
			validatePluginHandler(
				validHandler({ priority: HANDLER_CONTRACT.minPriority - 1 }),
			),
		).toThrow(PluginHandlerError);
		expect(() =>
			validatePluginHandler(
				validHandler({ priority: HANDLER_CONTRACT.maxPriority + 1 }),
			),
		).toThrow(PluginHandlerError);
		expect(() =>
			validatePluginHandler(validHandler({ priority: 1.5 })),
		).toThrow(PluginHandlerError);
	});

	it('rejects an invalid timeoutMs', () => {
		expect(() => validatePluginHandler(validHandler({ timeoutMs: 0 }))).toThrow(
			PluginHandlerError,
		);
		expect(() =>
			validatePluginHandler(
				validHandler({ timeoutMs: HANDLER_CONTRACT.maxTimeoutMs + 1 }),
			),
		).toThrow(PluginHandlerError);
		expect(() =>
			validatePluginHandler(validHandler({ timeoutMs: 100.5 })),
		).toThrow(PluginHandlerError);
	});

	it('uses the invalid-handler code for shape violations', () => {
		try {
			validatePluginHandler(validHandler({ name: 'bad name' }));
			throw new Error('expected validatePluginHandler to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(PluginHandlerError);
			expect((error as PluginHandlerError).code).toBe('invalid-handler');
		}
	});
});

describe('normalizePluginHandler', () => {
	it('applies defaults for priority and timeoutMs', () => {
		const registration = normalizePluginHandler('jira-export', validHandler());
		expect(registration).toMatchObject({
			pluginId: 'jira-export',
			name: 'audit-events',
			hook: 'webhook',
			priority: HANDLER_CONTRACT.defaultPriority,
			timeoutMs: HANDLER_CONTRACT.defaultTimeoutMs,
		});
		expect(typeof registration.handle).toBe('function');
	});

	it('preserves explicit priority and timeoutMs', () => {
		const registration = normalizePluginHandler(
			'jira-export',
			validHandler({ priority: 10, timeoutMs: 250 }),
		);
		expect(registration.priority).toBe(10);
		expect(registration.timeoutMs).toBe(250);
	});

	it('returns a frozen registration', () => {
		const registration: RegisteredPluginHandler = normalizePluginHandler(
			'jira-export',
			validHandler(),
		);
		expect(Object.isFrozen(registration)).toBe(true);
		expect(() => {
			(registration as { priority: number }).priority = 99;
		}).toThrow();
	});

	it('throws PluginHandlerError for invalid handlers', () => {
		expect(() =>
			normalizePluginHandler('jira-export', validHandler({ hook: 'nope' })),
		).toThrow(PluginHandlerError);
	});
});
