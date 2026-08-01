/**
 * Event schema definitions — Zod validation for event payloads (ADA-719).
 *
 * Every event that flows through the Hoursmith event pipeline (audit log,
 * Polar webhook, billing idempotency guard) gets a Zod schema so invalid or
 * unexpected payloads are caught at the boundary instead of surfacing as
 * silent corruption downstream.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Audit log events
// ---------------------------------------------------------------------------

/** Known audit event types. */
export const AUDIT_EVENT_TYPES = ['account_deleted', 'data_exported'] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** Shape validated before writing to `public.audit_log`. */
export const auditLogEventSchema = z.object({
	event_type: z.enum(AUDIT_EVENT_TYPES),
	stripe_customer_id: z.string().nullable(),
	metadata: z.record(z.string(), z.unknown()).optional().default({}),
});
export type AuditLogEvent = z.infer<typeof auditLogEventSchema>;

// ---------------------------------------------------------------------------
// Polar subscription lifecycle events
// ---------------------------------------------------------------------------

/** Known Polar subscription event types (matches subscriptionLifecycle.ts). */
export const POLAR_EVENT_TYPES = [
	'subscription.created',
	'subscription.updated',
	'subscription.active',
	'subscription.canceled',
	'subscription.revoked',
] as const;
export type PolarEventType = (typeof POLAR_EVENT_TYPES)[number];

/** Known Polar subscription status values (matches subscriptionLifecycle.ts POLAR_STATUS_MAP keys). */
export const POLAR_STATUS_KEYS = [
	'active',
	'past_due',
	'canceled',
	'incomplete',
	'trialing',
	'unpaid',
	'incomplete_expired',
] as const;
export type PolarStatusKey = (typeof POLAR_STATUS_KEYS)[number];

/** The slice of the Polar subscription payload we depend on. */
export const polarSubscriptionDataSchema = z.object({
	id: z.string(),
	status: z.enum(POLAR_STATUS_KEYS),
	product_id: z.string().nullable().optional(),
	current_period_end: z.string().nullable().optional(),
	modified_at: z.string().nullable().optional(),
	customer_id: z.string().optional(),
	customer: z
		.object({ external_id: z.string().nullable().optional() })
		.nullable()
		.optional(),
	metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type PolarSubscriptionData = z.infer<typeof polarSubscriptionDataSchema>;

/** Full Polar webhook event payload (type + data). */
export const polarEventSchema = z.object({
	type: z.enum(POLAR_EVENT_TYPES),
	data: polarSubscriptionDataSchema,
});
export type PolarEvent = z.infer<typeof polarEventSchema>;

// ---------------------------------------------------------------------------
// Billing idempotency guard
// ---------------------------------------------------------------------------

/** Idempotency guard payload — a single event_id written to billing_event_log. */
export const billingEventIdSchema = z.object({
	event_id: z.string().min(1),
});
export type BillingEventId = z.infer<typeof billingEventIdSchema>;

// ---------------------------------------------------------------------------
// Webhook log fields (structured console logging)
// ---------------------------------------------------------------------------

/** Outcome discriminated union for Polar webhook logging. */
export const WEBHOOK_OUTCOMES = [
	'ok',
	'ignored_unknown_event',
	'ignored_stale_event',
	'ignored_duplicate_event',
	'ignored_wrong_environment',
	'ignored_unknown_product',
	'missing_signature',
	'invalid_signature',
	'invalid_payload',
	'server_misconfigured',
	'missing_user_id',
	'upsert_failed',
] as const;
export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number];

/** Structured log entry emitted by the Polar webhook handler. */
export const webhookLogFieldsSchema = z.object({
	eventType: z.string().nullable(),
	userId: z.string().nullable(),
	outcome: z.enum(WEBHOOK_OUTCOMES),
	status: z.number().int().min(100).max(599),
	resultingStatus: z.string().optional(),
	resultingTier: z.string().optional(),
	note: z.string().optional(),
});
export type WebhookLogFields = z.infer<typeof webhookLogFieldsSchema>;
