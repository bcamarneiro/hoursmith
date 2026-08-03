import { describe, expect, it } from 'vitest';
import {
	asEntitlementCode,
	classifyHttpStatus,
	describeServiceError,
	fromHttpResponse,
	fromHttpResponseAsync,
	fromNetworkError,
	fromRichMessage,
	isServiceError,
	normalizeError,
	ServiceError,
	type EntitlementCode,
	validateServiceError,
} from '../serviceErrors';

describe('classifyHttpStatus', () => {
	it('maps known statuses to the canonical kind', () => {
		expect(classifyHttpStatus(401)).toBe('unauthorized');
		expect(classifyHttpStatus(403)).toBe('forbidden');
		expect(classifyHttpStatus(404)).toBe('not-found');
		expect(classifyHttpStatus(429)).toBe('rate-limited');
		expect(classifyHttpStatus(500)).toBe('server-error');
		expect(classifyHttpStatus(502)).toBe('server-error');
	});

	it('returns "unknown" for unrecognised statuses', () => {
		expect(classifyHttpStatus(418)).toBe('unknown');
		expect(classifyHttpStatus(0)).toBe('unknown');
	});
});

describe('fromHttpResponse', () => {
	it('wraps a status in a ServiceError with kind/status/source', () => {
		const err = fromHttpResponse('Jira search', 401);
		expect(err).toBeInstanceOf(ServiceError);
		expect(err.kind).toBe('unauthorized');
		expect(err.status).toBe(401);
		expect(err.source).toBe('Jira search');
		expect(err.message).toContain('Jira search');
		expect(err.message).toContain('HTTP 401');
	});

	it('appends optional context when supplied', () => {
		const err = fromHttpResponse('Calendar feed', 503, 'host=cal.example.com');
		expect(err.message).toContain('host=cal.example.com');
	});
});

describe('fromRichMessage', () => {
	it('derives kind from status and preserves the message verbatim', () => {
		const err = fromRichMessage('GitLab', 401, 'Token expired — sign in again');
		expect(err).toBeInstanceOf(ServiceError);
		expect(err.kind).toBe('unauthorized');
		expect(err.status).toBe(401);
		expect(err.source).toBe('GitLab');
		expect(err.message).toBe('Token expired — sign in again');
	});

	it('falls back to "unknown" kind when status is missing', () => {
		const err = fromRichMessage('GitLab', undefined, 'TLS handshake failed');
		expect(err.kind).toBe('unknown');
		expect(err.status).toBeUndefined();
		expect(err.message).toBe('TLS handshake failed');
	});
});

describe('fromNetworkError', () => {
	it('wraps a thrown Error with the source label', () => {
		const err = fromNetworkError('GitLab', new Error('TLS handshake failed'));
		expect(err.kind).toBe('network');
		expect(err.message).toContain('GitLab');
		expect(err.message).toContain('TLS handshake failed');
	});

	it('coerces non-Error inputs to a string', () => {
		const err = fromNetworkError('Anywhere', 'plain string');
		expect(err.message).toContain('plain string');
	});
});

describe('asEntitlementCode', () => {
	it('accepts known entitlement codes', () => {
		expect(asEntitlementCode('invalid_token')).toBe('invalid_token');
		expect(asEntitlementCode('subscription_required')).toBe(
			'subscription_required',
		);
	});

	it('rejects unknown / non-string values', () => {
		expect(asEntitlementCode('nope')).toBeUndefined();
		expect(asEntitlementCode(401)).toBeUndefined();
		expect(asEntitlementCode(undefined)).toBeUndefined();
	});
});

describe('fromHttpResponseAsync', () => {
	it('captures the entitlement code from a hosted-proxy 401 body', async () => {
		const res = {
			status: 401,
			clone: () => ({ json: async () => ({ error: 'invalid_token' }) }),
		};
		const err = await fromHttpResponseAsync('Jira search', res);
		expect(err.status).toBe(401);
		expect(err.entitlementCode).toBe('invalid_token');
	});

	it('captures subscription_required from a 403 body', async () => {
		const res = {
			status: 403,
			clone: () => ({ json: async () => ({ error: 'subscription_required' }) }),
		};
		const err = await fromHttpResponseAsync('Jira search', res);
		expect(err.entitlementCode).toBe('subscription_required');
	});

	it('leaves entitlementCode undefined for a genuine Jira 401 (no code body)', async () => {
		const res = {
			status: 401,
			clone: () => ({
				json: async () => {
					throw new Error('not json');
				},
			}),
		};
		const err = await fromHttpResponseAsync('Jira search', res);
		expect(err.status).toBe(401);
		expect(err.entitlementCode).toBeUndefined();
	});

	it('does not read the body for non-401/403 statuses', async () => {
		let called = false;
		const res = {
			status: 500,
			clone: () => ({
				json: async () => {
					called = true;
					return {};
				},
			}),
		};
		const err = await fromHttpResponseAsync('Jira search', res);
		expect(called).toBe(false);
		expect(err.kind).toBe('server-error');
	});
});

