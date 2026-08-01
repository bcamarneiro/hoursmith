/**
 * Static registry of premium plugins (ADA-729).
 *
 * Plugins declare themselves once at process bootstrap via registerPlugin();
 * the registry keeps them in a process-local Map and answers discovery
 * queries (by id, full listing, capability match). This is a *static*
 * registry by design: registration happens at startup from trusted code,
 * never from runtime user input, so there is no dynamic install surface.
 *
 * Safety guarantees:
 *   - Registration validates the descriptor and fails loudly (StaticRegistryError)
 *     on a malformed manifest or a duplicate id — a second plugin claiming the
 *     same id is a wiring bug we want to surface, not silently overwrite.
 *   - Every read returns an immutable, deep-frozen snapshot: callers can
 *     never mutate registry state through a query result, and mutating a
 *     descriptor after registration has no effect.
 *   - Capability discovery only surfaces *enabled* plugins unless the caller
 *     explicitly opts into disabled ones (admin/tooling).
 *
 * Edge-runtime compatible and dependency-free, mirroring entitlement.ts /
 * rateLimit.ts. Module state is process-local; import the singleton for
 * production call sites, or construct fresh instances in tests.
 *
 * The contract (types, validation, error model) lives in pluginContract.ts
 * (ADA-728) so it can be consumed independently of the registry.
 */

import {
	type PluginDescriptor,
	type RegisteredPlugin,
	normalizeDescriptor,
	StaticRegistryError,
} from './pluginContract.js';

// Re-export the contract so existing consumers aren't broken.
export {
	type PluginDescriptor,
	type RegisteredPlugin,
	StaticRegistryError,
	type StaticRegistryErrorCode,
} from './pluginContract.js';

/** Deep-freeze a clone so callers get a safe, immutable snapshot. */
function freezeSnapshot<T>(value: T): T {
	const snapshot = structuredClone(value) as T;
	const freeze = (node: unknown): void => {
		if (node && typeof node === 'object' && !Object.isFrozen(node)) {
			Object.freeze(node);
			for (const child of Object.values(node)) {
				freeze(child);
			}
		}
	};
	freeze(snapshot);
	return snapshot;
}

export class StaticRegistry {
	private readonly plugins = new Map<string, RegisteredPlugin>();

	/**
	 * Register a plugin manifest. Fails loudly on malformed descriptors and on
	 * duplicate ids. Returns the immutable snapshot that is now stored.
	 */
	registerPlugin(descriptor: PluginDescriptor): RegisteredPlugin {
		const normalized = normalizeDescriptor(descriptor);
		if (this.plugins.has(normalized.id)) {
			throw new StaticRegistryError(
				'duplicate-id',
				`plugin "${normalized.id}" is already registered`,
			);
		}
		this.plugins.set(normalized.id, normalized);
		return freezeSnapshot(normalized);
	}

	/** Look up a single plugin by id, or undefined when not registered. */
	getPlugin(id: string): RegisteredPlugin | undefined {
		const found = this.plugins.get(id.trim().toLowerCase());
		return found ? freezeSnapshot(found) : undefined;
	}

	/** True when a plugin with this id is registered. */
	isRegistered(id: string): boolean {
		return this.plugins.has(id.trim().toLowerCase());
	}

	/** Number of registered plugins. */
	get size(): number {
		return this.plugins.size;
	}

	/** Snapshot of every registered plugin, ordered by id. */
	listPlugins(): RegisteredPlugin[] {
		return [...this.plugins.values()]
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((plugin) => freezeSnapshot(plugin));
	}

	/**
	 * Discover plugins providing a capability. Only enabled plugins are
	 * returned unless `includeDisabled` is set (admin/tooling).
	 */
	findPluginsByCapability(
		capability: string,
		options: { includeDisabled?: boolean } = {},
	): RegisteredPlugin[] {
		const token = capability.trim().toLowerCase();
		return this.listPlugins().filter(
			(plugin) =>
				plugin.capabilities.includes(token) &&
				(options.includeDisabled === true || plugin.enabled),
		);
	}
}

/** Process-wide singleton for production call sites. */
export const staticRegistry = new StaticRegistry();
