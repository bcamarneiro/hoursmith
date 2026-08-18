/**
 * Tests for the secure logging sanitizer (ADA-716).
 *
 * The sanitizer is defense-in-depth for the premium API's crypto paths: even
 * if an error message or log payload accidentally carries a token or an
 * encrypted blob, nothing secret-shaped may reach `console.*`. These tests
 * exercise the masking patterns directly against real token/payload shapes
 * produced by `aesCrypto`/`encryptionService`, plus the logger wrapper via
 * console spies.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeForLog, secureLogger } from '../secureLog.js';

const JIRA_TOKEN = 'jira_api:ATATT3xFfGF0thisIsASecretTokenValue123';
const RAW_TOKEN = 'ATATT3xFfGF0anotherSecretAtlassianTokenValue456';
const AES_PAYLOAD =
	'aes256gcm:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v';
const HSENC_PAYLOAD =
	'hsenc:v1:v1:aes256gcm:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v';
const BEARER = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret.signature';

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// String masking
// ---------------------------------------------------------------------------

describe('sanitizeForLog string masking', () => {
	it('redacts a jira_api: token, keeping the scheme prefix for triage', () => {
		const sanitized = sanitizeForLog(JIRA_TOKEN);
		expect(sanitized).toContain('jira_api:');
		expect(sanitized).not.toContain('ATATT3xFfGF0thisIsASecretTokenValue123');
		expect(sanitized).toBe('jira_api:[redacted]');
	});

	it('redacts a raw Atlassian API token (no prefix)', () => {
		const sanitized = sanitizeForLog(RAW_TOKEN);
		expect(sanitized).not.toContain('anotherSecretAtlassianTokenValue456');
		expect(sanitized).toBe('[redacted]');
	});

	it('redacts an aes256gcm payload, keeping the payload kind', () => {
		const sanitized = sanitizeForLog(AES_PAYLOAD);
		expect(sanitized).toContain('aes256gcm:');
		expect(sanitized).not.toContain('AAECAwQFBgcICQoLDA0ODxAR');
		expect(sanitized).toBe('aes256gcm:[redacted]');
	});

	it('redacts an hsenc envelope but keeps the key id for triage', () => {
		const sanitized = sanitizeForLog(HSENC_PAYLOAD);
		expect(sanitized).toContain('hsenc:v1:v1:');
		expect(sanitized).not.toContain('AAECAwQFBgcICQoLDA0ODxAR');
		expect(sanitized).toBe('hsenc:v1:v1:[redacted]');
	});

	it('redacts bearer/basic credentials anywhere in a string', () => {
		expect(sanitizeForLog(`authorization ${BEARER} retry=1`)).toBe(
			'authorization Bearer [redacted] retry=1',
		);
		expect(sanitizeForLog(`Basic ${'b64credentialz123'}`)).toBe(
			'Basic [redacted]',
		);
	});

	it('redacts authorization and cookie header lines', () => {
		expect(sanitizeForLog('authorization: Bearer supersecretvalue123')).toBe(
			'authorization: [redacted]',
		);
		expect(sanitizeForLog('Cookie: session=abc123def456ghi')).toBe(
			'Cookie: [redacted]',
		);
	});

	it('redacts every occurrence when several secrets share one string', () => {
		const text = `decrypt failed with ${JIRA_TOKEN} then ${AES_PAYLOAD} done`;
		const sanitized = sanitizeForLog(text) as string;
		expect(sanitized).not.toContain('ATATT');
		expect(sanitized).not.toContain('AAECAwQF');
		expect(sanitized).toContain('decrypt failed with');
		expect(sanitized).toContain('done');
	});

	it('leaves benign triage text untouched', () => {
		const text =
			'upstream_error target_host=acme.atlassian.net status=502 ts=2026-07-31T12:00:00.000Z issue=ADA-716';
		expect(sanitizeForLog(text)).toBe(text);
	});
});

// ---------------------------------------------------------------------------
// Object / error masking
// ---------------------------------------------------------------------------

describe('sanitizeForLog objects and errors', () => {
	it('redacts values under secret-typed keys regardless of shape', () => {
		const input = {
			event: 'upstream_error',
			target_host: 'acme.atlassian.net',
			access_token: JIRA_TOKEN,
			password: 'hunter2',
			apiKey: 'k-1234567890',
			authorization: BEARER,
			auth_provider: 'jira', // benign `auth`-containing key stays visible
		};
		const sanitized = sanitizeForLog(input) as Record<string, unknown>;
		expect(sanitized.event).toBe('upstream_error');
		expect(sanitized.target_host).toBe('acme.atlassian.net');
		expect(sanitized.auth_provider).toBe('jira');
		expect(sanitized.access_token).toBe('[redacted]');
		expect(sanitized.password).toBe('[redacted]');
		expect(sanitized.apiKey).toBe('[redacted]');
		expect(sanitized.authorization).toBe('[redacted]');
		expect(JSON.stringify(sanitized)).not.toContain('ATATT');
	});

	it('sanitizes nested objects and arrays', () => {
		const input = {
			context: { token: { value: RAW_TOKEN }, attempts: 2 },
			history: [{ ok: true }, { ok: false, error: `boom ${JIRA_TOKEN}` }],
		};
		const sanitized = sanitizeForLog(input) as Record<string, unknown>;
		expect(sanitized.context).toEqual({ token: '[redacted]', attempts: 2 });
		expect(sanitized.history).toEqual([
			{ ok: true },
			{ ok: false, error: 'boom jira_api:[redacted]' },
		]);
	});

	it('keeps error name and code, masks message and stack', () => {
		const err = new Error(`decrypt failed: ${HSENC_PAYLOAD}`);
		const sanitized = sanitizeForLog(err) as Record<string, unknown>;
		expect(sanitized.name).toBe('Error');
		expect(sanitized.message).toBe('decrypt failed: hsenc:v1:v1:[redacted]');
		expect(JSON.stringify(sanitized)).not.toContain('AAECAwQF');
	});

	it('recurses into error causes', () => {
		const cause = new Error(`cause: ${RAW_TOKEN}`);
		const err = new Error('outer', { cause });
		const sanitized = sanitizeForLog(err) as Record<string, unknown>;
		expect((sanitized.cause as { message: string }).message).toBe(
			'cause: [redacted]',
		);
	});

	it('redacts own enumerable secret fields on errors', () => {
		const err = new Error('boom');
		(err as Error & { token?: string }).token = JIRA_TOKEN;
		const sanitized = sanitizeForLog(err) as Record<string, unknown>;
		expect(sanitized.token).toBe('[redacted]');
		expect(JSON.stringify(sanitized)).not.toContain('ATATT');
	});

	it('does not throw on circular references', () => {
		const input: Record<string, unknown> = { name: 'loop' };
		input.self = input;
		expect(() => sanitizeForLog(input)).not.toThrow();
		expect((sanitizeForLog(input) as Record<string, unknown>).self).toBe(
			'[redacted]',
		);
	});

	it('fails closed on throwing property getters', () => {
		const input: Record<string, unknown> = {};
		Object.defineProperty(input, 'boom', {
			enumerable: true,
			get() {
				throw new Error('getter exploded');
			},
		});
		const sanitized = sanitizeForLog(input) as Record<string, unknown>;
		expect(sanitized.boom).toBe('[redacted]');
	});

	it('keeps primitives and null/undefined intact', () => {
		expect(sanitizeForLog(null)).toBeNull();
		expect(sanitizeForLog(undefined)).toBeUndefined();
		expect(sanitizeForLog(502)).toBe(502);
		expect(sanitizeForLog(false)).toBe(false);
		expect(sanitizeForLog(42n)).toBe(42n);
	});

	it('serializes Date and URL through string masking', () => {
		const when = new Date('2026-07-31T12:00:00.000Z');
		expect(sanitizeForLog(when)).toBe('2026-07-31T12:00:00.000Z');
		expect(
			sanitizeForLog(new URL(`https://acme.atlassian.net/${JIRA_TOKEN}`)),
		).toBe('https://acme.atlassian.net/jira_api:[redacted]');
	});

	it('replaces unknown class instances with the marker', () => {
		class Widget {
			label = JIRA_TOKEN;
		}
		expect(sanitizeForLog(new Widget())).toBe('[redacted]');
	});
});

// ---------------------------------------------------------------------------
// Logger wrapper
// ---------------------------------------------------------------------------

describe('secureLogger', () => {
	it('emits sanitized arguments through console.error', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		secureLogger.error('decrypt failed', new Error(JIRA_TOKEN));
		expect(spy).toHaveBeenCalledTimes(1);
		const emitted = spy.mock.calls[0] as [unknown, unknown];
		expect(emitted[0]).toBe('decrypt failed');
		expect((emitted[1] as { message: string }).message).toBe(
			'jira_api:[redacted]',
		);
		expect(JSON.stringify(emitted)).not.toContain('ATATT');
	});

	it('wraps all five console levels', () => {
		const spies = {
			debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
			log: vi.spyOn(console, 'log').mockImplementation(() => {}),
			info: vi.spyOn(console, 'info').mockImplementation(() => {}),
			warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
			error: vi.spyOn(console, 'error').mockImplementation(() => {}),
		};
		for (const level of ['debug', 'log', 'info', 'warn', 'error'] as const) {
			secureLogger[level](AES_PAYLOAD);
			expect(spies[level]).toHaveBeenCalledWith('aes256gcm:[redacted]');
		}
	});

	it('sanitizes the JSON-stringified log shape used by the Jira proxy', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		secureLogger.log(
			JSON.stringify({
				ts: '2026-07-31T12:00:00.000Z',
				svc: 'hoursmith-jira-proxy',
				event: 'upstream_error',
				target_host: 'acme.atlassian.net',
				error: `decrypt failed: ${JIRA_TOKEN}`,
			}),
		);
		const emitted = spy.mock.calls[0]?.[0] as string;
		expect(emitted).not.toContain('ATATT');
		expect(emitted).toContain('jira_api:[redacted]');
		expect(emitted).toContain('"event":"upstream_error"');
	});
});
