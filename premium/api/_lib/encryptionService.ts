/**
 * Encryption Service with versioned key management for Hoursmith Premium
 * (ADA-705).
 *
 * Layered on top of the AES-256-GCM wrapper (ADA-677 `aesCrypto.ts`), this
 * service adds what the raw cipher deliberately leaves out: a managed key
 * ring. Every key has a stable id and payloads carry that id, so a
 * deployment can rotate its encryption secret without losing the ability to
 * decrypt legacy rows.
 *
 *   - Key ids: `encrypt` embeds the active key's id in the payload;
 *     `decrypt` resolves the id against the key ring and fails closed when
 *     the id is unknown (rotated out, or forged).
 *   - Rotation: keep the retiring secret in the key ring (legacy map) and
 *     advance the active key. Old payloads keep decrypting because their kid
 *     still resolves, while every new payload is written with the new key.
 *   - Env wiring: `makeEncryptionService(env)` reads `TOKEN_ENCRYPTION_SECRET`
 *     (the active key for encryption/decryption operations)
 *     plus the optional `TOKEN_ENCRYPTION_KEY_ID` and
 *     `TOKEN_ENCRYPTION_LEGACY_KEYS` (JSON object `{ kid: secret }`).
 *
 * Payload format (outer envelope, `hsenc:` prefix):
 *   hsenc:v1:<kid>:<aes256gcm payload>
 *
 * The inner payload is the unmodified self-describing format from
 * `aesCrypto.ts`; the `kid` is public metadata (like a JWT `kid`). The GCM
 * tag binds the ciphertext to the key's secret, so rewriting the id can only
 * produce an authentication failure — never plaintext.
 *
 * Dependency-free WebCrypto so this stays edge-runtime compatible, mirroring
 * `aesCrypto.ts` and `tokenStorage.ts`.
 *
 * Linear: ADA-705.
 */

import { AesCipher } from './aesCrypto.js';

const PREFIX = 'hsenc:';
const FORMAT_VERSION = 'v1';
/** Key id used when a deployment does not configure `TOKEN_ENCRYPTION_KEY_ID`. */
const DEFAULT_KEY_ID = 'current';
/** Kids must be URL-safe tokens — they travel in plaintext headers. */
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface EncryptionKey {
	/** Stable identifier embedded in every payload encrypted with this key. */
	id: string;
	/** Raw encryption secret passed to `AesCipher` (never persisted). */
	secret: string;
}

export interface EncryptionServiceOptions {
	/**
	 * Id of the key used for `encrypt`. Defaults to the first key in the
	 * ring. Every key in the ring is always usable for `decrypt`, so this
	 * only selects where new ciphertext goes.
	 */
	activeKeyId?: string;
	/**
	 * PBKDF2-HMAC-SHA256 iteration count passed through to `AesCipher`.
	 * Defaults to the OWASP-recommended 600_000 (production deployments
	 * should keep the default; tests lower it for speed).
	 */
	iterations?: number;
	/**
	 * AAD context passed through to `AesCipher`. Defaults to
	 * `hoursmith:user-tokens:v1`.
	 */
	aad?: string;
}

/** Env source for `makeEncryptionService` (tests inject a plain object). */
export interface EncryptionServiceEnv {
	/** Active encryption secret. Required — never operate without one. */
	TOKEN_ENCRYPTION_SECRET?: string;
	/** Optional id for the active key. Defaults to `current`. */
	TOKEN_ENCRYPTION_KEY_ID?: string;
	/**
	 * Optional JSON object mapping legacy key ids to secrets, used during
	 * rotation so payloads written under a previous key stay decryptable.
	 */
	TOKEN_ENCRYPTION_LEGACY_KEYS?: string;
}

/**
 * Key-ring-backed symmetric encryption service.
 *
 * `encrypt` always uses the active key (see `EncryptionServiceOptions`).
 * `decrypt` resolves the payload's embedded key id against the ring: a
 * payload under a known id decrypts, an unknown id fails closed.
 */
export class EncryptionService {
	private readonly ciphers: ReadonlyMap<string, AesCipher>;
	private readonly activeId: string;

	constructor(keys: EncryptionKey[], options: EncryptionServiceOptions = {}) {
		if (keys.length === 0) {
			throw new Error(
				'encryptionService: at least one encryption key is required.',
			);
		}
		const seen = new Set<string>();
		const ciphers = new Map<string, AesCipher>();
		for (const key of keys) {
			if (!KEY_ID_PATTERN.test(key.id)) {
				throw new Error(
					`encryptionService: invalid key id "${key.id}" (expected ${KEY_ID_PATTERN}).`,
				);
			}
			if (seen.has(key.id)) {
				throw new Error(`encryptionService: duplicate key id "${key.id}".`);
			}
			seen.add(key.id);
			ciphers.set(key.id, new AesCipher(key.secret, aesOptions(options)));
		}
		const activeId = options.activeKeyId ?? keys[0].id;
		if (!seen.has(activeId)) {
			throw new Error(
				`encryptionService: activeKeyId "${activeId}" is not in the key ring.`,
			);
		}
		this.ciphers = ciphers;
		this.activeId = activeId;
	}

	/** Encrypt `plaintext` under the active key; returns an `hsenc:` payload. */
	async encrypt(plaintext: string): Promise<string> {
		const cipher = this.ciphers.get(this.activeId);
		// Defensive: construction guarantees the active key exists.
		if (cipher === undefined) {
			throw new Error(
				`encryptionService: active key "${this.activeId}" is missing.`,
			);
		}
		const inner = await cipher.encrypt(plaintext);
		return `${PREFIX}${FORMAT_VERSION}:${this.activeId}:${inner}`;
	}

