/**
 * Tests for the in-memory key rotation manager (ADA-713).
 *
 * Real WebCrypto throughout — the manager builds real `EncryptionService`
 * instances, so round-trip tests exercise the actual cipher (GCM + AAD).
 * PBKDF2 iterations are lowered to 1k for speed, matching
 * `encryptionService.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { EncryptionKey } from '../encryptionService.js';
import {
	KeyRotationManager,
	makeKeyRotationManager,
	DEFAULT_AAD,
} from '../keyRotationManager.js';

const KEY_A: EncryptionKey = { id: 'v1', secret: 'secret-a-0123456789abcdef' };
const KEY_B: EncryptionKey = { id: 'v2', secret: 'secret-b-0123456789abcdef' };

function manager(
	keys: EncryptionKey[],
	options: { activeKeyId?: string; aad?: string } = {},
): KeyRotationManager {
	return new KeyRotationManager(keys, {
		iterations: 1_000,
		...options,
	});
}

// ---------------------------------------------------------------------------
// Construction and validation
// ---------------------------------------------------------------------------

describe('KeyRotationManager construction', () => {
	it('rejects an empty key ring', () => {
		expect(() => manager([])).toThrow(/at least one encryption key/);
	});

	it('rejects duplicate key ids', () => {
		expect(() => manager([KEY_A, { ...KEY_A }])).toThrow(/duplicate key id/);
	});

	it('rejects empty secrets', () => {
		expect(() =>
			manager([{ id: 'v1', secret: '' }]),
		).toThrow(/empty secret/);
	});

	it('rejects invalid key ids', () => {
		expect(() =>
			manager([{ id: 'bad id!', secret: 'secret-x-0123456789abcdef' }]),
		).toThrow(/invalid key id/);
	});

	it('rejects an activeKeyId outside the ring', () => {
		expect(() =>
			manager([KEY_A, KEY_B], { activeKeyId: 'nope' }),
		).toThrow(/activeKeyId "nope" is not in the key ring/);
	});

	it('defaults the active key to the first key', () => {
		const m = manager([KEY_A, KEY_B]);
		expect(m.activeKeyId).toBe('v1');
	});

	it('honours an explicit activeKeyId', () => {
		const m = manager([KEY_A, KEY_B], { activeKeyId: 'v2' });
		expect(m.activeKeyId).toBe('v2');
	});

	it('rejects an empty AAD context', () => {
		expect(() => new KeyRotationManager([KEY_A], { aad: '' })).toThrow(
			/AAD context must be a non-empty string/,
		);
	});
});

// ---------------------------------------------------------------------------
// Active key selection (rotation semantics)
// ---------------------------------------------------------------------------

describe('selectActiveKey', () => {
	it('switches where new ciphertext goes without breaking old payloads', async () => {
		const m = manager([KEY_A, KEY_B]);
		const oldPayload = await m.encrypt('jira_api:old-token');

		m.selectActiveKey('v2');
		expect(m.activeKeyId).toBe('v2');

		const newPayload = await m.encrypt('jira_api:new-token');
		// v1 is no longer used for new writes…
		expect(newPayload.startsWith('hsenc:v1:v1:')).toBe(false);
		expect(newPayload.startsWith('hsenc:v1:v2:')).toBe(true);
		// …but payloads written under v1 still decrypt (read access kept).
		await expect(m.decrypt(oldPayload)).resolves.toBe('jira_api:old-token');
		await expect(m.decrypt(newPayload)).resolves.toBe('jira_api:new-token');
	});

	it('throws on an unknown key id', () => {
		const m = manager([KEY_A]);
		expect(() => m.selectActiveKey('ghost')).toThrow(/unknown key id "ghost"/);
	});

	it('keeps the same ring (no rebuild) when reselecting the active key', () => {
		const m = manager([KEY_A, KEY_B]);
		m.selectActiveKey('v1');
		expect(m.activeKeyId).toBe('v1');
		expect(m.listKeyIds()).toEqual(['v1', 'v2']);
	});

	it('works on an empty ring once a key exists', async () => {
		const m = manager([KEY_A]);
		const id = m.generateKey();
		m.selectActiveKey(id);
		await expect(m.encrypt('x')).resolves.toMatch(/^hsenc:/);
	});
});

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

describe('generateKey', () => {
	it('generates a fresh key and makes it active when the ring was empty', async () => {
		const m = manager([KEY_A]);
		const id = m.generateKey();
		expect(id).toMatch(/^k[0-9]+$/);
		expect(m.activeKeyId).toBe(id);
		expect(m.hasKey(id)).toBe(true);
		await expect(m.encrypt('fresh')).resolves.toMatch(
			new RegExp(`^hsenc:v1:${id}:`),
		);
	});

	it('does not promote a generated key when the ring already has an active key', () => {
		const m = manager([KEY_A, KEY_B]);
		m.generateKey();
		expect(m.activeKeyId).toBe('v1');
	});

	it('accepts an explicit key id', () => {
		const m = manager([KEY_A]);
		m.generateKey('rotation-2026-07');
		expect(m.hasKey('rotation-2026-07')).toBe(true);
	});

	it('rejects a duplicate explicit id', () => {
		const m = manager([KEY_A]);
		expect(() => m.generateKey('v1')).toThrow(/duplicate key id "v1"/);
	});

	it('rejects a malformed explicit id', () => {
		const m = manager([KEY_A]);
		expect(() => m.generateKey('bad id!')).toThrow(/invalid key id/);
	});

	it('uses the injected generateId seam and validates its output', () => {
		const m = new KeyRotationManager([KEY_A], {
			iterations: 1_000,
			generateId: (existing) => (existing.has('zz') ? 'yy' : 'zz'),
		});
		expect(m.generateKey()).toBe('zz');
		expect(m.generateKey()).toBe('yy');
	});

	it('rejects a generated id that collides with the ring', () => {
		const m = new KeyRotationManager([KEY_A], {
			iterations: 1_000,
			generateId: () => 'v1',
		});
		expect(() => m.generateKey()).toThrow(/collides with an existing key/);
	});

	it('default key ids are unique across many rotations', () => {
		const m = manager([KEY_A]);
		for (let i = 0; i < 50; i++) m.generateKey();
		const ids = m.listKeyIds();
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids[ids.length - 1]).toBe('k50');
	});

	it('generated secrets are distinct, 256-bit, and URL-safe', () => {
		const m = manager([KEY_A]);
		m.generateKey();
		m.generateKey();
		const secrets = m.exportKeys().map((k) => k.secret);
		const fresh = secrets.filter((s) => s !== KEY_A.secret);
		expect(fresh).toHaveLength(2);
		expect(new Set(fresh).size).toBe(2);
		expect(fresh[0]).toHaveLength(43); // 32 bytes, unpadded base64url
		expect(fresh[0]).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

// ---------------------------------------------------------------------------
// rotate
// ---------------------------------------------------------------------------

describe('rotate', () => {
	it('generates and promotes a new active key in one step', async () => {
		const m = manager([KEY_A, KEY_B]);
		const oldPayload = await m.encrypt('before-rotation');

		const newId = m.rotate();
		expect(newId).toMatch(/^k[0-9]+$/);
		expect(m.activeKeyId).toBe(newId);
		expect(m.listKeyIds()).toEqual(['v1', 'v2', newId]);

		const newPayload = await m.encrypt('after-rotation');
		expect(newPayload.startsWith(`hsenc:v1:${newId}:`)).toBe(true);
		// Retiring keys remain readable (the classic rotation promise).
		await expect(m.decrypt(oldPayload)).resolves.toBe('before-rotation');
		await expect(m.decrypt(newPayload)).resolves.toBe('after-rotation');
	});

	it('round-trips after many rotations without losing read access', async () => {
		const m = manager([KEY_A]);
		const payloads: string[] = [await m.encrypt('p0')];
		for (let i = 1; i <= 5; i++) {
			m.rotate();
			payloads.push(await m.encrypt(`p${i}`));
		}
		for (let i = 0; i < payloads.length; i++) {
			await expect(m.decrypt(payloads[i])).resolves.toBe(`p${i}`);
		}
	});
});

// ---------------------------------------------------------------------------
// Context switching
// ---------------------------------------------------------------------------

describe('switchContext', () => {
	it('keeps independent rings per context and restores the previous one', async () => {
		const m = manager([KEY_A]);
		const token = await m.encrypt('jira_api:token');
		expect(m.context).toBe(DEFAULT_AAD);

		m.switchContext('hoursmith:export-tokens:v2', [KEY_B]);
		expect(m.context).toBe('hoursmith:export-tokens:v2');
		expect(m.activeKeyId).toBe('v2');
		// Ciphertext is AAD-bound: the other context cannot read it.
		await expect(m.decrypt(token)).rejects.toThrow();

		const exportToken = await m.encrypt('export:token');
		expect(exportToken.startsWith('hsenc:v1:v2:')).toBe(true);

		m.switchContext(DEFAULT_AAD);
		expect(m.context).toBe(DEFAULT_AAD);
		expect(m.activeKeyId).toBe('v1');
		// Old context state survived the switch — switching is lossless.
		await expect(m.decrypt(token)).resolves.toBe('jira_api:token');
	});

	it('keeps a context rotation isolated from the other contexts', async () => {
		const m = manager([KEY_A]);
		m.switchContext('hoursmith:export-tokens:v2', [KEY_B]);

		const exportOld = await m.encrypt('export:old');
		const rotated = m.rotate();
		await expect(m.decrypt(exportOld)).resolves.toBe('export:old');

		m.switchContext(DEFAULT_AAD);
		expect(m.activeKeyId).toBe('v1');
		expect(m.listKeyIds()).toEqual(['v1']);
		expect(m.rotate()).toBe('k2'); // k1 counter is per-context
	});

	it('fresh contexts start empty and refuse crypto until a key exists', async () => {
		const m = manager([KEY_A]);
		m.switchContext('hoursmith:audit-logs:v1');
		expect(() => m.activeKeyId).toThrow(/has no keys/);
		await expect(m.encrypt('x')).rejects.toThrow(/has no keys/);

		const id = m.generateKey();
		expect(m.activeKeyId).toBe(id);
		await expect(m.encrypt('x')).resolves.toMatch(/^hsenc:/);
	});

	it('rejects seeding a context that already has keys', () => {
		const m = manager([KEY_A]);
		expect(() => m.switchContext(DEFAULT_AAD, [KEY_B])).toThrow(
			/refusing to replace an existing ring/,
		);
	});

	it('seeds a fresh context with supplied keys', async () => {
		const m = manager([KEY_A]);
		m.switchContext('hoursmith:export-tokens:v2', [KEY_B]);
		expect(m.activeKeyId).toBe('v2');
		await expect(m.encrypt('x')).resolves.toMatch(/^hsenc:v1:v2:/);
	});

	it('rejects an empty context id', () => {
		const m = manager([KEY_A]);
		expect(() => m.switchContext('')).toThrow(/non-empty string/);
	});

	it('tracks every context configured, in order', () => {
		const m = manager([KEY_A]);
		m.switchContext('hoursmith:export-tokens:v2', [KEY_B]);
		m.switchContext('hoursmith:audit-logs:v1');
		expect(m.listContexts()).toEqual([
			DEFAULT_AAD,
			'hoursmith:export-tokens:v2',
			'hoursmith:audit-logs:v1',
		]);
	});
});

// ---------------------------------------------------------------------------
// Ring export (rotation jobs)
// ---------------------------------------------------------------------------

describe('exportKeys', () => {
	it('returns the current ring as id/secret pairs in insertion order', () => {
		const m = manager([KEY_B, KEY_A]);
		m.generateKey('k3');
		expect(m.exportKeys()).toEqual([
			KEY_B,
			KEY_A,
			{ id: 'k3', secret: expect.any(String) },
		]);
	});

	it('exported secrets round-trip into a fresh manager (env handoff)', async () => {
		const m = manager([KEY_A, KEY_B]);
		const payload = await m.encrypt('jira_api:token');

		const rebuilt = manager(m.exportKeys(), { activeKeyId: m.activeKeyId });
		await expect(rebuilt.decrypt(payload)).resolves.toBe('jira_api:token');
	});
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('makeKeyRotationManager', () => {
	it('is a thin constructor wrapper', () => {
		const m = makeKeyRotationManager([KEY_A], { iterations: 1_000 });
		expect(m).toBeInstanceOf(KeyRotationManager);
		expect(m.activeKeyId).toBe('v1');
	});
});
