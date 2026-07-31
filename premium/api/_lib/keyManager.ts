/**
 * In-memory key manager with rotation + versioning for Hoursmith Premium
 * (ADA-707).
 *
 * The layer above `aesCrypto.ts` (ADA-677): where `AesCipher` encrypts with
 * exactly one secret, `KeyManager` owns a *set* of key versions in process
 * memory and makes rotation safe:
 *
 *   - Versioning: every key gets a monotonically increasing integer version.
 *     `encrypt()` stamps the current version into the payload it returns, so
 *     `decrypt()` can look the right key up later — even after the key that
 *     produced the payload has been rotated out. Payloads are self-describing
 *     and carry no external state:
 *
 *         keymanager:1:<version>:aes256gcm:<base64 envelope>
 *
 *   - Rotation: `rotate(newSecret)` mints a new version as the current key
 *     while keeping retired versions in memory so rows written under the old
 *     key stay decryptable for a grace period (`maxRetiredKeys`, default 2).
 *     When the retired set exceeds the bound, the *oldest* keys are dropped
 *     first — a payload stamped with a dropped version fails closed with an
 *     explicit "unknown key version" error instead of a misleading auth error.
 *
 *   - Context binding: each version's cipher is bound to a per-version AAD
 *     context (`<baseAad>:key-<version>`), so a payload can never be
 *     re-labelled to a different version: rewriting the version stamp makes
 *     the GCM tag fail. The version stamp is a lookup hint, not a security
 *     boundary — the tag is.
 *
 * Security properties:
 *   - Key material is held in private fields only. There are no getters that
 *     return a secret, and `status()` (the observability surface) exposes
 *     versions but never secrets.
 *   - Construction rejects empty secrets; `rotate()` rejects empty secrets and
 *     secrets already present in the ring (rotating to the same material
 *     silently defeats the purpose of rotation).
 *   - Failure is closed: unknown versions, malformed payloads, unsupported
 *     format versions, and any GCM auth failure all throw.
 *
 * The set of secrets mirrors an environment-var list like
 * `TOKEN_ENCRYPTION_SECRETS=oldest,older,current` — the **last** element is
 * the current (encrypting) key, earlier elements are retired-but-readable.
 *
 * Dependency-free WebCrypto so this stays edge-runtime compatible, mirroring
 * `aesCrypto.ts`, `tokenStorage.ts` and `polarClient.ts`. All collaborators
 * are injectable so unit tests run offline and fast.
 *
 * Linear: ADA-707.
 */

import { AesCipher, type AesCipherOptions } from './aesCrypto.js';

export const KEY_MANAGER_PREFIX = 'keymanager:';
export const KEY_MANAGER_FORMAT_VERSION = 1;
/** Default AAD base context; per-key versions append `:key-<version>`. */
export const DEFAULT_KEY_MANAGER_AAD = 'hoursmith:key-manager:v1';
/**
 * How many retired key versions are kept in memory for decryption after the
 * current key. Bounded by default so a long-lived process cannot accumulate
 * key material forever; the oldest retired keys are dropped first.
 */
export const DEFAULT_MAX_RETIRED_KEYS = 2;

export interface KeyManagerOptions {
	/**
	 * PBKDF2-HMAC-SHA256 iteration count passed to each version's cipher.
	 * Defaults to the OWASP-recommended 600_000; tests pass a lower count to
	 * stay fast. Production deployments should keep the default.
	 */
	iterations?: number;
	/**
	 * AAD base context bound into every GCM tag. Each key version appends
	 * `:key-<version>`, so payloads are version-scoped. Defaults to
	 * `hoursmith:key-manager:v1`.
	 */
	aad?: string;
	/**
	 * Test seam: injectable `SubtleCrypto`. Defaults to
	 * `globalThis.crypto.subtle` (Node 20+ / edge runtimes).
	 */
	subtle?: SubtleCrypto;
	/**
	 * Max retired key versions kept for decryption after the current key.
	 * Defaults to `DEFAULT_MAX_RETIRED_KEYS` (2). Oldest retired versions are
	 * dropped first when the bound is exceeded. Pass `Infinity` to keep every
	 * retired version for the process lifetime.
	 */
	maxRetiredKeys?: number;
}