	/**
	 * Decrypt an `hsenc:` payload produced by `encrypt`.
	 *
	 * Throws on malformed payloads, an unknown key id (rotated out or
	 * forged), a wrong secret, a mismatched context, or any tampering — all
	 * of those fail closed.
	 */
	async decrypt(payload: string): Promise<string> {
		const { kid, inner } = parsePayload(payload);
		const cipher = this.ciphers.get(kid);
		if (cipher === undefined) {
			throw new Error(
				`encryptionService.decrypt: unknown key id "${kid}" (rotated out, or forged payload).`,
			);
		}
		return cipher.decrypt(inner);
	}

	/** Id of the key used for new ciphertext. */
	get activeKeyId(): string {
		return this.activeId;
	}

	/** Every key id in the ring (active + legacy), in construction order. */
	listKeyIds(): string[] {
		return [...this.ciphers.keys()];
	}

	/** True when the ring contains a key with the given id. */
	hasKey(id: string): boolean {
		return this.ciphers.has(id);
	}
}

/**
 * Convenience factory mirroring `makeTokenStorage` / `makeAesCipher` in this
 * folder. Reads the active key from `TOKEN_ENCRYPTION_SECRET` (required) and
 * optional rotation keys from `TOKEN_ENCRYPTION_LEGACY_KEYS`.
 *
 * Rotation recipe:
 *   1. Deploy with `TOKEN_ENCRYPTION_SECRET=secret-a` (kid defaults to
 *      `current`) → every payload carries kid `current`.
 *   2. To rotate, set `TOKEN_ENCRYPTION_SECRET=secret-b`,
 *      `TOKEN_ENCRYPTION_KEY_ID=v2` and
 *      `TOKEN_ENCRYPTION_LEGACY_KEYS={"current":"secret-a"}`.
 *   3. Old payloads (kid `current`) still decrypt via the legacy map; new
 *      payloads are written with kid `v2`. Next rotation moves `v2` into the
 *      legacy map and advances `TOKEN_ENCRYPTION_KEY_ID` to `v3`.
 *
 * Misconfiguration fails loudly (missing key, malformed JSON, id collisions)
 * — an encryption service must never silently run without a key.
 */
export function makeEncryptionService(
	env: EncryptionServiceEnv,
	options: EncryptionServiceOptions = {},
): EncryptionService {
	const activeSecret = env.TOKEN_ENCRYPTION_SECRET;
	if (!activeSecret || activeSecret.length === 0) {
		throw new Error(
			'TOKEN_ENCRYPTION_SECRET must be set for encryptionService (encryption without a key is a security hole, not a convenience).',
		);
	}
	const activeId = env.TOKEN_ENCRYPTION_KEY_ID ?? DEFAULT_KEY_ID;
	if (!KEY_ID_PATTERN.test(activeId)) {
		throw new Error(
			`encryptionService: invalid TOKEN_ENCRYPTION_KEY_ID "${activeId}".`,
		);
	}

	const keys: EncryptionKey[] = [{ id: activeId, secret: activeSecret }];

	const legacy = env.TOKEN_ENCRYPTION_LEGACY_KEYS;
	if (legacy !== undefined && legacy !== '') {
		let parsed: unknown;
		try {
			parsed = JSON.parse(legacy);
		} catch {
			throw new Error(
				'encryptionService: TOKEN_ENCRYPTION_LEGACY_KEYS is not valid JSON.',
			);
		}
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error(
				'encryptionService: TOKEN_ENCRYPTION_LEGACY_KEYS must be a JSON object mapping key ids to secrets.',
			);
		}
		for (const [id, secret] of Object.entries(parsed)) {
			if (!KEY_ID_PATTERN.test(id)) {
				throw new Error(`encryptionService: invalid legacy key id "${id}".`);
			}
			if (typeof secret !== 'string' || secret.length === 0) {
				throw new Error(
					`encryptionService: legacy key "${id}" has an empty secret.`,
				);
			}
			if (id === activeId) {
				throw new Error(
					`encryptionService: legacy key id "${id}" collides with the active key id.`,
				);
			}
			keys.push({ id, secret });
		}
	}

	return new EncryptionService(keys, options);
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

function parsePayload(payload: string): { kid: string; inner: string } {
	if (!payload.startsWith(PREFIX)) {
		throw new Error(
			'encryptionService.decrypt: payload must start with "hsenc:".',
		);
	}
	const remainder = payload.slice(PREFIX.length);
	const versionColon = remainder.indexOf(':');
	if (versionColon === -1) {
		throw new Error(
			'encryptionService.decrypt: payload is missing the format version.',
		);
	}
	const version = remainder.slice(0, versionColon);
	if (version !== FORMAT_VERSION) {
		throw new Error(
			`encryptionService.decrypt: unsupported payload version "${version}".`,
		);
	}
	const afterVersion = remainder.slice(versionColon + 1);
	const kidColon = afterVersion.indexOf(':');
	if (kidColon === -1) {
		throw new Error(
			'encryptionService.decrypt: payload is missing the key id.',
		);
	}
	const kid = afterVersion.slice(0, kidColon);
	if (!KEY_ID_PATTERN.test(kid)) {
		throw new Error(
			`encryptionService.decrypt: payload has a malformed key id "${kid}".`,
		);
	}
	return { kid, inner: afterVersion.slice(kidColon + 1) };
}

/** Build `AesCipherOptions`, omitting undefined values so defaults apply. */
function aesOptions(options: EncryptionServiceOptions): {
	iterations?: number;
	aad?: string;
} {
	const out: { iterations?: number; aad?: string } = {};
	if (options.iterations !== undefined) out.iterations = options.iterations;
	if (options.aad !== undefined) out.aad = options.aad;
	return out;
}