describe('describeServiceError', () => {
	it('maps an expired Hoursmith session (entitlement 401) to "sign in again"', () => {
		const err = fromHttpResponse('Jira search', 401, '', 'invalid_token');
		const copy = describeServiceError(err);
		expect(copy.message).toMatch(/session expired/i);
		expect(copy.message).toMatch(/sign in again/i);
		expect(copy.action?.kind).toBe('sign-in');
		expect(copy.action?.to).toBe('/auth/sign-in');
		// Crucially NOT the Jira-token message.
		expect(copy.message).not.toMatch(/api token/i);
	});

	it('maps a genuine Jira 401 (no entitlement code) to "check your Jira token"', () => {
		const err = fromHttpResponse('Jira search', 401);
		const copy = describeServiceError(err);
		expect(copy.message).toMatch(/api token/i);
		expect(copy.action?.kind).toBe('settings');
		expect(copy.message).not.toMatch(/sign in again/i);
	});

	it('maps subscription_required to a renew/sign-in message', () => {
		const err = fromHttpResponse(
			'Jira search',
			403,
			'',
			'subscription_required',
		);
		const copy = describeServiceError(err);
		expect(copy.message).toMatch(/subscription/i);
		expect(copy.action?.kind).toBe('sign-in');
	});

	it('maps 403 (no code) to a permissions message', () => {
		const copy = describeServiceError(fromHttpResponse('Jira search', 403));
		expect(copy.message).toMatch(/permission/i);
	});

	it('maps 404 to a host message', () => {
		const copy = describeServiceError(fromHttpResponse('Jira search', 404));
		expect(copy.message).toMatch(/host/i);
	});

	it('maps 429 / 5xx to a transient "please retry" message', () => {
		expect(describeServiceError(fromHttpResponse('x', 429)).message).toMatch(
			/retry/i,
		);
		expect(describeServiceError(fromHttpResponse('x', 503)).message).toMatch(
			/retry/i,
		);
	});

	it('maps a CORS / Failed to fetch TypeError to the CORS-proxy hint', () => {
		const copy = describeServiceError(new TypeError('Failed to fetch'));
		expect(copy.message).toMatch(/cors/i);
		expect(copy.action?.kind).toBe('settings');
	});

	it('falls back on a legacy "401" string error', () => {
		const copy = describeServiceError(new Error('Jira API error: 401'));
		expect(copy.message).toMatch(/api token/i);
	});
});

describe('isServiceError', () => {
	it('returns true for a valid ServiceError', () => {
		const err = fromHttpResponse('Jira', 401);
		expect(isServiceError(err)).toBe(true);
	});

	it('returns false for a plain Error', () => {
		expect(isServiceError(new Error('plain'))).toBe(false);
	});

	it('returns false for a string', () => {
		expect(isServiceError('error')).toBe(false);
	});

	it('returns false for null/undefined', () => {
		expect(isServiceError(null)).toBe(false);
		expect(isServiceError(undefined)).toBe(false);
	});
});

describe('validateServiceError', () => {
	it('returns empty array for a valid ServiceError', () => {
		const err = fromHttpResponse('Jira', 401);
		expect(validateServiceError(err)).toEqual([]);
	});

	it('returns empty array for a ServiceError with entitlementCode', () => {
		const err = fromHttpResponse('Jira', 401, '', 'invalid_token');
		expect(validateServiceError(err)).toEqual([]);
	});

	it('detects invalid kind', () => {
		const err = new ServiceError({
			kind: 'invalid' as unknown as ServiceError['kind'],
			source: 'Test',
			message: 'test',
		});
		const errors = validateServiceError(err);
		expect(errors.some((e) => e.field === 'kind')).toBe(true);
	});

	it('detects invalid status type', () => {
		const err = new ServiceError({
			kind: 'unknown',
			status: 'not-a-number' as unknown as number,
			source: 'Test',
			message: 'test',
		});
		const errors = validateServiceError(err);
		expect(errors.some((e) => e.field === 'status')).toBe(true);
	});

	it('detects invalid entitlementCode', () => {
		const err = new ServiceError({
			kind: 'unknown',
			source: 'Test',
			message: 'test',
			entitlementCode: 'bogus' as unknown as EntitlementCode,
		});
		const errors = validateServiceError(err);
		expect(errors.some((e) => e.field === 'entitlementCode')).toBe(true);
	});
});

describe('normalizeError', () => {
	it('returns ServiceError as-is', () => {
		const err = fromHttpResponse('Jira', 401);
		expect(normalizeError('Jira', err)).toBe(err);
	});

	it('wraps a plain Error as a network error', () => {
		const err = new Error('network failed');
		const normalized = normalizeError('Jira', err);
		expect(normalized.kind).toBe('network');
		expect(normalized.source).toBe('Jira');
	});

	it('wraps a string as an unknown error', () => {
		const normalized = normalizeError('Jira', 'something went wrong');
		expect(normalized.kind).toBe('unknown');
		expect(normalized.message).toBe('something went wrong');
	});

	it('maps an object with status to a ServiceError', () => {
		const normalized = normalizeError('Jira', { status: 403, message: 'forbidden' });
		expect(normalized.kind).toBe('forbidden');
		expect(normalized.status).toBe(403);
		expect(normalized.source).toBe('Jira');
	});

	it('handles object with status but no message', () => {
		const normalized = normalizeError('Calendar', { status: 500 });
		expect(normalized.kind).toBe('server-error');
		expect(normalized.status).toBe(500);
		expect(normalized.message).toContain('Calendar error (HTTP 500)');
	});

	it('handles unknown error types', () => {
		const normalized = normalizeError('Test', { foo: 'bar' });
		expect(normalized.kind).toBe('unknown');
		expect(normalized.source).toBe('Test');
		expect(normalized.message).toContain('Unknown error');
	});
});
