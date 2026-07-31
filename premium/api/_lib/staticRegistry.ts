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
 */

export interface PluginDescriptor {
	/** Stable unique id, lowercase kebab-case (e.g. "jira-timesheet-export"). */
	id: string;
	/** Human-readable name shown in plugin listings. */
	name: string;
	/** Short description of what the plugin provides. */
	description: string;
	/** Semantic version of the plugin manifest, e.g. "1.0.0". */
	version: string;
	/**
	 * Capabilities this plugin provides, used for capability-based discovery.
	 * Each entry must be lowercase kebab-case; duplicates are de-duplicated.
	 */
	capabilities: readonly string[];
	/** Optional grouping tag (e.g. "export", "integration"). */
	tags?: readonly string[];
	/** Whether the plugin is active. Defaults to true when omitted. */
	enabled?: boolean;
}

/** A validated descriptor as stored in the registry. */
export type RegisteredPlugin = Readonly<{
	id: string;
	name: string;
	description: string;
	version: string;
	capabilities: readonly string[];
	tags: readonly string[];
	enabled: boolean;
}>;

export type StaticRegistryErrorCode = 'invalid-descriptor' | 'duplicate-id';

export class StaticRegistryError extends Error {
	constructor(
		readonly code: StaticRegistryErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'StaticRegistryError';
	}
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

function assertKebab(value: string, field: string, maxLength: number): void {
	if (value.length === 0) {
		throw new StaticRegistryError(
			'invalid-descriptor',
			`plugin ${field} must not be empty`,
		);
	}
	if (value.length > maxLength) {
		throw new StaticRegistryError(
			'invalid-descriptor',
			`plugin ${field} exceeds ${maxLength} characters`,
		);
	}
	if (!ID_PATTERN.test(value)) {
		throw new StaticRegistryError(
			'invalid-descriptor',
			`plugin ${field} must be lowercase kebab-case, got "${value}"`,
		);
	}
}

function assertText(value: string, field: string, maxLength: number): void {
	if (value.trim().length === 0) {
		throw new StaticRegistryError(
			'invalid-descriptor',
			`plugin ${field} must not be empty`,
		);
	}
	if (value.length > maxLength) {
		throw new StaticRegistryError(
			'invalid-descriptor',
			`plugin ${field} exceeds ${maxLength} characters`,
		);
	}
}

/** Normalize an id/capability/tag to lowercase kebab-case or throw. */
function normalizeToken(value: string, field: string): string {
	const token = value.trim().toLowerCase();
	assertKebab(token, field, MAX_ID_LENGTH);
	return token;
}

function normalizeDescriptor(descriptor: PluginDescriptor): RegisteredPlugin {
	// Ids are a strict contract (referenced verbatim elsewhere): validate
	// exactly as given — no trimming, no re-casing. A whitespace-padded or
	// wrong-cased id is a wiring bug, not something to silently fix.
	const id = descriptor.id;
	assertKebab(id, 'id', MAX_ID_LENGTH);
	assertText(descriptor.name, 'name', MAX_NAME_LENGTH);
	assertText(descriptor.description, 'description', MAX_DESCRIPTION_LENGTH);

	if (!VERSION_PATTERN.test(descriptor.version)) {
		throw new StaticRegistryError(
			'invalid-descriptor',
			`plugin version must be semver x.y.z, got "${descriptor.version}"`,
		);
	}

	if (descriptor.capabilities.length === 0) {
		throw new StaticRegistryError(
			'invalid-descriptor',
			`plugin "${descriptor.id}" must declare at least one capability`,
		);
	}

	const capabilities = [
		...new Set(
			descriptor.capabilities.map((cap) => normalizeToken(cap, 'capability')),
		),
	];
	const tags = descriptor.tags
		? [...new Set(descriptor.tags.map((tag) => normalizeToken(tag, 'tag')))]
		: [];

	return {
		id,
		name: descriptor.name.trim(),
		description: descriptor.description.trim(),
		version: descriptor.version,
		capabilities,
		tags,
		enabled: descriptor.enabled ?? true,
	};
}

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
