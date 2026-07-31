/**
 * In-memory key rotation logic for Hoursmith Premium (ADA-713).
 *
 * The encryption service (ADA-705 `encryptionService.ts`) is a stateless,
 * immutable key ring: you construct it from environment variables and it
 * stays that way until the next deployment. This module is the stateful
 * runtime counterpart — the in-memory logic that drives key rotation in a
 * long-lived process:
 *
 *   - Active key selection: `selectActiveKey(id)` switches which key new
 *     ciphertext is written under. Every other key stays in the ring, so
 *     payloads written under a previous active key keep decrypting — the
 *     same rotation semantics as the env-configured legacy map, but
 *     available at runtime without a redeploy.
 *   - Key generation: `generateKey()` / `rotate()` draw a fresh
 *     cryptographically-random secret (32 bytes, base64url) with a unique
 *     key id, then promote it to active. Rotation never loses read access:
 *     the retiring key remains decryptable until it is explicitly removed
 *     from the ring.
 *   - Context switching: `switchContext(aad)` swaps the active AAD context.
 *     Ciphertext is bound to its context by the GCM tag (see
 *     `aesCrypto.ts`), so each context keeps its own independent key ring
 *     (e.g. `hoursmith:user-tokens:v1`, `hoursmith:export-tokens:v2`).
 *     Switching context is cheap and lossless — every ring is kept in
 *     memory, and switching back restores the previous keys and active-key
 *     selection.
 *
 * The manager is a thin facade over `EncryptionService`: encrypt/decrypt
 * delegate to the current context's ring, rebuilt lazily whenever the ring
 * changes. Mutations are synchronous and crypto operations capture their
 * ring synchronously before the first await, so a rotate mid-operation
 * cannot corrupt an in-flight encrypt/decrypt in a single-threaded runtime.
 *
 * Rotation recipe (paired with the stateless transform in ADA-709
 * `reencrypt.ts`):
 *
 *   1. `const nextId = manager.rotate()` — generate + activate a new key.
 *   2. `const ring = manager.exportKeys()` — read the in-memory ring (the
 *      operator owns these secrets; they never leave the process).
 *   3. Re-encrypt legacy rows with `reencryptPayload` from the retiring
 *      key's secret to `nextId`'s secret, then drop the retired key from
 *      the ring on the next deploy.
 *
 * Dependency-free WebCrypto so this stays edge-runtime compatible,
 * mirroring `encryptionService.ts` and `aesCrypto.ts`.
 *
 * Linear: ADA-713.
 */

import {
	type EncryptionKey,
	EncryptionService,
	type EncryptionServiceOptions,
} from './encryptionService.js';

/** AAD context used when none is supplied — matches `AesCipher`. */
export const DEFAULT_AAD = 'hoursmith:user-tokens:v1';
/** Key ids must be URL-safe tokens — they travel in plaintext headers. */
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Generated secrets are 256-bit random values (32 bytes). */
const SECRET_BYTES = 32;

export interface KeyRotationManagerOptions {
	/**
	 * PBKDF2-HMAC-SHA256 iteration count passed through to `EncryptionService`
	 * (and `AesCipher`). Defaults to the OWASP-recommended 600_000.
	 */
	iterations?: number;
	/**
	 * Initial AAD context. Defaults to `hoursmith:user-tokens:v1`. Use
	 * `switchContext` afterwards to move between contexts at runtime.
	 */
	aad?: string;
	/**
	 * Id of the key used for `encrypt` after construction. Defaults to the
	 * first key, mirroring `EncryptionServiceOptions.activeKeyId`.
	 */
	activeKeyId?: string;
	/**
	 * Test seam: generates the next key id when `generateKey` is called
	 * without an explicit id. Receives every id already in the current
	 * context's ring and must return an id not in that set (validated).
	 * Defaults to a `k1`, `k2`, … counter that never collides.
	 */
	generateId?: (existing: ReadonlySet<string>) => string;
}

/** Per-context ring state. */
interface Ring {
	/** id → secret, in insertion order. */
	secrets: Map<string, string>;
	/** Key used for new ciphertext. Always set when the ring is non-empty. */
	activeId: string | null;
	/** Lazily rebuilt `EncryptionService` for this ring. */
	service: EncryptionService | null;
}

/**
 * Stateful in-memory key ring with rotation lifecycle.
 *
 * The ring is per-context (see `switchContext`). All mutating operations
 * target the current context; read operations (`activeKeyId`, `listKeyIds`,
 * `hasKey`, `exportKeys`) report on the current context.
 */
export class KeyRotationManager {
	private readonly iterations: number | undefined;
	private readonly generateId: (existing: ReadonlySet<string>) => string;
	private readonly rings = new Map<string, Ring>();
	private currentAad: string;
	private currentRing: Ring;

	constructor(keys: EncryptionKey[], options: KeyRotationManagerOptions = {}) {
		this.iterations = options.iterations;
		this.generateId = options.generateId ?? defaultGenerateId;

		const aad = options.aad ?? DEFAULT_AAD;
		if (aad.length === 0) {
			throw new Error(
				'keyRotationManager: AAD context must be a non-empty string.',
			);
		}
		this.currentAad = aad;
		this.currentRing = buildRing(keys, options.activeKeyId);
		this.rings.set(aad, this.currentRing);
	}

