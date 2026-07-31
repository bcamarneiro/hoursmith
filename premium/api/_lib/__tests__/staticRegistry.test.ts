/**
 * Tests for the static plugin registry (ADA-729).
 *
 * Covers registration validation (kebab-case ids, semver versions, capability
 * requirements, duplicate detection), capability-based discovery, and the
 * immutability guarantees on every read path.
 */

import { describe, expect, it } from 'vitest';
import {
	StaticRegistry,
	StaticRegistryError,
	staticRegistry,
	type PluginDescriptor,
} from '../staticRegistry.js';

function validPlugin(
	overrides: Partial<PluginDescriptor> = {},
): PluginDescriptor {
	return {
		id: 'jira-export',
		name: 'Jira Export',
		description: 'Exports timesheets to Jira.',
		version: '1.0.0',
		capabilities: ['export', 'jira'],
		tags: ['integration'],
		...overrides,
	};
}

describe('registerPlugin', () => {
	it('registers a valid descriptor and returns a snapshot', () => {
		const registry = new StaticRegistry();
		const snapshot = registry.registerPlugin(validPlugin());

		expect(snapshot.id).toBe('jira-export');
		expect(snapshot.enabled).toBe(true);
		expect(registry.size).toBe(1);
	});

	it('normalizes capabilities and tags (deduped, lowercased)', () => {
		const registry = new StaticRegistry();
		registry.registerPlugin(
			validPlugin({
				capabilities: ['Export', 'Jira', 'export'],
				tags: ['Integration', 'integration'],
			}),
		);

		expect(registry.getPlugin('jira-export')).toBeDefined();
		const snapshot = registry.getPlugin('jira-export');
		expect(snapshot?.capabilities).toEqual(['export', 'jira']);
		expect(snapshot?.tags).toEqual(['integration']);
	});

	it('defaults enabled to true', () => {
		const registry = new StaticRegistry();
		const snapshot = registry.registerPlugin(
			validPlugin({ enabled: undefined }),
		);
		expect(snapshot.enabled).toBe(true);
	});

	it('rejects a duplicate id with duplicate-id error', () => {
		const registry = new StaticRegistry();
		registry.registerPlugin(validPlugin());

		expect(() => registry.registerPlugin(validPlugin())).toThrow(
			StaticRegistryError,
		);
		expect(() =>
			registry.registerPlugin(
				validPlugin({ id: 'jira-export', name: 'Duplicate' }),
			),
		).toThrowError(expect.objectContaining({ code: 'duplicate-id' }));
		expect(registry.size).toBe(1);
	});

	it('rejects malformed ids with invalid-descriptor error', () => {
		const registry = new StaticRegistry();
		// Ids are a strict contract: mixed case, leading/trailing whitespace,
		// and anything that is not already lowercase kebab-case is rejected
		// rather than silently re-cased.
		for (const badId of [
			'',
			'Bad_Id',
			'has spaces',
			'UPPER',
			'  Jira-Export ',
			'jira-export ',
			'a'.repeat(65),
		]) {
			expect(() =>
				registry.registerPlugin(validPlugin({ id: badId })),
			).toThrowError(expect.objectContaining({ code: 'invalid-descriptor' }));
		}
		expect(registry.size).toBe(0);
	});

	it('rejects non-semver versions', () => {
		const registry = new StaticRegistry();
		for (const version of ['', '1', 'v1.0.0', '1.0']) {
			expect(() =>
				registry.registerPlugin(validPlugin({ version })),
			).toThrowError(expect.objectContaining({ code: 'invalid-descriptor' }));
		}
	});

	it('rejects empty name, description, or capabilities', () => {
		const registry = new StaticRegistry();
		expect(() => registry.registerPlugin(validPlugin({ name: '  ' }))).toThrow(
			StaticRegistryError,
		);
		expect(() =>
			registry.registerPlugin(validPlugin({ description: '' })),
		).toThrow(StaticRegistryError);
		expect(() =>
			registry.registerPlugin(validPlugin({ capabilities: [] })),
		).toThrow(StaticRegistryError);
		expect(registry.size).toBe(0);
	});
});

describe('queries', () => {
	it('returns undefined for an unregistered id', () => {
		const registry = new StaticRegistry();
		expect(registry.getPlugin('nope')).toBeUndefined();
		expect(registry.isRegistered('nope')).toBe(false);
	});

	it('lists all plugins ordered by id', () => {
		const registry = new StaticRegistry();
		registry.registerPlugin(validPlugin({ id: 'zeta-export', name: 'Zeta' }));
		registry.registerPlugin(validPlugin({ id: 'alpha-export', name: 'Alpha' }));

		expect(registry.listPlugins().map((p) => p.id)).toEqual([
			'alpha-export',
			'zeta-export',
		]);
	});

	it('finds enabled plugins by capability', () => {
		const registry = new StaticRegistry();
		registry.registerPlugin(
			validPlugin({
				id: 'csv-export',
				capabilities: ['export', 'csv'],
			}),
		);
		registry.registerPlugin(
			validPlugin({
				id: 'jira-sync',
				capabilities: ['jira'],
				enabled: false,
			}),
		);

		expect(registry.findPluginsByCapability('export').map((p) => p.id)).toEqual(
			['csv-export'],
		);
		// Disabled plugins are hidden unless explicitly requested.
		expect(registry.findPluginsByCapability('jira')).toEqual([]);
		expect(
			registry
				.findPluginsByCapability('jira', { includeDisabled: true })
				.map((p) => p.id),
		).toEqual(['jira-sync']);
		// Capability matching is case-insensitive.
		expect(registry.findPluginsByCapability('EXPORT').map((p) => p.id)).toEqual(
			['csv-export'],
		);
	});
});

describe('safety (immutability)', () => {
	it('returns fresh snapshots: mutating results does not affect the registry', () => {
		const registry = new StaticRegistry();
		registry.registerPlugin(validPlugin());

		const first = registry.getPlugin('jira-export');
		const second = registry.getPlugin('jira-export');
		expect(first).not.toBe(second);

		expect(Object.isFrozen(first)).toBe(true);
		expect(() => {
			// @ts-expect-error snapshots are frozen
			first.name = 'mutated';
		}).toThrow();

		// Mutating an array snapshot is a no-op for the registry.
		const listed = registry.listPlugins();
		listed.push(
			validPlugin({ id: 'fake-extra', capabilities: ['export'] }) as never,
		);
		expect(registry.size).toBe(1);
		expect(registry.listPlugins()).toHaveLength(1);
	});

	it('ignores later mutation of the original descriptor', () => {
		const registry = new StaticRegistry();
		const descriptor = validPlugin({ capabilities: ['export'] });
		registry.registerPlugin(descriptor);

		// Mutating the caller's copy after registration must not leak in.
		(descriptor.capabilities as string[]).push('secret-cap');
		(descriptor as { id: string }).id = 'hijacked';

		const snapshot = registry.getPlugin('jira-export');
		expect(snapshot?.capabilities).toEqual(['export']);
		expect(snapshot?.id).toBe('jira-export');
	});
});

describe('singleton', () => {
	it('exports a shared process-wide instance', () => {
		expect(staticRegistry).toBeInstanceOf(StaticRegistry);
	});
});
