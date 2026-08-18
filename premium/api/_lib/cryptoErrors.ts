/**
 * Crypto exception hierarchy for Hoursmith Premium (ADA-715).
 *
 * `aesCrypto.ts` throws the leaf classes below instead of bare `Error`, so
 * callers can distinguish failure classes programmatically:
 *
 *   CryptoError                    — every crypto failure derives from this
 *   ├── CryptoKeyError             — invalid key material / key derivation
 *   ├── CryptoPayloadError         — malformed or unsupported payload
 *   │                                (bad prefix, bad base64, truncated, wrong version)
 *   └── CryptoDecryptError         — GCM authentication failure (wrong
 *                                    secret, wrong AAD context, tampering)
 *
 * Each class keeps its own `name` so `error.name` survives serialization and
 * `instanceof` checks work across edge-runtime module boundaries.
 *
 * Linear: ADA-715.
 */

export class CryptoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CryptoError';
	}
}

/** Invalid encryption secret or a key-derivation failure. */
export class CryptoKeyError extends CryptoError {
	constructor(message: string) {
		super(message);
		this.name = 'CryptoKeyError';
	}
}

/** A payload that is malformed or uses an unsupported format/version. */
export class CryptoPayloadError extends CryptoError {
	constructor(message: string) {
		super(message);
		this.name = 'CryptoPayloadError';
	}
}

/**
 * GCM authentication failure at decrypt time — wrong secret, wrong AAD
 * context, or a tampered ciphertext. All three are indistinguishable and all
 * fail closed.
 */
export class CryptoDecryptError extends CryptoError {
	constructor(message: string) {
		super(message);
		this.name = 'CryptoDecryptError';
	}
}
