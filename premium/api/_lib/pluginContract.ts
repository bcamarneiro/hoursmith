/**
 * Plugin contract and metadata schema (ADA-728).
 *
 * Defines the TypeScript types, validation rules, and error model for plugin
 * metadata. This module is the single source of truth for what a valid plugin
 * descriptor looks like, independent of any runtime registration machinery.
 *
 * Purely declarative — no registry, no process state, no side effects. Import
 * this module from anywhere that needs to validate or reference plugin shapes
 * without coupling to a specific registry implementation.
 */

/** Stable unique id, lowercase kebab-case (e.g. "jira-timesheet-export"). */
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

export function normalizeDescriptor(
	descriptor: PluginDescriptor,
): RegisteredPlugin {
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