	// -----------------------------------------------------------------------
	// Crypto facade (current context)
	// -----------------------------------------------------------------------

	/** Encrypt `plaintext` under the current context's active key. */
	async encrypt(plaintext: string): Promise<string> {
		return this.service().encrypt(plaintext);
	}

	/** Decrypt an `hsenc:` payload written under the current context. */
	async decrypt(payload: string): Promise<string> {
		return this.service().decrypt(payload);
	}

	// -----------------------------------------------------------------------
	// Active key selection
	// -----------------------------------------------------------------------

	/**
	 * Make `id` the active key for the current context. The previously
	 * active key remains in the ring, so old payloads keep decrypting —
	 * selection only decides where new ciphertext goes.
	 */
	selectActiveKey(id: string): void {
		this.requireRing();
		if (!this.currentRing.secrets.has(id)) {
			throw new Error(
				`keyRotationManager.selectActiveKey: unknown key id "${id}" in context "${this.currentAad}".`,
			);
		}
		if (this.currentRing.activeId === id) return;
		this.currentRing.activeId = id;
		this.currentRing.service = null;
	}

	/** Id of the key used for new ciphertext in the current context. */
	get activeKeyId(): string {
		this.requireRing();
		return this.currentRing.activeId as string;
	}

	/** Every key id in the current context's ring, in insertion order. */
	listKeyIds(): string[] {
		return [...this.currentRing.secrets.keys()];
	}

	/** True when the current context's ring contains the given key id. */
	hasKey(id: string): boolean {
		return this.currentRing.secrets.has(id);
	}

	// -----------------------------------------------------------------------
	// Key generation
	// -----------------------------------------------------------------------

	/**
	 * Generate a new cryptographically-random key in the current context.
	 *
	 * When no id is supplied, a collision-free `k1`, `k2`, … id is chosen
	 * (or the injected `generateId` test seam). A generated key is not made
	 * active automatically unless the ring was empty — call `selectActiveKey`
	 * or `rotate` to promote it.
	 *
	 * Returns the new key id.
	 */
	generateKey(id?: string): string {
		if (id !== undefined) {
			if (!KEY_ID_PATTERN.test(id)) {
				throw new Error(
					`keyRotationManager.generateKey: invalid key id "${id}" (expected ${KEY_ID_PATTERN}).`,
				);
			}
			if (this.currentRing.secrets.has(id)) {
				throw new Error(
					`keyRotationManager.generateKey: duplicate key id "${id}" in context "${this.currentAad}".`,
				);
			}
		}
		const nextId = id ?? this.generateId(this.ringIdSet());
		if (!KEY_ID_PATTERN.test(nextId)) {
			throw new Error(
				`keyRotationManager.generateKey: generated key id "${nextId}" is invalid (expected ${KEY_ID_PATTERN}).`,
			);
		}
		if (this.currentRing.secrets.has(nextId)) {
			throw new Error(
				`keyRotationManager.generateKey: generated key id "${nextId}" collides with an existing key.`,
			);
		}
		this.currentRing.secrets.set(nextId, generateSecret());
		if (this.currentRing.activeId === null) {
			this.currentRing.activeId = nextId;
		}
		this.currentRing.service = null;
		return nextId;
	}

	/**
	 * Rotate the current context's active key: generate a fresh key and
	 * promote it to active in one step. The retiring key stays in the ring
	 * for decryption (legacy), matching the env-configured rotation recipe in
	 * `makeEncryptionService`. Returns the new active key id.
	 */
	rotate(): string {
		const id = this.generateKey();
		this.selectActiveKey(id);
		return id;
	}

	// -----------------------------------------------------------------------
	// Context switching
	// -----------------------------------------------------------------------

	/**
	 * Switch the manager's active AAD context.
	 *
	 * Each context keeps its own key ring, so switching is lossless: the
	 * previous context's keys and active-key selection stay in memory and are
	 * restored by switching back. Payloads written under one context cannot
	 * be decrypted under another (GCM AAD binding) — switch before reading.
	 *
	 * When `keys` is supplied, they seed a fresh context (a context that
	 * already has keys rejects a seed to avoid silently dropping them).
	 * A fresh context with no keys refuses to encrypt/decrypt until
	 * `generateKey()` or `selectActiveKey` has been called — fail loud, never
	 * silent, because encryption without a key is a security hole.
	 */
	switchContext(aad: string, keys?: EncryptionKey[]): void {
		if (aad.length === 0) {
			throw new Error(
				'keyRotationManager.switchContext: AAD context must be a non-empty string.',
			);
		}
		let ring = this.rings.get(aad);
		if (ring === undefined) {
			// Fresh contexts start empty — encryption stays refused (loudly)
			// until generateKey()/selectActiveKey() supplies a key.
			ring = buildRing(keys ?? [], undefined, true);
			this.rings.set(aad, ring);
		} else if (keys !== undefined) {
			throw new Error(
				`keyRotationManager.switchContext: context "${aad}" already has keys — refusing to replace an existing ring.`,
			);
		}
		this.currentAad = aad;
		this.currentRing = ring;
	}

