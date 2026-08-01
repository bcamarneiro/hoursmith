/**
 * Tests for the shared request transformer (ADA-754 / ADA-756).
 *
 * Covers: body parsing, type validation, cast coercion (with failure
 * detection), query-param handling, error shapes, and edge cases.
 */

import { describe, expect, it } from 'vitest';
import { transformRequest } from '../requestTransformer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function post(body: unknown, ct = 'application/json'): Request {
	return new Request('https://hoursmith.io/api/test', {
		method: 'POST',
		headers: { 'content-type': ct },
		body: JSON.stringify(body),
	});
}

function get(url = 'https://hoursmith.io/api/test'): Request {
	return new Request(url, { method: 'GET' });
}

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

describe('transformRequest — body validation', () => {
	it('accepts a valid body matching the schema', async () => {
		const r = await transformRequest(post({ tier: 'hosted' }), {
			body: { tier: { type: 'string', required: true } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body).toEqual({ tier: 'hosted' });
	});

	it('rejects a missing required string field', async () => {
		const r = await transformRequest(post({}), {
			body: { tier: { type: 'string', required: true } },
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.status).toBe(400);
		expect(r.error).toBe('validation_failed');
		expect(r.details).toEqual([{ field: 'tier', reason: 'required' }]);
	});

	it('rejects when required field is null', async () => {
		const r = await transformRequest(post({ tier: null }), {
			body: { tier: { type: 'string', required: true } },
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.details).toEqual([{ field: 'tier', reason: 'required' }]);
	});

	it('rejects a wrong-typed field (string expected, number given)', async () => {
		const r = await transformRequest(post({ tier: 123 }), {
			body: { tier: { type: 'string', required: true } },
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.details).toEqual([
			{ field: 'tier', reason: 'expected_string' },
		]);
	});

	it('validates number fields', async () => {
		const r = await transformRequest(post({ limit: 50 }), {
			body: { limit: { type: 'number', required: true } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body).toEqual({ limit: 50 });
	});

	it('validates boolean fields', async () => {
		const r = await transformRequest(post({ active: true }), {
			body: { active: { type: 'boolean', required: true } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body).toEqual({ active: true });
	});

	it('allows optional fields to be absent', async () => {
		const r = await transformRequest(post({ name: 'test' }), {
			body: {
				name: { type: 'string', required: true },
				note: { type: 'string' },
			},
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body).toEqual({ name: 'test' });
	});

	it('reports multiple errors at once', async () => {
		const r = await transformRequest(post({}), {
			body: {
				a: { type: 'string', required: true },
				b: { type: 'number', required: true },
			},
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.details).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Cast coercion
// ---------------------------------------------------------------------------

describe('transformRequest — cast coercion', () => {
	it('casts string to number when cast=true', async () => {
		const r = await transformRequest(post({ limit: '50' }), {
			body: { limit: { type: 'number', cast: true, required: true } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body?.limit).toBe(50);
		expect(typeof r.body?.limit).toBe('number');
	});

	it('casts string to boolean when cast=true', async () => {
		const r = await transformRequest(post({ active: 'true' }), {
			body: { active: { type: 'boolean', cast: true, required: true } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body?.active).toBe(true);
	});

	it('casts "1" to boolean true', async () => {
		const r = await transformRequest(post({ active: '1' }), {
			body: { active: { type: 'boolean', cast: true, required: true } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body?.active).toBe(true);
	});

	it('casts all other strings to boolean false', async () => {
		const r = await transformRequest(post({ active: 'no' }), {
			body: { active: { type: 'boolean', cast: true, required: true } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body?.active).toBe(false);
	});

	it('rejects cast failure: non-numeric string to number', async () => {
		const r = await transformRequest(post({ limit: 'abc' }), {
			body: { limit: { type: 'number', cast: true, required: true } },
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.details).toEqual([
			{ field: 'limit', reason: 'expected_number' },
		]);
	});

	it('does not cast when cast is false/absent', async () => {
		const r = await transformRequest(post({ limit: '50' }), {
			body: { limit: { type: 'number', required: true } },
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.details).toEqual([
			{ field: 'limit', reason: 'expected_number' },
		]);
	});
});

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

describe('transformRequest — query params', () => {
	it('parses query params', async () => {
		const r = await transformRequest(
			get('https://hoursmith.io/api/test?limit=10&page=2'),
			{ query: { limit: { type: 'number', cast: true } } },
		);
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.query.limit).toBe(10);
	});

	it('rejects missing required query param', async () => {
		const r = await transformRequest(get(), {
			query: { token: { type: 'string', required: true } },
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.error).toBe('missing_query_param');
	});

	it('rejects cast failure in query params', async () => {
		const r = await transformRequest(
			new Request('https://hoursmith.io/api/test?limit=abc'),
			{ query: { limit: { type: 'number', cast: true } } },
		);
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.error).toBe('invalid_query_param');
	});

	it('returns empty query when no schema', async () => {
		const r = await transformRequest(get());
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.query).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('transformRequest — edge cases', () => {
	it('returns null body when no schema is provided', async () => {
		const r = await transformRequest(post({ tier: 'hosted' }));
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body).toBeNull();
	});

	it('returns null body when schema has no body key', async () => {
		const r = await transformRequest(post({ tier: 'hosted' }), {
			query: { limit: { type: 'number', cast: true } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body).toBeNull();
	});

	it('returns null body for GET requests (even with body schema)', async () => {
		const r = await transformRequest(get(), {
			body: { tier: { type: 'string', required: true } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body).toBeNull();
	});

	it('rejects non-JSON content type', async () => {
		const r = await transformRequest(
			new Request('https://hoursmith.io/api/test', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: 'hello',
			}),
			{ body: { x: { type: 'string', required: true } } },
		);
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.status).toBe(415);
		expect(r.error).toBe('unsupported_content_type');
	});

	it('rejects invalid JSON', async () => {
		const r = await transformRequest(
			new Request('https://hoursmith.io/api/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: 'not json',
			}),
			{ body: { x: { type: 'string', required: true } } },
		);
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.status).toBe(400);
		expect(r.error).toBe('invalid_json');
	});

	it('rejects arrays as body (must be object)', async () => {
		const r = await transformRequest(post(['a', 'b']), {
			body: { tier: { type: 'string', required: true } },
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.error).toBe('invalid_body_type');
	});

	it('rejects a fully absent body when required fields exist', async () => {
		const r = await transformRequest(
			new Request('https://hoursmith.io/api/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
			}),
			{ body: { tier: { type: 'string', required: true } } },
		);
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected error');
		expect(r.error).toBe('validation_failed');
		expect(r.details).toEqual([
			{ field: 'tier', reason: 'required' },
		]);
	});

	it('returns ok for null body with no required fields', async () => {
		const r = await transformRequest(
			new Request('https://hoursmith.io/api/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: 'null',
			}),
			{ body: { note: { type: 'string' } } },
		);
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('expected ok');
		expect(r.body).toBeNull();
	});
});
