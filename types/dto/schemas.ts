/**
 * Canonical Zod schemas for Hoursmith domain objects.
 *
 * Each schema documents the expected JSON shape of a domain object as it
 * arrives from an external source (Jira REST API, ICS feed, RescueTime,
 * localStorage-persisted config). The inferred TypeScript types should be
 * preferred over hand-written interfaces when the data crosses a runtime
 * boundary — the schema IS the source of truth for both validation and the
 * shape contract.
 *
 * Naming convention:
 *  - `<Name>Schema`          — the Zod schema
 *  - `<Name>Dto`             — inferred TypeScript type (named export)
 *  - `<Name>ArraySchema`     — array-of-<Name> wrapper for batch endpoints
 *
 * Bundle impact: zod is tree-shakeable; only schemas that are actually
 * imported will appear in the final bundle. Prefer importing individual
 * schemas over the barrel export when bundle size matters.
 */

import { z } from 'zod';

// ── Jira REST API shapes ─────────────────────────────────────────────

/**
 * A Jira user record as returned by `GET /rest/api/2/user` and embedded
 * inside worklog/issue payloads.
 *
 * JSON example:
 *   {
 *     "self":           "https://<site>.atlassian.net/rest/api/2/user?accountId=...",
 *     "accountId":      "5b10a2844c20165700ede21g",
 *     "emailAddress":   "ana@example.com",
 *     "displayName":    "Ana Silva",
 *     "active":         true
 *   }
 */
export const JiraUserSchema = z.object({
	self: z.string().url().optional(),
	accountId: z.string(),
	emailAddress: z.string().email().optional(),
	displayName: z.string().optional(),
	active: z.boolean().optional(),
}).passthrough();
export type JiraUserDto = z.infer<typeof JiraUserSchema>;

/**
 * A Jira issue as returned by `GET /rest/api/2/issue/<key>` and the search
 * endpoint. The `fields` bag is intentionally loose — Hoursmith only cares
 * about `summary` at parse time; the rest is pass-through.
 *
 * JSON example:
 *   {
 *     "id":     "10042",
 *     "self":   "https://<site>.atlassian.net/rest/api/2/issue/10042",
 *     "key":    "ABC-123",
 *     "fields": { "summary": "Fix login redirect" }
 *   }
 */
export const JiraIssueSchema = z.object({
	expand: z.string().optional(),
	id: z.string(),
	self: z.string().url().optional(),
	key: z.string().min(2),
	fields: z
		.object({
			summary: z.string().optional(),
		})
		.passthrough(),
});
export type JiraIssueDto = z.infer<typeof JiraIssueSchema>;

/**
 * A Jira worklog entry as returned by:
 *   `GET /rest/api/2/issue/<key>/worklog`
 *   `POST /rest/api/2/issue/<key>/worklog`
 *
 * The `comment` field is polymorphic in Jira — it can be a plain string or
 * a rich-content object. Both forms are accepted at the schema boundary;
 * consumers should use the `classifyWorklog` utility for backdate detection
 * instead of parsing the comment inline.
 *
 * JSON example (string comment):
 *   {
 *     "self":             "https://<site>.atlassian.net/rest/api/2/issue/10042/worklog/20001",
 *     "id":               "20001",
 *     "author":           { "displayName": "Ana Silva" },
 *     "comment":          "Original Worklog Date was: 2025/06/20",
 *     "created":          "2025-06-22T09:00:00.000+0000",
 *     "started":          "2025-06-20T09:00:00.000+0000",
 *     "timeSpent":        "2h",
 *     "timeSpentSeconds": 7200,
 *     "issueId":          "10042"
 *   }
 */
export const JiraWorklogSchema = z.object({
	self: z.string().url().optional(),
	id: z.string().optional(),
	author: JiraUserSchema.optional(),
	updateAuthor: JiraUserSchema.optional(),
	comment: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
	created: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{4}$/).optional(),
	updated: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{4}$/).optional(),
	started: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{4}$/).optional(),
	timeSpent: z.string().optional(),
	timeSpentSeconds: z.number(),
	issueId: z.string().optional(),
	issueKey: z.string().optional(),
}).passthrough();
export type JiraWorklogDto = z.infer<typeof JiraWorklogSchema>;

/** Array of worklogs, e.g. the `worklogs` field from `GET …/worklog` responses. */
export const JiraWorklogArraySchema = z.array(JiraWorklogSchema);

// ── Config / settings shapes ─────────────────────────────────────────

/**
 * A Jira site connection as persisted in localStorage by `useConfigStore`.
 *
 * JSON example:
 *   {
 *     "url":       "https://my-company.atlassian.net",
 *     "email":     "ana@example.com",
 *     "apiToken":  "ATATT3..."
 *   }
 */
export const JiraSiteSchema = z.object({
	url: z.string().url(),
	email: z.string().email(),
	apiToken: z.string().min(1),
}).passthrough();
export type JiraSiteDto = z.infer<typeof JiraSiteSchema>;

// ── Absence / calendar shapes ────────────────────────────────────────

/** Valid absence kinds stored in the DB and surfaced in the UI. */
export const AbsenceKindSchema = z.enum(['vacation', 'sick', 'off', 'holiday']);
export type AbsenceKindDto = z.infer<typeof AbsenceKindSchema>;

/**
 * A single user-absence record matching the `public.user_absences` row
 * shape (ADA-617).
 *
 * JSON example:
 *   {
 *     "id":           "abs_01abc…",
 *     "userId":       "usr_01def…",
 *     "providerId":   "prv_01ghi…",
 *     "absenceDate":  "2025-06-20",
 *     "kind":         "vacation",
 *     "reason":       "",
 *     "metadata":     {},
 *     "createdAt":    "2025-06-01T12:00:00.000Z",
 *     "updatedAt":    "2025-06-01T12:00:00.000Z"
 *   }
 */
export const UserAbsenceSchema = z.object({
	id: z.string().min(1),
	userId: z.string().min(1),
	providerId: z.string().nullable(),
	absenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
		(val) => {
			const d = new Date(val);
			return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(val);
		},
		{ message: 'Invalid calendar date' },
	),
	kind: AbsenceKindSchema,
	reason: z.string(),
	metadata: z.record(z.string(), z.unknown()),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
}).passthrough();
export type UserAbsenceDto = z.infer<typeof UserAbsenceSchema>;