	/** The current AAD context. */
	get context(): string {
		return this.currentAad;
	}

	/** Every context that has been configured on this manager, in order. */
	listContexts(): string[] {
		return [...this.rings.keys()];
	}

	// -----------------------------------------------------------------------
	// Operator-facing ring export (rotation jobs)
	// -----------------------------------------------------------------------

	/**
	 * Snapshot of the current context's ring as `{ id, secret }` pairs, in
	 * insertion order. Intended for rotation jobs that feed the stateless
	 * transform in `reencrypt.ts` (ADA-709) — the operator owns these
	 * secrets and they never leave the process.
	 */
	exportKeys(): EncryptionKey[] {
		return [...this.currentRing.secrets.entries()].map(([id, secret]) => ({
			id,
			secret,
		}));
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private ringIdSet(): ReadonlySet<string> {
		return new Set(this.currentRing.secrets.keys());
	}

	private requireRing(): void {
		if (this.currentRing.activeId === null) {
			throw new Error(
				`keyRotationManager: context "${this.currentAad}" has no keys — call generateKey() or selectActiveKey() before using it.`,
			);
		}
	}

	/** Current context's `EncryptionService`, rebuilt after any mutation. */
	private service(): EncryptionService {
		this.requireRing();
		if (this.currentRing.service === null) {
			this.currentRing.service = buildService(
				this.currentRing,
				this.currentAad,
				this.iterations,
			);
		}
		return this.currentRing.service;
	}
}

/**
 * Convenience factory mirroring `makeEncryptionService` / `makeTokenStorage`
 * in this folder.
 */
export function makeKeyRotationManager(
	keys: EncryptionKey[],
	options: KeyRotationManagerOptions = {},
): KeyRotationManager {
	return new KeyRotationManager(keys, options);
}

// ---------------------------------------------------------------------------
// Ring construction
// ---------------------------------------------------------------------------

/** Build and validate a per-context ring from `{ id, secret }` keys. */
function buildRing(
	keys: EncryptionKey[],
	activeKeyId: string | undefined,
	allowEmpty = false,
): Ring {
	if (keys.length === 0 && !allowEmpty) {
		throw new Error(
			'keyRotationManager: at least one encryption key is required.',
		);
	}
	const secrets = new Map<string, string>();
	const seen = new Set<string>();
	for (const key of keys) {
		if (!KEY_ID_PATTERN.test(key.id)) {
			throw new Error(
				`keyRotationManager: invalid key id "${key.id}" (expected ${KEY_ID_PATTERN}).`,
			);
		}
		if (seen.has(key.id)) {
			throw new Error(`keyRotationManager: duplicate key id "${key.id}".`);
		}
		if (typeof key.secret !== 'string' || key.secret.length === 0) {
			throw new Error(
				`keyRotationManager: key "${key.id}" has an empty secret (encryption without a key is a security hole, not a convenience).`,
			);
		}
		seen.add(key.id);
		secrets.set(key.id, key.secret);
	}
	const activeId: string | null =
		activeKeyId ?? (keys.length > 0 ? keys[0].id : null);
	if (activeId !== null && !seen.has(activeId)) {
		throw new Error(
			`keyRotationManager: activeKeyId "${activeId}" is not in the key ring.`,
		);
	}
	return { secrets, activeId, service: null };
}

/** Build the `EncryptionService` for a ring, binding it to its context. */
function buildService(
	ring: Ring,
	aad: string,
	iterations: number | undefined,
): EncryptionService {
	const keys: EncryptionKey[] = [...ring.secrets.entries()].map(
		([id, secret]) => ({ id, secret }),
	);
	const options: EncryptionServiceOptions = {
		aad,
		activeKeyId: ring.activeId ?? undefined,
	};
	if (iterations !== undefined) options.iterations = iterations;
	return new EncryptionService(keys, options);
}

// ---------------------------------------------------------------------------
// Default id generation + secret generation
// ---------------------------------------------------------------------------

/**
 * Collision-free default key id: `k1`, `k2`, … continuing past the highest
 * numeric suffix already present in the ring.
 */
function defaultGenerateId(existing: ReadonlySet<string>): string {
	let max = 0;
	for (const id of existing) {
		const match = /^k([0-9]+)$/.exec(id);
		if (match !== null) max = Math.max(max, Number(match[1]));
	}
	let candidate = `k${max + 1}`;
	while (existing.has(candidate)) {
		max += 1;
		candidate = `k${max + 1}`;
	}
	return candidate;
}

/** Fresh 256-bit random secret as unpadded base64url (43 chars). */
function generateSecret(): string {
	const bytes = new Uint8Array(SECRET_BYTES);
	globalThis.crypto.getRandomValues(bytes);
	let binary = '';
	for (let i = 0; i < bytes.length; i++)
		binary += String.fromCharCode(bytes[i]);
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