export interface KeyManagerStatus {
	/** Version used by new `encrypt()` calls. */
	currentVersion: number;
	/** Every version currently held in memory, oldest first. */
	versions: number[];
	/** Retired versions still held for decryption (excludes current). */
	retiredVersions: number[];
}

/**
 * Versioned, in-memory key ring for at-rest encryption.
 *
 * `encrypt` stamps the current key version into a self-describing
 * `keymanager:` payload, so `decrypt` only needs the payload — never the
 * version — and keeps working across rotations until the producing key is
 * dropped from the ring.
 */
export class KeyManager {
	private readonly ring = new Map<number, AesCipher>();
	private readonly secrets = new Set<string>();
	private readonly baseAad: string;
	private readonly iterations: number | undefined;
	private readonly subtle: SubtleCrypto;
	private readonly maxRetiredKeys: number;
	private current: number;

	/**
	 * @param secrets The key material to load, oldest first. The **last**
	 *   element becomes the current (encrypting) key; earlier elements are
	 *   retired-but-readable, which lets a restart resume the grace period
	 *   without re-encrypting anything. A single string is shorthand for
	 *   `[secret]`.
	 */
	constructor(secrets: string | string[], options: KeyManagerOptions = {}) {
		const list = Array.isArray(secrets) ? secrets : [secrets];
		if (list.length === 0) {
			throw new Error(
				'keyManager: at least one encryption secret is required.',
			);
		}
		for (const secret of list) {
			if (typeof secret !== 'string' || secret.length === 0) {
				throw new Error(
					'keyManager: encryption secrets must be non-empty strings.',
				);
			}
		}
		// Reject duplicate material up front — two versions of the same secret
		// would silently defeat rotation.
		const unique = new Set(list);
		if (unique.size !== list.length) {
			throw new Error(
				'keyManager: encryption secrets must be unique; duplicate material is not allowed.',
			);
		}

		this.baseAad = options.aad ?? DEFAULT_KEY_MANAGER_AAD;
		this.iterations = options.iterations;
		this.subtle = options.subtle ?? globalThis.crypto.subtle;
		this.maxRetiredKeys = options.maxRetiredKeys ?? DEFAULT_MAX_RETIRED_KEYS;

		list.forEach((secret, index) => {
			const version = index + 1;
			this.ring.set(version, this.makeCipher(secret, version));
			this.secrets.add(secret);
		});
		this.current = list.length;
	}

	/** The version used by new `encrypt()` calls. */
	get currentVersion(): number {
		return this.current;
	}

	/** Versions currently held in memory, oldest first. */
	get versions(): readonly number[] {
		return Array.from(this.ring.keys());
	}

	/**
	 * Observability snapshot — versions only, never key material. Safe to log
	 * or emit to metrics.
	 */
	status(): KeyManagerStatus {
		const versions = Array.from(this.ring.keys());
		return {
			currentVersion: this.current,
			versions,
			retiredVersions: versions.filter((v) => v !== this.current),
		};
	}

	/**
	 * Encrypt `plaintext` with the current key and stamp its version into a
	 * self-describing `keymanager:` payload.
	 */
	async encrypt(plaintext: string): Promise<string> {
		const cipher = this.ring.get(this.current);
		if (!cipher) {
			throw new Error(
				`keyManager.encrypt: current key version ${this.current} is not available.`,
			);
		}
		const payload = await cipher.encrypt(plaintext);
		return `${KEY_MANAGER_PREFIX}${KEY_MANAGER_FORMAT_VERSION}:${this.current}:${payload}`;
	}

