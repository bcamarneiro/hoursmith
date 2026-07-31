/**
 * Tests for the shared validation layer: result types, parseJson helper, and
 * canonical Zod schemas for domain objects.
 */
import { describe, expect, it } from 'vitest';

import { err, ok, parseJson, type ValidationResult } from '../result';

import {
	AbsenceKindSchema,
	JiraIssueSchema,
	JiraSiteSchema,
	JiraUserSchema,
	JiraWorklogArraySchema,
	JiraWorklogSchema,
	UserAbsenceSchema,
} from '../schemas';

// ── result helpers ──────────────────────────────────────────────────────

describe('ok / err / parseJson', () => {
	it('ok() wraps a value in { ok: true, value }', () => {
		expect(ok(42)).toEqual({ ok: true, value: 42 });
	});

	it('err() wraps a reason in { ok: false, reason }', () => {
		expect(err('bad_input')).toEqual({ ok: false, reason: 'bad_input' });
	});

	it('parseJson returns Ok for valid JSON', () => {
		const result = parseJson('{"a":1}');
		expect(result).toEqual({ ok: true, value: { a: 1 } });
	});

	it('parseJson returns Err for invalid JSON', () => {
		const result = parseJson('{broken:}');
		expect(result).toEqual({ ok: false, reason: 'bad_json' });
	});

	it('parseJson returns Err for empty string', () => {
		const result = parseJson('');
		expect(result).toEqual({ ok: false, reason: 'bad_json' });
	});

	it('discriminated union narrows correctly at runtime', () => {
		const r: ValidationResult<string> = ok('hello');
		if (r.ok) {
			// TypeScript narrows to Ok<string>
			expect(r.value).toBe('hello');
		} else {
			// Should not reach here
			expect.fail('expected ok');
		}
	});

	it('discriminated union narrows Err correctly', () => {
		const r: ValidationResult<string> = err('fail');
		if (!r.ok) {
			expect(r.reason).toBe('fail');
		} else {
			expect.fail('expected err');
		}
	});
});

// ── JiraUserSchema ──────────────────────────────────────────────────────

describe('JiraUserSchema', () => {
	const validUser = {
		self: 'https://site.atlassian.net/rest/api/2/user?accountId=abc',
		accountId: '5b10a2844c20165700ede21g',
		emailAddress: 'ana@example.com',
		displayName: 'Ana Silva',
		active: true,
	};

	it('parses a complete user', () => {
		expect(() => JiraUserSchema.parse(validUser)).not.toThrow();
	});

	it('parses an empty object (all fields optional)', () => {
		expect(() => JiraUserSchema.parse({})).not.toThrow();
	});

	it('rejects a non-email emailAddress', () => {
		expect(() =>
			JiraUserSchema.parse({ emailAddress: 'not-an-email' }),
		).toThrow();
	});

	it('rejects a non-URL self', () => {
		expect(() => JiraUserSchema.parse({ self: 'not-a-url' })).toThrow();
	});

	it('rejects a non-string accountId', () => {
		expect(() => JiraUserSchema.parse({ accountId: 123 })).toThrow();
	});
});

// ── JiraIssueSchema ─────────────────────────────────────────────────────

describe('JiraIssueSchema', () => {
	const validIssue = {
		id: '10042',
		self: 'https://site.atlassian.net/rest/api/2/issue/10042',
		key: 'ABC-123',
		fields: { summary: 'Fix login redirect' },
	};

	it('parses a valid issue', () => {
		expect(() => JiraIssueSchema.parse(validIssue)).not.toThrow();
	});

	it('parses an issue with extra unknown fields (passthrough)', () => {
		expect(() =>
			JiraIssueSchema.parse({
				...validIssue,
				fields: { summary: 'x', extra: 1 },
			}),
		).not.toThrow();
	});

	it('rejects if id is missing', () => {
		const { id: _, ...rest } = validIssue;
		expect(() => JiraIssueSchema.parse(rest)).toThrow();
	});

	it('rejects if key is too short (min 2)', () => {
		expect(() => JiraIssueSchema.parse({ ...validIssue, key: 'A' })).toThrow();
	});

	it('rejects non-string id', () => {
		expect(() => JiraIssueSchema.parse({ ...validIssue, id: 10042 })).toThrow();
	});
});

// ── JiraWorklogSchema / JiraWorklogArraySchema ──────────────────────────

