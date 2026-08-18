/**
 * Stateless token re-encryption for Hoursmith Premium (ADA-709).
 *
 * Rotates an `aes256gcm:` payload (see `aesCrypto.ts`) from one encryption
 * secret to another without ever persisting the plaintext: the value is
 * decrypted in memory with the previous secret and immediately re-encrypted
 * with the current one. The transformation is a pure function of
 * `(payload, fromSecret, toSecret)` — no storage, no network, no shared
 * mutable state — so a key-rotation job can run it over the `user_tokens`
 * table with nothing but the two secrets.
 *
 * Guarantees:
 *  - Data integrity: the rotated payload decrypts to the exact same
 *    plaintext under `toSecret` and only under `toSecret`. The GCM tag on
 *    the new payload detects any tampering, and the function refuses to
 *    produce a payload it could not first read.
 *  - Idempotency: re-encrypting a payload that already decrypts under
 *    `toSecret` is a no-op that returns the original payload byte-for-byte,
 *    so a rotation job can be re-run safely after a partial failure without
 *    churning rows that were already rotated.
 *  - Fail closed: a payload that decrypts under neither the previous nor the
 *    current secret is rejected with an error — never silently re-encrypted,
 *    which would be unrecoverable data loss.
 *
 * The transform probes the current secret first (making re-runs a fast
 * no-op); a payload that fails that probe is tried against the previous
 * secret. Payloads carry no key identifier, so this trial is the only way to
 * tell which secret a ciphertext was written under — the GCM tag makes a
 * wrong-secret probe fail without ever revealing plaintext.
 *
 * Linear: ADA-709.
 */

import { AesCipher, type AesCipherOptions } from './aesCrypto.js';

export interface ReencryptOptions {
	/** Secret the payload is currently encrypted under. */
	fromSecret: string;
	/** Secret the payload should be encrypted under afterwards. */
	toSecret: string;
	/**
	 * Options for reading the current payload (AAD context, PBKDF2
	 * iterations, injected SubtleCrypto). Defaults match the `AesCipher`
	 * production defaults.
	 */
	fromOptions?: AesCipherOptions;
	/** Options for writing the rotated payload. */
	toOptions?: AesCipherOptions;
}

/**
 * Re-encrypt `payload` from `fromSecret` to `toSecret`.
 *
 * Returns the original payload unchanged when it already decrypts under
 * `toSecret` (idempotency). Throws when the payload decrypts under neither
 * secret, is malformed, or has been tampered with — in all cases the
 * plaintext is never surfaced and nothing is written.
 */
export async function reencryptPayload(
	payload: string,
	options: ReencryptOptions,
): Promise<string> {
	const toCipher = new AesCipher(options.toSecret, options.toOptions);

	// Idempotent no-op: if the payload already decrypts under the target
	// secret there is nothing to rotate. This is what makes rotation jobs
	// re-runnable — the second run leaves every row untouched.
	try {
		await toCipher.decrypt(payload);
		return payload;
	} catch {
		// Expected when the payload is still under the previous secret.
	}

	const fromCipher = new AesCipher(options.fromSecret, options.fromOptions);
	let plaintext: string;
	try {
		plaintext = await fromCipher.decrypt(payload);
	} catch {
		throw new Error(
			'reencryptPayload failed: payload could not be decrypted with either the current or the previous encryption secret (wrong secret, wrong options such as PBKDF2 iterations or AAD context, or tampered / malformed payload). Refusing to re-encrypt an unreadable payload.',
		);
	}
	return toCipher.encrypt(plaintext);
}
