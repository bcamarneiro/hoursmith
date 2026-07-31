/**
 * Secure asymmetric key-pair generation and format handling for Hoursmith
 * Premium (ADA-683).
 *
 * Generates RSA / ECC key pairs, serializes them to PEM and JWK, and imports
 * them back — with two security invariants:
 *
 *  - Entropy: key material always comes from WebCrypto
 *    (`crypto.subtle.generateKey`), which is backed by the platform CSPRNG
 *    (Node 20+ / browser / edge runtimes). There is no path in this module
 *    that accepts caller-supplied key bytes, and nothing uses `Math.random`
 *    or any non-cryptographic source.
 *  - Confidentiality: private key material is never emitted to logs. The
 *    module throws only static error strings (no key material interpolated),
 *    and the only identifier it derives from a key — `publicKeyThumbprint`
 *    (RFC 7638) — is a digest of the *public* JWK, safe to log and to use as
 *    a key id. Use `publicKeyDescriptor` when you need a log-friendly summary.
 *
 * Supported algorithms (the standard modern choices for signing):
 *  - RSA: RSA-PSS, 2048-bit modulus, 65537 public exponent, SHA-256.
 *  - EC: ECDSA over NIST curve P-256 (SHA-256).
 *
 * Serialization:
 *  - PEM: PKCS#8 for private keys (`BEGIN PRIVATE KEY`), SPKI for public
 *    keys (`BEGIN PUBLIC KEY`) — the interchange formats Node and most
 *    tooling expect.
 *  - JWK: public JWK export (`exportPublicKeyJwk`) carries only public
 *    parameters (RSA: n/e, EC: crv/x/y — never `d`). Private JWK export is
 *    deliberately NOT offered; PEM PKCS#8 is the private-key interchange
 *    format.
 *
 * Round-trips are self-describing: `exportKeyPairPem` returns the algorithm
 * alongside the PEM strings, so `importKeyPairPem` needs no caller-supplied
 * algorithm and fails closed on mismatches.
 *
 * Dependency-free WebCrypto so this stays edge-runtime compatible, mirroring
 * `aesCrypto.ts`, `polarClient.ts` and `tokenStorage.ts`.
 *
 * Linear: ADA-683.
 */

const RSA_KEY_ALGORITHM = 'RSA-PSS' as const;
const EC_KEY_ALGORITHM = 'ECDSA' as const;
const DEFAULT_HASH = 'SHA-256' as const;
/** 2048-bit modulus — the OWASP minimum for RSA. */
const RSA_MODULUS_BITS = 2048;
/** 65537 — the standard, safe RSA public exponent. */
const RSA_PUBLIC_EXPONENT = new Uint8Array([0x01, 0x00, 0x01]);
/** P-256 — the NIST curve recommended for ECDSA in new deployments. */
const EC_NAMED_CURVE = 'P-256' as const;

const PRIVATE_KEY_PEM_LABEL = 'PRIVATE KEY';
const PUBLIC_KEY_PEM_LABEL = 'PUBLIC KEY';
/** PEM body line width — RFC 7468. */
const PEM_LINE_WIDTH = 64;

export type KeyPairAlgorithm = 'rsa' | 'ec';

export interface GenerateKeyPairOptions {
	/**
	 * Key-pair family. `'rsa'` generates RSA-PSS (2048-bit, SHA-256),
	 * `'ec'` generates ECDSA over P-256. Defaults to `'rsa'`.
	 */
	algorithm?: KeyPairAlgorithm;
	/**
	 * Whether the keys are extractable (serializable to PEM/JWK). Defaults to
	 * `true` — this module exists to serialize keys. Set `false` for keys that
	 * must remain non-exportable (WebCrypto will refuse `exportKey`).
	 */
	extractable?: boolean;
	/**
	 * Test seam: injectable `SubtleCrypto`. Defaults to
	 * `globalThis.crypto.subtle` (Node 20+ / edge runtimes).
	 */
	subtle?: SubtleCrypto;
}

export interface KeyPairPem {
	/** The key-pair family the PEM strings belong to (self-describing). */
	algorithm: KeyPairAlgorithm;
	/** PKCS#8 private key, `-----BEGIN PRIVATE KEY-----` (sensitive). */
	privateKeyPem: string;
	/** SPKI public key, `-----BEGIN PUBLIC KEY-----`. */
	publicKeyPem: string;
}

