/**
 * Tests for the Auth Token Service (ADA-692).
 *
 * Three layers are exercised:
 *   - bundle serialization (the plaintext JSON stored encrypted),
 *   - the pure clock-skew tolerant expiry / silent-refresh triggers,
 *   - the service facade (storage + crypto + per-token validation).
 *
 * All storage is an in-memory fake; the cipher is the real AesCipher with
 * lowered PBKDF2 iterations (same approach as aesCrypto.test.ts) so
 * decrypt/tamper behavior is authentic. Nothing touches the network.
 */

import { describe, expect, it } from 'vitest';
import { makeAesCipher } from '../aesCrypto.js';
import {
	type AuthTokenBundle,
	AuthTokenError,
	type AuthTokenService,
	canSilentlyRefresh,
	makeAuthTokenService,
	parseBundle,
	serializeBundle,
	shouldRefresh,
	shouldSilentlyRefresh,
	tokenExpiry,
} from '../authTokenService.js';
import type {
	TokenProvider,
	TokenStorage,
	TokenUpsert,
	UserToken,
} from '../tokenStorage.js';

const SECRET = 'test-secret-12345';

const NOW_MS = Date.parse('2026-07-31T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Real AES cipher with fast key derivation for tests. */
function fastCipher() {
	return makeAesCipher(SECRET, { iterations: 1_000 });
}

/** In-memory TokenStorage fake, keyed by user:provider. */
function fakeStorage(rows: UserToken[] = []): TokenStorage & {
	rows: Map<string, UserToken>;
} {
	const map = new Map<string, UserToken>();
	for (const row of rows) {
		map.set(`${row.user_id}:${row.provider}`, { ...row });
	}
	let seq = 1;
	const stamp = () => new Date(NOW_MS + seq * 1_000).toISOString();
	return {
		rows: map,
		async getToken(userId, provider) {
			return map.get(`${userId}:${provider}`) ?? null;
		},
		async upsertToken(userId, input: TokenUpsert): Promise<UserToken> {
			const key = `${userId}:${input.provider}`;
			const existing = map.get(key);
			const row: UserToken = {
				id: existing?.id ?? `tok_${seq++}`,
				user_id: userId,
				provider: input.provider,
				label: input.label ?? null,
				encrypted_value: input.encrypted_value,
				status: input.status ?? 'active',
				created_at: existing?.created_at ?? stamp(),
				updated_at: stamp(),
				last_used_at: existing?.last_used_at ?? null,
			};
			map.set(key, row);
			return { ...row };
		},
		async listTokens(userId) {
			return [...map.values()]
				.filter((r) => r.user_id === userId)
				.sort((a, b) => a.created_at.localeCompare(b.created_at));
		},
		async revokeToken(userId, provider) {
			const key = `${userId}:${provider}`;
			const existing = map.get(key);
			if (!existing || existing.status === 'revoked') return null;
			const row = {
				...existing,
				status: 'revoked' as const,
				updated_at: stamp(),
			};
			map.set(key, row);
			return { ...row };
		},
		async deleteToken(userId, provider) {
			return map.delete(`${userId}:${provider}`);
		},
		async bumpLastUsed(userId, provider) {
			const key = `${userId}:${provider}`;
			const existing = map.get(key);
			if (existing) {
				map.set(key, { ...existing, last_used_at: stamp() });
			}
		},
	};
}

function service(
	overrides: {
		storage?: TokenStorage & { rows: Map<string, UserToken> };
		nowMs?: number;
	} = {},
): {
	svc: AuthTokenService;
	storage: TokenStorage & { rows: Map<string, UserToken> };
} {
	const storage = overrides.storage ?? fakeStorage();
	const svc = makeAuthTokenService({
		env: { TOKEN_ENCRYPTION_SECRET: SECRET },
		storage,
		cipher: fastCipher(),
		nowMs: overrides.nowMs ?? NOW_MS,
	});
	return { svc, storage };
}

function bundle(overrides: Partial<AuthTokenBundle> = {}): AuthTokenBundle {
	return {
		version: 1,
		provider: 'jira_api',
		accessToken: 'atatt3xfsecret',
		refreshToken: 'refresh-123',
		expiresAt: new Date(NOW_MS + 10 * MINUTE).toISOString(),
		tokenType: 'Bearer',
		scope: 'read:jira-user',
		...overrides,
	};
}

/** Insert a stored token row whose ciphertext is a real AES-encrypted bundle. */
async function storedRow(
	storage: TokenStorage & { rows: Map<string, UserToken> },
	provider: TokenProvider,
	overrides: Partial<AuthTokenBundle> = {},
	rowOverrides: Partial<UserToken> = {},
): Promise<UserToken> {
	const cipher = fastCipher();
	const encrypted = await cipher.encrypt(
		serializeBundle(bundle({ provider, ...overrides })),
	);
	const row = fakeTokenRow(provider, encrypted, rowOverrides);
	storage.rows.set(`${row.user_id}:${provider}`, row);
	return row;
}

function fakeTokenRow(
	provider: TokenProvider,
	encryptedValue: string,
	overrides: Partial<UserToken> = {},
): UserToken {
	return {
		id: '550e8400-e29b-41d4-a716-446655440000',
		user_id: 'usr_1',
		provider,
		label: null,
		encrypted_value: encryptedValue,
		status: 'active',
		created_at: '2026-07-28T00:00:00.000Z',
		updated_at: '2026-07-28T00:00:00.000Z',
		last_used_at: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Bundle serialization
// ---------------------------------------------------------------------------

describe('authTokenService bundle', () => {
	it('serialize/parse round-trips a full bundle', () => {
		const input = bundle();
		expect(parseBundle(serializeBundle(input))).toEqual(input);
	});

	it('parse accepts null refreshToken / expiresAt (PAT providers)', () => {
		const input = bundle({ refreshToken: null, expiresAt: null });
		expect(parseBundle(serializeBundle(input))).toEqual(input);
	});

	it('parse rejects non-JSON payloads', () => {
		expect(() => parseBundle('not-json')).toThrow(AuthTokenError);
		expect(() => parseBundle('')).toThrow(AuthTokenError);
	});

	it('parse rejects non-object payloads', () => {
		expect(() => parseBundle('[]')).toThrow(AuthTokenError);
		expect(() => parseBundle('"str"')).toThrow(AuthTokenError);
	});

	it('parse rejects unsupported or missing versions', () => {
		expect(() =>
			parseBundle(serializeBundle({ ...bundle(), version: 2 as never })),
		).toThrow(AuthTokenError);
		const { version: _version, ...withoutVersion } = bundle();
		expect(() => parseBundle(JSON.stringify(withoutVersion))).toThrow(
			AuthTokenError,
		);
	});

	it('parse rejects missing / empty access tokens', () => {
		expect(() =>
			parseBundle(serializeBundle({ ...bundle(), accessToken: '' })),
		).toThrow(AuthTokenError);
		const { accessToken: _at, ...withoutAt } = bundle();
		expect(() => parseBundle(JSON.stringify(withoutAt))).toThrow(
			AuthTokenError,
		);
	});

	it('parse rejects non-string refreshToken', () => {
		expect(() =>
			parseBundle(serializeBundle({ ...bundle(), refreshToken: 42 as never })),
		).toThrow(AuthTokenError);
	});

	it('parse rejects invalid expiresAt values', () => {
		for (const bad of ['not-a-date', '2026-01-01', '123456789']) {
			expect(() =>
				parseBundle(serializeBundle({ ...bundle(), expiresAt: bad })),
			).toThrow(AuthTokenError);
		}
	});
});

// ---------------------------------------------------------------------------
// Clock-skew tolerant expiry + refresh triggers
// ---------------------------------------------------------------------------

describe('tokenExpiry', () => {
	it('reports fresh while more than the lead window remains', () => {
		const info = tokenExpiry(
			bundle({ expiresAt: new Date(NOW_MS + 10 * MINUTE).toISOString() }),
			NOW_MS,
		);
		expect(info.state).toBe('fresh');
		expect(info.expiresAtMs).toBe(NOW_MS + 10 * MINUTE);
		expect(info.remainingMs).toBe(10 * MINUTE);
	});

	it('reports expiring inside the lead window (silent-refresh trigger)', () => {
		const info = tokenExpiry(
			bundle({ expiresAt: new Date(NOW_MS + 2 * MINUTE).toISOString() }),
			NOW_MS,
		);
		expect(info.state).toBe('expiring');
	});

	it('tolerates expiry up to the skew margin (clock ahead of provider)', () => {
		// Expired 30s ago but within the 60s skew → still the refresh zone.
		const info = tokenExpiry(
			bundle({ expiresAt: new Date(NOW_MS - 30_000).toISOString() }),
			NOW_MS,
		);
		expect(info.state).toBe('expiring');
		expect(info.remainingMs).toBe(-30_000);
	});

	it('reports expired only beyond the skew margin', () => {
		const info = tokenExpiry(
			bundle({ expiresAt: new Date(NOW_MS - 2 * MINUTE).toISOString() }),
			NOW_MS,
		);
		expect(info.state).toBe('expired');
	});

	it('reports unknown when the bundle has no expiry', () => {
		expect(tokenExpiry(bundle({ expiresAt: null }), NOW_MS)).toEqual({
			state: 'unknown',
			expiresAtMs: null,
			remainingMs: null,
		});
	});

	it('never throws on unparseable dates (defensive)', () => {
		expect(
			tokenExpiry({ expiresAt: 'garbage' } as AuthTokenBundle, NOW_MS).state,
		).toBe('unknown');
	});

	it('honors boundary conditions exactly', () => {
		const lead = 5 * MINUTE;
		const skew = MINUTE;
		expect(
			tokenExpiry(
				bundle({ expiresAt: new Date(NOW_MS + lead).toISOString() }),
				NOW_MS,
			).state,
		).toBe('expiring');
		expect(
			tokenExpiry(
				bundle({ expiresAt: new Date(NOW_MS - skew).toISOString() }),
				NOW_MS,
			).state,
		).toBe('expiring');
	});

	it('honors custom skew and lead options', () => {
		const opts = { skewMs: 0, refreshLeadMs: HOUR };
		const expired30s = bundle({
			expiresAt: new Date(NOW_MS - 30_000).toISOString(),
		});
		expect(tokenExpiry(expired30s, NOW_MS, opts).state).toBe('expired');
		const in10min = bundle({
			expiresAt: new Date(NOW_MS + 10 * MINUTE).toISOString(),
		});
		expect(tokenExpiry(in10min, NOW_MS, opts).state).toBe('expiring');
	});
});

describe('shouldRefresh / canSilentlyRefresh / shouldSilentlyRefresh', () => {
	it('does not refresh while fresh', () => {
		const b = bundle({
			expiresAt: new Date(NOW_MS + 10 * MINUTE).toISOString(),
		});
		expect(shouldRefresh(b, NOW_MS)).toBe(false);
		expect(shouldSilentlyRefresh(b, NOW_MS)).toBe(false);
	});

	it('triggers refresh inside the lead window', () => {
		const b = bundle({
			expiresAt: new Date(NOW_MS + 2 * MINUTE).toISOString(),
		});
		expect(shouldRefresh(b, NOW_MS)).toBe(true);
		expect(shouldSilentlyRefresh(b, NOW_MS)).toBe(true);
	});

	it('triggers refresh for a just-expired token inside the skew grace', () => {
		const b = bundle({ expiresAt: new Date(NOW_MS - 30_000).toISOString() });
		expect(shouldRefresh(b, NOW_MS)).toBe(true);
		expect(shouldSilentlyRefresh(b, NOW_MS)).toBe(true);
	});

	it('does not trigger for hard-expired tokens (re-auth path)', () => {
		const b = bundle({
			expiresAt: new Date(NOW_MS - 2 * MINUTE).toISOString(),
		});
		expect(shouldRefresh(b, NOW_MS)).toBe(false);
	});

	it('does not trigger when the token has no expiry', () => {
		const b = bundle({ expiresAt: null });
		expect(shouldRefresh(b, NOW_MS)).toBe(false);
		expect(shouldSilentlyRefresh(b, NOW_MS)).toBe(false);
	});

	it('cannot silently refresh without a refresh token (PAT providers)', () => {
		const b = bundle({
			expiresAt: new Date(NOW_MS + 2 * MINUTE).toISOString(),
			refreshToken: null,
		});
		expect(shouldRefresh(b, NOW_MS)).toBe(true);
		expect(canSilentlyRefresh(b)).toBe(false);
		expect(shouldSilentlyRefresh(b, NOW_MS)).toBe(false);
	});

	it('canSilentlyRefresh requires a non-empty refresh token', () => {
		expect(canSilentlyRefresh({ refreshToken: 'abc' })).toBe(true);
		expect(canSilentlyRefresh({ refreshToken: '' })).toBe(false);
		expect(canSilentlyRefresh({ refreshToken: null })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Service: storage (secure persistence)
// ---------------------------------------------------------------------------

describe('makeAuthTokenService', () => {
	it('fails closed when TOKEN_ENCRYPTION_SECRET is unset', () => {
		expect(() =>
			makeAuthTokenService({
				env: {},
				storage: fakeStorage(),
				cipher: fastCipher(),
			}),
		).toThrow(/TOKEN_ENCRYPTION_SECRET/);
	});
});

describe('authTokenService.saveToken', () => {
	it('persists an encrypted bundle and never stores plaintext', async () => {
		const { svc, storage } = service();
		const row = await svc.saveToken('usr_1', 'jira_api', {
			accessToken: 'plaintext-secret',
			refreshToken: 'refresh-secret',
			expiresAt: new Date(NOW_MS + HOUR).toISOString(),
			tokenType: 'Bearer',
			scope: 'read:jira-user',
		});
		expect(row.status).toBe('active');
		expect(row.encrypted_value.startsWith('aes256gcm:')).toBe(true);
		expect(row.encrypted_value).not.toContain('plaintext-secret');
		expect(row.encrypted_value).not.toContain('refresh-secret');
		// The plaintext bundle is what a decrypt of the stored value yields.
		const decrypted = await fastCipher().decrypt(row.encrypted_value);
		const parsed = parseBundle(decrypted);
		expect(parsed.accessToken).toBe('plaintext-secret');
		expect(parsed.refreshToken).toBe('refresh-secret');
		expect(parsed.expiresAt).toBe(new Date(NOW_MS + HOUR).toISOString());
		expect(parsed.provider).toBe('jira_api');
	});

	it('defaults refreshToken / expiresAt / metadata to null', async () => {
		const { svc } = service();
		const row = await svc.saveToken('usr_1', 'rescuetime', {
			accessToken: 'opaque-key',
		});
		const parsed = parseBundle(await fastCipher().decrypt(row.encrypted_value));
		expect(parsed.refreshToken).toBeNull();
		expect(parsed.expiresAt).toBeNull();
		expect(parsed.tokenType).toBeNull();
		expect(parsed.scope).toBeNull();
	});

	it('rejects an empty access token', async () => {
		const { svc } = service();
		await expect(
			svc.saveToken('usr_1', 'jira_api', { accessToken: '' }),
		).rejects.toThrow(AuthTokenError);
	});

	it('rejects an invalid expiresAt', async () => {
		const { svc } = service();
		await expect(
			svc.saveToken('usr_1', 'jira_api', {
				accessToken: 'at',
				expiresAt: '2026-01-01',
			}),
		).rejects.toThrow(AuthTokenError);
	});

	it('upsert overwrites an existing token for the same provider', async () => {
		const { svc, storage } = service();
		await svc.saveToken('usr_1', 'jira_api', { accessToken: 'first' });
		await svc.saveToken('usr_1', 'jira_api', { accessToken: 'second' });
		const rows = storage.rows.get('usr_1:jira_api');
		expect(rows).toBeDefined();
		const parsed = parseBundle(
			await fastCipher().decrypt(rows!.encrypted_value),
		);
		expect(parsed.accessToken).toBe('second');
	});
});

describe('authTokenService.getDecryptedToken', () => {
	it('returns the decrypted bundle on a successful round-trip', async () => {
		const { svc, storage } = service();
		await storedRow(storage, 'jira_api', {
			accessToken: 'at-secret',
			scope: 'read',
		});
		const out = await svc.getDecryptedToken('usr_1', 'jira_api');
		expect(out).not.toBeNull();
		expect(out!.accessToken).toBe('at-secret');
		expect(out!.scope).toBe('read');
		expect(out!.provider).toBe('jira_api');
	});

	it('returns null when no token exists', async () => {
		const { svc } = service();
		expect(await svc.getDecryptedToken('usr_1', 'gitlab')).toBeNull();
	});

	it('bumps last_used_at on a successful read', async () => {
		const { svc, storage } = service();
		await storedRow(storage, 'jira_api');
		await svc.getDecryptedToken('usr_1', 'jira_api');
		expect(storage.rows.get('usr_1:jira_api')!.last_used_at).not.toBeNull();
	});

	it('fails closed on revoked tokens', async () => {
		const { svc, storage } = service();
		await storedRow(storage, 'jira_api', {}, { status: 'revoked' });
		await expect(svc.getDecryptedToken('usr_1', 'jira_api')).rejects.toThrow(
			/revoked/,
		);
	});

	it('fails closed when the stored value cannot be decrypted', async () => {
		const { svc, storage } = service();
		const cipher = fastCipher();
		const good = await cipher.encrypt(serializeBundle(bundle()));
		// Tamper with the ciphertext region so AES-GCM auth fails.
		const body = good.slice('aes256gcm:'.length);
		const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
		bytes[bytes.length - 1] ^= 0xff;
		const tampered = `aes256gcm:${btoa(String.fromCharCode(...bytes))}`;
		storage.rows.set('usr_1:jira_api', fakeTokenRow('jira_api', tampered));
		await expect(svc.getDecryptedToken('usr_1', 'jira_api')).rejects.toThrow(
			/token_unreadable|decrypt/,
		);
	});

	it('fails closed on a malformed bundle', async () => {
		const { svc, storage } = service();
		const cipher = fastCipher();
		storage.rows.set(
			'usr_1:jira_api',
			fakeTokenRow('jira_api', await cipher.encrypt('{not json')),
		);
		await expect(
			svc.getDecryptedToken('usr_1', 'jira_api'),
		).rejects.toMatchObject({
			code: 'token_malformed',
		});
	});
});

// ---------------------------------------------------------------------------
// Service: validation without global UI impact
// ---------------------------------------------------------------------------

describe('authTokenService.listStatuses', () => {
	it('reports per-token health across every stored provider', async () => {
		const { svc, storage } = service();
		await storedRow(storage, 'jira_api', {
			expiresAt: new Date(NOW_MS + HOUR).toISOString(),
		}); // active
		await storedRow(storage, 'gitlab', {
			expiresAt: new Date(NOW_MS + 2 * MINUTE).toISOString(),
		}); // expiring
		await storedRow(storage, 'rescuetime', {
			expiresAt: null,
			refreshToken: null,
		}); // no_expiry
		const statuses = await svc.listStatuses('usr_1');
		const byProvider = new Map(statuses.map((s) => [s.provider, s.status]));
		expect(byProvider.get('jira_api')).toBe('active');
		expect(byProvider.get('gitlab')).toBe('expiring');
		expect(byProvider.get('rescuetime')).toBe('no_expiry');
	});

	it('isolates revoked, malformed and unreadable tokens without throwing', async () => {
		const { svc, storage } = service();
		await storedRow(storage, 'jira_api', {
			expiresAt: new Date(NOW_MS + HOUR).toISOString(),
		});
		await storedRow(storage, 'gitlab', {}, { status: 'revoked' });
		const cipher = fastCipher();
		storage.rows.set(
			'usr_1:rescuetime',
			fakeTokenRow('rescuetime', await cipher.encrypt('garbage-bundle')),
		);
		storage.rows.set(
			'usr_1:toggl',
			fakeTokenRow('toggl', 'aes256gcm:bm90LWNpcGhlcnRleHQ='), // undecryptable
		);

		const statuses = await svc.listStatuses('usr_1');
		const byProvider = new Map(statuses.map((s) => [s.provider, s.status]));
		expect(byProvider.get('jira_api')).toBe('active');
		expect(byProvider.get('gitlab')).toBe('revoked');
		expect(byProvider.get('rescuetime')).toBe('malformed');
		expect(byProvider.get('toggl')).toBe('unreadable');
	});

	it('never includes secrets in status payloads', async () => {
		const { svc, storage } = service();
		await storedRow(storage, 'jira_api', {
			accessToken: 'super-secret-at',
			refreshToken: 'super-secret-rt',
		});
		const statuses = await svc.listStatuses('usr_1');
		const serialized = JSON.stringify(statuses);
		expect(serialized).not.toContain('super-secret-at');
		expect(serialized).not.toContain('super-secret-rt');
	});

	it('reports expired rows for hard-expired tokens', async () => {
		const { svc, storage } = service();
		await storedRow(storage, 'jira_api', {
			expiresAt: new Date(NOW_MS - 2 * MINUTE).toISOString(),
		});
		const statuses = await svc.listStatuses('usr_1');
		expect(statuses[0].status).toBe('expired');
		expect(statuses[0].remainingMs).toBeLessThan(0);
	});
});

// ---------------------------------------------------------------------------
// Service: silent-refresh triggers
// ---------------------------------------------------------------------------

describe('authTokenService.silentRefreshDecision', () => {
	it('returns null when no token exists', async () => {
		const { svc } = service();
		expect(await svc.silentRefreshDecision('usr_1', 'jira_api')).toBeNull();
	});

	it('recommends a silent refresh for an expiring OAuth token', async () => {
		const { svc, storage } = service();
		await storedRow(storage, 'jira_api', {
			expiresAt: new Date(NOW_MS + 2 * MINUTE).toISOString(),
			refreshToken: 'refresh-token',
		});
		const decision = await svc.silentRefreshDecision('usr_1', 'jira_api');
		expect(decision!.state).toBe('expiring');
		expect(decision!.shouldRefresh).toBe(true);
		expect(decision!.canRefresh).toBe(true);
		expect(decision!.shouldSilentlyRefresh).toBe(true);
	});

	it('does not silently refresh a PAT without a refresh grant', async () => {
		const { svc, storage } = service();
		await storedRow(storage, 'gitlab', {
			expiresAt: new Date(NOW_MS + 2 * MINUTE).toISOString(),
			refreshToken: null,
		});
		const decision = await svc.silentRefreshDecision('usr_1', 'gitlab');
		expect(decision!.state).toBe('expiring');
		expect(decision!.shouldRefresh).toBe(true);
		expect(decision!.canRefresh).toBe(false);
		expect(decision!.shouldSilentlyRefresh).toBe(false);
	});

	it('never throws on unreadable or revoked tokens', async () => {
		const { svc, storage } = service();
		storage.rows.set(
			'usr_1:jira_api',
			fakeTokenRow('jira_api', 'aes256gcm:bm90LWNpcGhlcnRleHQ='),
		);
		storage.rows.set(
			'usr_1:gitlab',
			fakeTokenRow(
				'gitlab',
				await fastCipher().encrypt(
					serializeBundle(bundle({ provider: 'gitlab' })),
				),
				{
					status: 'revoked',
				},
			),
		);
		const unreadable = await svc.silentRefreshDecision('usr_1', 'jira_api');
		expect(unreadable!.state).toBe('unreadable');
		expect(unreadable!.shouldSilentlyRefresh).toBe(false);
		const revoked = await svc.silentRefreshDecision('usr_1', 'gitlab');
		expect(revoked!.state).toBe('revoked');
		expect(revoked!.shouldSilentlyRefresh).toBe(false);
	});

	it('reports hard-expired tokens without a refresh trigger', async () => {
		const { svc, storage } = service();
		await storedRow(storage, 'jira_api', {
			expiresAt: new Date(NOW_MS - 2 * MINUTE).toISOString(),
			refreshToken: 'refresh-token',
		});
		const decision = await svc.silentRefreshDecision('usr_1', 'jira_api');
		expect(decision!.state).toBe('expired');
		expect(decision!.shouldRefresh).toBe(false);
		expect(decision!.shouldSilentlyRefresh).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Service: passthrough ops
// ---------------------------------------------------------------------------

describe('authTokenService.revokeToken / deleteToken', () => {
	it('revokes and hard-deletes through the storage layer', async () => {
		const { svc, storage } = service();
		await storedRow(storage, 'jira_api');
		const revoked = await svc.revokeToken('usr_1', 'jira_api');
		expect(revoked!.status).toBe('revoked');
		expect(await svc.deleteToken('usr_1', 'jira_api')).toBe(true);
		expect(await svc.deleteToken('usr_1', 'jira_api')).toBe(false);
	});
});