describe('JiraWorklogSchema', () => {
	const validWorklog = {
		self: 'https://site.atlassian.net/rest/api/2/issue/10042/worklog/20001',
		id: '20001',
		author: { displayName: 'Ana Silva' },
		comment: 'Original Worklog Date was: 2025/06/20',
		created: '2025-06-22T09:00:00.000+0000',
		started: '2025-06-20T09:00:00.000+0000',
		timeSpent: '2h',
		timeSpentSeconds: 7200,
		issueId: '10042',
	};

	it('parses a valid worklog with string comment', () => {
		expect(() => JiraWorklogSchema.parse(validWorklog)).not.toThrow();
	});

	it('parses a worklog with object comment', () => {
		const wl = { ...validWorklog, comment: { type: 'doc', version: 1 } };
		expect(() => JiraWorklogSchema.parse(wl)).not.toThrow();
	});

	it('parses a minimal worklog (all fields optional)', () => {
		expect(() => JiraWorklogSchema.parse({})).not.toThrow();
	});

	it('rejects non-numeric timeSpentSeconds', () => {
		expect(() =>
			JiraWorklogSchema.parse({ timeSpentSeconds: '7200' }),
		).toThrow();
	});

	it('JiraWorklogArraySchema parses an array', () => {
		const parsed = JiraWorklogArraySchema.parse([validWorklog, {}]);
		expect(parsed).toHaveLength(2);
	});

	it('JiraWorklogArraySchema rejects non-array input', () => {
		expect(() => JiraWorklogArraySchema.parse({})).toThrow();
	});
});

// ── JiraSiteSchema ──────────────────────────────────────────────────────

describe('JiraSiteSchema', () => {
	const validSite = {
		url: 'https://my-company.atlassian.net',
		email: 'ana@example.com',
		apiToken: 'ATATT3...',
	};

	it('parses a valid site config', () => {
		expect(() => JiraSiteSchema.parse(validSite)).not.toThrow();
	});

	it('rejects a missing url', () => {
		const { url: _, ...rest } = validSite;
		expect(() => JiraSiteSchema.parse(rest)).toThrow();
	});

	it('rejects a non-URL url', () => {
		expect(() =>
			JiraSiteSchema.parse({ ...validSite, url: 'not-a-url' }),
		).toThrow();
	});

	it('rejects a non-email email', () => {
		expect(() =>
			JiraSiteSchema.parse({ ...validSite, email: 'bad' }),
		).toThrow();
	});

	it('rejects empty apiToken', () => {
		expect(() =>
			JiraSiteSchema.parse({ ...validSite, apiToken: '' }),
		).toThrow();
	});
});

// ── AbsenceKindSchema ───────────────────────────────────────────────────

describe('AbsenceKindSchema', () => {
	it('accepts valid absence kinds', () => {
		for (const kind of ['vacation', 'sick', 'off', 'holiday']) {
			expect(() => AbsenceKindSchema.parse(kind)).not.toThrow();
		}
	});

	it('rejects unknown kinds', () => {
		expect(() => AbsenceKindSchema.parse('bereavement')).toThrow();
		expect(() => AbsenceKindSchema.parse('')).toThrow();
	});
});

// ── UserAbsenceSchema ───────────────────────────────────────────────────

describe('UserAbsenceSchema', () => {
	const validAbsence = {
		id: 'abs_01abc',
		userId: 'usr_01def',
		providerId: null,
		absenceDate: '2025-06-20',
		kind: 'vacation',
		reason: '',
		metadata: {},
		createdAt: '2025-06-01T12:00:00.000Z',
		updatedAt: '2025-06-01T12:00:00.000Z',
	};

	it('parses a valid absence record', () => {
		expect(() => UserAbsenceSchema.parse(validAbsence)).not.toThrow();
	});

	it('allows null providerId', () => {
		expect(() =>
			UserAbsenceSchema.parse({ ...validAbsence, providerId: null }),
		).not.toThrow();
	});

	it('allows metadata with arbitrary keys', () => {
		expect(() =>
			UserAbsenceSchema.parse({
				...validAbsence,
				metadata: { source: 'ics', archived: true },
			}),
		).not.toThrow();
	});

	it('rejects a bad absenceDate format', () => {
		expect(() =>
			UserAbsenceSchema.parse({ ...validAbsence, absenceDate: '20/06/2025' }),
		).toThrow();
	});

	it('rejects an invalid kind', () => {
		expect(() =>
			UserAbsenceSchema.parse({ ...validAbsence, kind: 'unknown' }),
		).toThrow();
	});

	it('rejects empty id', () => {
		expect(() =>
			UserAbsenceSchema.parse({ ...validAbsence, id: '' }),
		).toThrow();
	});

	it('rejects empty userId', () => {
		expect(() =>
			UserAbsenceSchema.parse({ ...validAbsence, userId: '' }),
		).toThrow();
	});
});