export interface PublicKeyDescriptor {
	/** JWK key type — `'RSA'` or `'EC'`. */
	kty: string;
	/** Key-pair family, as passed to `generateKeyPair`. */
	algorithm: KeyPairAlgorithm;
	/**
	 * RFC 7638 JWK thumbprint (base64url SHA-256 of the canonical public JWK).
	 * Deterministic per key, unique in practice, and safe to log / persist as
	 * a key id — it never reveals private key material.
	 */
	thumbprint: string;
	/** Human-readable size/curve detail, e.g. `'2048-bit'` or `'P-256'`. */
	detail: string;
}

/**
 * Generate a secure RSA-PSS or ECDSA key pair.
 *
 * Entropy comes exclusively from `crypto.subtle.generateKey` (platform
 * CSPRNG). Keys are extractable by default so they can be serialized with
 * `exportKeyPairPem` / `exportPublicKeyJwk`.
 */
export async function generateKeyPair(
	options: GenerateKeyPairOptions = {},
): Promise<CryptoKeyPair> {
	const algorithm = options.algorithm ?? 'rsa';
	const extractable = options.extractable ?? true;
	const subtle = options.subtle ?? globalThis.crypto.subtle;

	if (algorithm === 'rsa') {
		return (await subtle.generateKey(
			{
				name: RSA_KEY_ALGORITHM,
				modulusLength: RSA_MODULUS_BITS,
				publicExponent: RSA_PUBLIC_EXPONENT,
				hash: DEFAULT_HASH,
			},
			extractable,
			['sign', 'verify'],
		)) as CryptoKeyPair;
	}

	return (await subtle.generateKey(
		{
			name: EC_KEY_ALGORITHM,
			namedCurve: EC_NAMED_CURVE,
		},
		extractable,
		['sign', 'verify'],
	)) as CryptoKeyPair;
}

/**
 * Serialize a key pair to PEM: PKCS#8 private + SPKI public. The returned
 * `algorithm` makes the pair self-describing for `importKeyPairPem`.
 *
 * The private PEM is sensitive — persist it only in encrypted storage (see
 * `aesCrypto.ts`) and never log it.
 */
export async function exportKeyPairPem(
	pair: CryptoKeyPair,
): Promise<KeyPairPem> {
	assertKeyPair(pair);
	const [privateKeyPem, publicKeyPem] = await Promise.all([
		exportPrivateKeyPem(pair.privateKey),
		exportPublicKeyPem(pair.publicKey),
	]);
	return {
		algorithm: algorithmOf(pair.privateKey),
		privateKeyPem,
		publicKeyPem,
	};
}

/** Serialize a private key to PKCS#8 PEM. The result is sensitive — never log it. */
export async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
	assertPrivateKey(key);
	const der = await exportDer('pkcs8', key);
	return derToPem(der, PRIVATE_KEY_PEM_LABEL);
}

/** Serialize a public key to SPKI PEM. */
export async function exportPublicKeyPem(key: CryptoKey): Promise<string> {
	assertPublicKey(key);
	const der = await exportDer('spki', key);
	return derToPem(der, PUBLIC_KEY_PEM_LABEL);
}

/**
 * Export the PUBLIC JWK of a key or key pair. Only public parameters are
 * included (RSA: `n`/`e`; EC: `crv`/`x`/`y`) — never the private exponent or
 * `d`. For private-key interchange, use PEM PKCS#8 (`exportPrivateKeyPem`).
 */
export async function exportPublicKeyJwk(
	key: CryptoKey | CryptoKeyPair,
): Promise<JsonWebKey> {
	const publicKey = toPublicKey(key);
	assertPublicKey(publicKey);
	return exportJwk(publicKey);
}

/**
 * Re-import a `KeyPairPem` produced by `exportKeyPairPem`. The algorithm is
 * read from the descriptor (never inferred from untrusted bytes), and a PEM
 * whose DER does not match the declared algorithm fails closed with a
 * non-descriptive error.
 */
export async function importKeyPairPem(
	pem: KeyPairPem,
): Promise<CryptoKeyPair> {
	if (!pem || typeof pem.algorithm !== 'string') {
		throw new Error('keyCrypto.importKeyPairPem: invalid key pair descriptor.');
	}
	const algorithm = pem.algorithm === 'ec' ? 'ec' : 'rsa';
	const [privateKey, publicKey] = await Promise.all([
		importPrivateKeyPem(pem.privateKeyPem, algorithm),
		importPublicKeyPem(pem.publicKeyPem, algorithm),
	]);
	return { privateKey, publicKey };
}

