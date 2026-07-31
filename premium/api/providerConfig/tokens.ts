/**
 * Provider token CRUD for Hoursmith Premium (ADA-271, ADA-523).
 *
 * GET    /api/providerConfig/tokens          — list all provider tokens for the user
 * POST   /api/providerConfig/tokens          — upsert a token (provider + encrypted_value)
 * DELETE /api/providerConfig/tokens?provider=x — delete a token for a provider
 *
 * Tokens are encrypted at rest via the `user_tokens` table (ADA-648). This
 * endpoint handles JWT verification, encryption, and storage. The service-role
 * key is used server-side; it is NEVER returned to the client.
 *
 * Logging discipline (security-critical):
 *   DO log:    timestamp, user_id (post-verification), operation, outcome.
 *   DO NOT log: token values, Authorization headers, request body.
 */

import {
	isTokenProvider,
	type TokenProvider,
} from '../_lib/tokenStorage.js';
import { makeTokenStorage, type TokenStorage } from '../_lib/tokenStorage.js';
import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface TokenCrudDeps {
	admin?: SupabaseAdminClient;
	tokens?: TokenStorage;
}

// ── Public token shape returned to the client (never includes encrypted_value) ──

export interface PublicToken {
	provider: TokenProvider;
	label: string | null;
	status: string;
	created_at: string;
	updated_at: string;
	last_used_at: string | null;
}

// ── Request body shapes ──

export interface UpsertTokenRequest {
	provider: string;
	label?: string;
	apiKey: string;
}

// ── Handler ──

export default async function handler(request: Request): Promise<Response> {
	return handleTokens(request);
}