	/**
	 * Decrypt a `keymanager:` payload produced by this ring (or any ring that
	 * shares the same key material and ordering). The version stamped in the
	 * payload selects the cipher; payloads whose version has been dropped from
	 * the ring fail closed with an explicit "unknown key version" error.
	 */
	async decrypt(payload: string): Promise<string> {
		const { version, ciphertext } = this.parsePayload(payload);
		const cipher = this.ring.get(version);
		if (!cipher) {
			throw new Error(
				`keyManager.decrypt: unknown key version ${version} (retired or never held by this ring).`,
			);
		}
		return cipher.decrypt(ciphertext);
	}

	/**
	 * Rotate to `newSecret`: it becomes the current key under a fresh version,
	 * and every version already in the ring stays readable until evicted by
	 * the `maxRetiredKeys` bound. Returns the new version number.
	 *
	 * Rejects empty secrets and any secret already present in the ring —
	 * rotating to the same material is a no-op that would fake a rotation.
	 */
	rotate(newSecret: string): number {
		if (typeof newSecret !== 'string' || newSecret.length === 0) {
			throw new Error(
				'keyManager.rotate: new secret must be a non-empty string.',
			);
		}
		if (this.secrets.has(newSecret)) {
			throw new Error(
				'keyManager.rotate: new secret must differ from every secret already held by this ring.',
			);
		}
		const nextVersion = this.current + 1;
		this.ring.set(nextVersion, this.makeCipher(newSecret, nextVersion));
		this.secrets.add(newSecret);
		this.current = nextVersion;
		this.evictRetired();
		return nextVersion;
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private makeCipher(
		secret: string,
		version: number,
	): AesCipher {
		const options: AesCipherOptions = {
			aad: `${this.baseAad}:key-${version}`,
			subtle: this.subtle,
		};
		if (this.iterations !== undefined) options.iterations = this.iterations;
		return new AesCipher(secret, options);
	}

	/**
	 * Drop the oldest retired versions while the retired set exceeds
	 * `maxRetiredKeys`. The current key is never evicted. Evicted keys are
	 * removed from memory — payloads stamped with their version then fail
	 * closed on decrypt.
	 */
	private evictRetired(): void {
		if (!Number.isFinite(this.maxRetiredKeys)) return;
		const retired = Array.from(this.ring.keys())
			.filter((v) => v !== this.current)
			.sort((a, b) => a - b);
		const overflow = retired.length - this.maxRetiredKeys;
		for (let i = 0; i < overflow; i++) {
			const version = retired[i];
			this.ring.delete(version);
		}
	}

	/**
	 * Split a `keymanager:` payload into the key version stamp and the nested
	 * `aes256gcm:` ciphertext. Throws on malformed payloads and unsupported
	 * format versions.
	 */
	private parsePayload(payload: string): {
		version: number;
		ciphertext: string;
	} {
		if (!payload.startsWith(KEY_MANAGER_PREFIX)) {
			throw new Error(
				`keyManager.decrypt: payload must start with "${KEY_MANAGER_PREFIX}".`,
			);
		}
		const parts = payload.slice(KEY_MANAGER_PREFIX.length).split(':');
		const [format, versionText, ...rest] = parts;
		if (format !== String(KEY_MANAGER_FORMAT_VERSION)) {
			throw new Error(
				`keyManager.decrypt: unsupported key manager format version ${format ?? '(missing)'}.`,
			);
		}
		const version = Number(versionText);
		if (!Number.isInteger(version) || version < 1) {
			throw new Error(
				'keyManager.decrypt: payload has an invalid key version stamp.',
			);
		}
		const ciphertext = rest.join(':');
		if (ciphertext.length === 0) {
			throw new Error('keyManager.decrypt: payload has no ciphertext.');
		}
		return { version, ciphertext };
	}
}

/**
 * Convenience factory mirroring the `make*` helpers in this folder
 * (`makeAesCipher`, `makeTokenStorage`, `makeRateLimiter`).
 */
export function makeKeyManager(
	secrets: string | string[],
	options?: KeyManagerOptions,
): KeyManager {
	return new KeyManager(secrets, options);
}