/** Import a PKCS#8 PEM private key for signing with the given family. */
export async function importPrivateKeyPem(
	pem: string,
	algorithm: KeyPairAlgorithm,
): Promise<CryptoKey> {
	assertPem(pem, PRIVATE_KEY_PEM_LABEL, 'importPrivateKeyPem');
	const der = pemToDer(pem, PRIVATE_KEY_PEM_LABEL);
	try {
		return await globalThis.crypto.subtle.importKey(
			'pkcs8',
			der,
			keyAlgorithm(algorithm),
			true,
			['sign'],
		);
	} catch {
		throw new Error(
			'keyCrypto.importPrivateKeyPem: could not import the private key (malformed DER or algorithm mismatch).',
		);
	}
}

/** Import an SPKI PEM public key for verification with the given family. */
export async function importPublicKeyPem(
	pem: string,
	algorithm: KeyPairAlgorithm,
): Promise<CryptoKey> {
	assertPem(pem, PUBLIC_KEY_PEM_LABEL, 'importPublicKeyPem');
	const der = pemToDer(pem, PUBLIC_KEY_PEM_LABEL);
	try {
		return await globalThis.crypto.subtle.importKey(
			'spki',
			der,
			keyAlgorithm(algorithm),
			true,
			['verify'],
		);
	} catch {
		throw new Error(
			'keyCrypto.importPublicKeyPem: could not import the public key (malformed DER or algorithm mismatch).',
		);
	}
}

/** Import a public key from a public JWK (e.g. one produced by `exportPublicKeyJwk`). */
export async function importPublicKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
	if (
		!jwk ||
		typeof jwk !== 'object' ||
		(jwk.kty !== 'RSA' && jwk.kty !== 'EC')
	) {
		throw new Error(
			'keyCrypto.importPublicKeyJwk: JWK must be an object with kty "RSA" or "EC".',
		);
	}
	try {
		return await globalThis.crypto.subtle.importKey(
			'jwk',
			jwk,
			jwk.kty === 'EC'
				? { name: EC_KEY_ALGORITHM, namedCurve: jwk.crv ?? EC_NAMED_CURVE }
				: { name: RSA_KEY_ALGORITHM, hash: DEFAULT_HASH },
			true,
			['verify'],
		);
	} catch {
		throw new Error(
			'keyCrypto.importPublicKeyJwk: could not import the JWK (missing public parameters, malformed base64url, or unsupported algorithm).',
		);
	}
}

/**
 * RFC 7638 JWK thumbprint of the public key — a stable, unique, non-sensitive
 * key identifier. Deterministic for the same key across runs and runtimes.
 *
 * This is the value to log / persist when you need to identify a key pair:
 * it is a digest of the public JWK and reveals nothing about the private key.
 */
export async function publicKeyThumbprint(
	key: CryptoKey | CryptoKeyPair,
): Promise<string> {
	const publicKey = toPublicKey(key);
	assertPublicKey(publicKey);
	const jwk = await exportJwk(publicKey);
	const canonical = canonicalJwkForThumbprint(jwk);
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		utf8ToBytes(canonical),
	);
	return bytesToBase64Url(new Uint8Array(digest));
}

/**
 * Log-friendly public summary of a key: kty, algorithm family, size/curve
 * detail, and the RFC 7638 thumbprint. Never includes private parameters —
 * safe for structured logs, error reporting, and key registries.
 */