export async function handleTokens(
	request: Request,
	deps: TokenCrudDeps = {},
): Promise<Response> {
	const method = request.method;

	if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		logEvent({ userId: null, status: 401, note: 'missing_token' });
		return jsonResponse(401, { error: 'missing_token' });
	}

	let admin: SupabaseAdminClient;
	try {
		admin = deps.admin ?? defaultSupabaseAdmin();
	} catch (err) {
		logEvent({
			userId: null,
			status: 500,
			note: `server_misconfigured:${(err as Error).message}`,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	const userId = await admin.getUserIdFromToken(token);
	if (!userId) {
		logEvent({ userId: null, status: 401, note: 'invalid_token' });
		return jsonResponse(401, { error: 'invalid_token' });
	}

	let store: TokenStorage;
	try {
		store =
			deps.tokens ??
			makeTokenStorage({
				SUPABASE_URL: process.env.SUPABASE_URL,
				SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
			});
	} catch (err) {
		logEvent({
			userId,
			status: 500,
			note: `token_storage_init_failed:${(err as Error).message}`,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	try {
		switch (method) {
			case 'GET':
				return handleList(userId, store);
			case 'POST':
				return handleUpsert(userId, store, request);
			case 'DELETE':
				return handleDelete(userId, store, request);
			default:
				return jsonResponse(405, { error: 'method_not_allowed' });
		}
	} catch (err) {
		logEvent({
			userId,
			status: 500,
			note: `token_op_failed:${(err as Error).message}`,
		});
		return jsonResponse(500, { error: 'token_operation_failed' });
	}
}

// ── Operation handlers ──

async function handleList(
	userId: string,
	store: TokenStorage,
): Promise<Response> {
	const tokens = await store.listTokens(userId);
	const publicTokens: PublicToken[] = tokens.map((t) => ({
		provider: t.provider,
		label: t.label,
		status: t.status,
		created_at: t.created_at,
		updated_at: t.updated_at,
		last_used_at: t.last_used_at,
	}));
	logEvent({ userId, operation: 'list', status: 200 });
	return jsonResponse(200, { tokens: publicTokens } as unknown as Record<
		string,
		unknown
	>);
}

async function handleUpsert(
	userId: string,
	store: TokenStorage,
	request: Request,
): Promise<Response> {
	let body: UpsertTokenRequest;
	try {
		body = (await request.json()) as UpsertTokenRequest;
	} catch {
		return jsonResponse(400, { error: 'invalid_json' });
	}

	if (!body.provider || !isTokenProvider(body.provider)) {
		return jsonResponse(400, {
			error: 'invalid_provider',
			valid: [
				'jira_api',
				'gitlab',
				'rescuetime',
				'github',
				'toggl',
				'harvest',
				'clockify',
				'custom',
			],
		});
	}

	if (!body.apiKey || typeof body.apiKey !== 'string' || body.apiKey.trim().length === 0) {
		return jsonResponse(400, { error: 'api_key_required' });
	}

	const encryptedValue = await encryptValue(body.apiKey.trim());

	const upserted = await store.upsertToken(userId, {
		provider: body.provider as TokenProvider,
		label: body.label?.trim() || undefined,
		encrypted_value: encryptedValue,
	});

	const publicToken: PublicToken = {
		provider: upserted.provider,
		label: upserted.label,
		status: upserted.status,
		created_at: upserted.created_at,
		updated_at: upserted.updated_at,
		last_used_at: upserted.last_used_at,
	};

	logEvent({ userId, operation: 'upsert', provider: body.provider, status: 200 });
	return jsonResponse(200, { token: publicToken } as unknown as Record<
		string,
		unknown
	>);
}

async function handleDelete(
	userId: string,
	store: TokenStorage,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	const provider = url.searchParams.get('provider');

	if (!provider || !isTokenProvider(provider)) {
		return jsonResponse(400, {
			error: 'invalid_provider',
			valid: [
				'jira_api',
				'gitlab',
				'rescuetime',
				'github',
				'toggl',
				'harvest',
				'clockify',
				'custom',
			],
		});
	}

	const deleted = await store.deleteToken(userId, provider as TokenProvider);

	logEvent({ userId, operation: 'delete', provider, status: deleted ? 200 : 404 });
	if (!deleted) {
		return jsonResponse(404, { error: 'token_not_found' });
	}

	return jsonResponse(200, { deleted: true } as unknown as Record<
		string,
		unknown
	>);
}

// ── Encryption ──

const ENCRYPTION_ALGORITHM: AesKeyGenParams = { name: 'AES-GCM', length: 256 };
const IV_LENGTH_BYTES = 12;

/**
 * Derive a CryptoKey from the ENCRYPTION_KEY environment variable.
 * The env var must be a base64-encoded 32-byte key.
 */
async function getEncryptionKey(): Promise<CryptoKey> {
	const keyB64 = process.env.ENCRYPTION_KEY;
	if (!keyB64) {
		throw new Error('ENCRYPTION_KEY environment variable is not set.');
	}
	const keyBytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
	if (keyBytes.length !== 32) {
		throw new Error(
			'ENCRYPTION_KEY must be 32 bytes (base64-encoded).',
		);
	}
	return crypto.subtle.importKey(
		'raw',
		keyBytes,
		ENCRYPTION_ALGORITHM,
		false,
		['encrypt', 'decrypt'],
	);
}

/**
 * Encrypt a plaintext API key using AES-256-GCM (Web Crypto).
 *
 * Returns `aes256gcm:<base64(iv + ciphertext)>` matching the wire format
 * expected by `tokenStorage`. The IV is randomly generated per encryption
 * and prepended to the ciphertext so each stored value is unique.
 */
async function encryptValue(plaintext: string): Promise<string> {
	const key = await getEncryptionKey();
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
	const encoded = new TextEncoder().encode(plaintext);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		encoded,
	);

	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.length);

	return `aes256gcm:${btoa(String.fromCharCode(...combined))}`;
}

/**
 * Decrypt a value previously encrypted with {@link encryptValue}.
 * Used when consuming stored provider tokens for upstream API calls.
 */
export async function decryptValue(encrypted: string): Promise<string> {
	if (!encrypted.startsWith('aes256gcm:')) {
		throw new Error('Invalid encrypted value format.');
	}
	const key = await getEncryptionKey();
	const combined = Uint8Array.from(
		atob(encrypted.slice('aes256gcm:'.length)),
		(c) => c.charCodeAt(0),
	);
	const iv = combined.slice(0, IV_LENGTH_BYTES);
	const ciphertext = combined.slice(IV_LENGTH_BYTES);
	const decrypted = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv },
		key,
		ciphertext,
	);
	return new TextDecoder().decode(decrypted);
}

// ── Helpers ──

function extractBearer(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const token = match[1].trim();
	return token.length > 0 ? token : null;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

interface LogFields {
	userId: string | null;
	status: number;
	operation?: string;
	provider?: string;
	note?: string;
}

function logEvent(fields: LogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-provider-config',
			user_id: fields.userId,
			status: fields.status,
			...(fields.operation ? { operation: fields.operation } : {}),
			...(fields.provider ? { provider: fields.provider } : {}),
			...(fields.note ? { note: fields.note } : {}),
		}),
	);
}