export async function publicKeyDescriptor(
	key: CryptoKey | CryptoKeyPair,
): Promise<PublicKeyDescriptor> {
	const publicKey = toPublicKey(key);
	assertPublicKey(publicKey);
	const [thumbprint, kty] = await Promise.all([
		publicKeyThumbprint(publicKey),
		exportJwk(publicKey).then((jwk) => jwk.kty ?? 'unknown'),
	]);
	return {
		kty,
		algorithm: algorithmOf(publicKey),
		thumbprint,
		detail: keyDetail(publicKey),
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function keyAlgorithm(
	algorithm: KeyPairAlgorithm,
): RsaHashedImportParams | EcKeyImportParams {
	return algorithm === 'ec'
		? { name: EC_KEY_ALGORITHM, namedCurve: EC_NAMED_CURVE }
		: { name: RSA_KEY_ALGORITHM, hash: DEFAULT_HASH };
}

/** Map a `CryptoKey.algorithm` name back to the module's family name. */
function algorithmOf(key: CryptoKey): KeyPairAlgorithm {
	const name =
		key.algorithm &&
		typeof key.algorithm === 'object' &&
		'name' in key.algorithm
			? String(key.algorithm.name)
			: '';
	if (name === EC_KEY_ALGORITHM) return 'ec';
	return 'rsa'; // RSA-PSS (and any unknown algorithm) default to the rsa family
}

function keyDetail(key: CryptoKey): string {
	const algo = key.algorithm as
		| (RsaHashedKeyAlgorithm & { modulusLength?: number })
		| (EcKeyAlgorithm & { namedCurve?: string })
		| null;
	if (algo && typeof algo === 'object') {
		if ('modulusLength' in algo && typeof algo.modulusLength === 'number') {
			return `${algo.modulusLength}-bit`;
		}
		if ('namedCurve' in algo && typeof algo.namedCurve === 'string') {
			return algo.namedCurve;
		}
	}
	return 'unknown';
}

function toPublicKey(key: CryptoKey | CryptoKeyPair): CryptoKey {
	if (isKeyPair(key)) return key.publicKey;
	return key;
}

function isKeyPair(key: CryptoKey | CryptoKeyPair): key is CryptoKeyPair {
	return (
		typeof key === 'object' &&
		key !== null &&
		'privateKey' in key &&
		'publicKey' in key
	);
}

function assertKeyPair(pair: CryptoKeyPair): void {
	if (
		!pair ||
		typeof pair !== 'object' ||
		!pair.privateKey ||
		!pair.publicKey ||
		pair.privateKey.type !== 'private' ||
		pair.publicKey.type !== 'public'
	) {
		throw new Error(
			'keyCrypto: expected a CryptoKeyPair with a private and a public key.',
		);
	}
}

function assertPrivateKey(key: CryptoKey): void {
	if (!key || typeof key !== 'object' || key.type !== 'private') {
		throw new Error('keyCrypto: expected a private CryptoKey.');
	}
}

function assertPublicKey(key: CryptoKey): void {
	if (!key || typeof key !== 'object' || key.type !== 'public') {
		throw new Error('keyCrypto: expected a public CryptoKey.');
	}
}

async function exportDer(
	format: 'pkcs8' | 'spki',
	key: CryptoKey,
): Promise<ArrayBuffer> {
	try {
		return (await globalThis.crypto.subtle.exportKey(
			format,
			key,
		)) as ArrayBuffer;
	} catch {
		throw new Error(
			'keyCrypto.exportKey: key is not extractable or is not exportable in this format.',
		);
	}
}

async function exportJwk(key: CryptoKey): Promise<JsonWebKey> {
	try {
		return (await globalThis.crypto.subtle.exportKey('jwk', key)) as JsonWebKey;
	} catch {
		throw new Error(
			'keyCrypto.exportKey: key is not extractable or is not exportable in this format.',
		);
	}
}

// ---------------------------------------------------------------------------
// PEM encoding (RFC 7468)
// ---------------------------------------------------------------------------

function derToPem(der: ArrayBuffer, label: string): string {
	const body = bytesToBase64(new Uint8Array(der)).replace(
		new RegExp(`(.{${PEM_LINE_WIDTH}})`, 'g'),
		'$1\n',
	);
	return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function pemToDer(pem: string, label: string): Uint8Array<ArrayBuffer> {
	const header = `-----BEGIN ${label}-----`;
	const footer = `-----END ${label}-----`;
	const body = pem
		.split(header)
		.join('')
		.split(footer)
		.join('')
		.replace(/\s+/g, '');
	if (body.length === 0) {
		throw new Error(`keyCrypto: PEM is empty (missing ${label} body).`);
	}
	return base64ToBytes(body);
}

function assertPem(pem: string, label: string, fn: string): void {
	if (typeof pem !== 'string' || pem.length === 0) {
		throw new Error(`keyCrypto.${fn}: PEM must be a non-empty string.`);
	}
	if (!pem.includes(`-----BEGIN ${label}-----`)) {
		throw new Error(
			`keyCrypto.${fn}: PEM is missing the "-----BEGIN ${label}-----" header.`,
		);
	}
}

// ---------------------------------------------------------------------------
// RFC 7638 canonical JWK + byte helpers
// ---------------------------------------------------------------------------

/**
 * Build the canonical JSON string RFC 7638 §3.2 defines for a JWK: the
 * required public members only, sorted lexicographically, with no whitespace.
 * WebCrypto's JWK export never includes private members for a public key, and
 * we re-select the known-public members explicitly so a non-standard member
 * can never leak into the digest input (and thus into logs).
 */
function canonicalJwkForThumbprint(jwk: JsonWebKey): string {
	if (jwk.kty === 'EC') {
		return JSON.stringify({
			crv: jwk.crv,
			kty: jwk.kty,
			x: jwk.x,
			y: jwk.y,
		});
	}
	return JSON.stringify({
		e: jwk.e,
		kty: jwk.kty,
		n: jwk.n,
	});
}

function utf8ToBytes(s: string): Uint8Array<ArrayBuffer> {
	const enc = new TextEncoder().encode(s);
	const out = new Uint8Array(enc.length);
	out.set(enc);
	return out;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++)
		binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
