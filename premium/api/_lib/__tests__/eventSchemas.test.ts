import { describe, expect, it } from 'vitest';
import {
	auditLogEventSchema,
	billingEventIdSchema,
	polarEventSchema,
	polarSubscriptionDataSchema,
	webhookLogFieldsSchema,
} from '../eventSchemas.js';

// ---------------------------------------------------------------------------
// auditLogEventSchema
// ---------------------------------------------------------------------------

describe('auditLogEventSchema', () => {
	it('accepts a valid account_deleted event', () => {
		const result = auditLogEventSchema.safeParse({
			event_type: 'account_deleted',
			stripe_customer_id: 'cus_abc123',
		});
		expect(result.success).toBe(true);
	});

	it('accepts a valid data_exported event', () => {
		const result = auditLogEventSchema.safeParse({
			event_type: 'data_exported',
			stripe_customer_id: 'cus_def456',
			metadata: { format: 'json' },
		});
		expect(result.success).toBe(true);
	});

	it('rejects non-object metadata', () => {
		const result = auditLogEventSchema.safeParse({
			event_type: 'data_exported',
			stripe_customer_id: 'cus_abc123',
			metadata: ['not-an-object'],
		});
		expect(result.success).toBe(false);
	});

	it('accepts null stripe_customer_id', () => {
		const result = auditLogEventSchema.safeParse({
			event_type: 'data_exported',
			stripe_customer_id: null,
		});
		expect(result.success).toBe(true);
	});

	it('defaults metadata to empty object when omitted', () => {
		const result = auditLogEventSchema.safeParse({
			event_type: 'account_deleted',
			stripe_customer_id: 'cus_abc123',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.metadata).toEqual({});
		}
	});

	it('rejects an unknown event_type', () => {
		const result = auditLogEventSchema.safeParse({
			event_type: 'bogus_event',
			stripe_customer_id: 'cus_abc123',
		});
		expect(result.success).toBe(false);
	});

	it('rejects missing event_type', () => {
		const result = auditLogEventSchema.safeParse({
			stripe_customer_id: 'cus_abc123',
		});
		expect(result.success).toBe(false);
	});

	it('rejects missing stripe_customer_id', () => {
		const result = auditLogEventSchema.safeParse({
			event_type: 'data_exported',
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// polarSubscriptionDataSchema
// ---------------------------------------------------------------------------

describe('polarSubscriptionDataSchema', () => {
	it('accepts a minimal valid subscription data payload', () => {
		const result = polarSubscriptionDataSchema.safeParse({
			id: 'sub_001',
			status: 'active',
		});
		expect(result.success).toBe(true);
	});

	it('accepts a full subscription data payload', () => {
		const result = polarSubscriptionDataSchema.safeParse({
			id: 'sub_002',
			status: 'active',
			product_id: 'prod_xyz',
			current_period_end: '2026-12-31T23:59:59Z',
			modified_at: '2026-08-01T00:00:00Z',
			customer_id: 'cus_abc123',
			customer: { external_id: 'user_001' },
			metadata: { plan: 'annual' },
		});
		expect(result.success).toBe(true);
	});

	it('rejects missing id', () => {
		const result = polarSubscriptionDataSchema.safeParse({
			status: 'active',
		});
		expect(result.success).toBe(false);
	});

	it('rejects missing status', () => {
		const result = polarSubscriptionDataSchema.safeParse({
			id: 'sub_001',
		});
		expect(result.success).toBe(false);
	});

	it('rejects non-string id', () => {
		const result = polarSubscriptionDataSchema.safeParse({
			id: 123,
			status: 'active',
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// polarEventSchema
// ---------------------------------------------------------------------------

describe('polarEventSchema', () => {
	it('accepts a valid subscription.created event', () => {
		const result = polarEventSchema.safeParse({
			type: 'subscription.created',
			data: { id: 'sub_001', status: 'active' },
		});
		expect(result.success).toBe(true);
	});

	it('accepts a subscription.revoked event', () => {
		const result = polarEventSchema.safeParse({
			type: 'subscription.revoked',
			data: {
				id: 'sub_002',
				status: 'canceled',
				current_period_end: null,
			},
		});
		expect(result.success).toBe(true);
	});

	it('rejects an unknown event type', () => {
		const result = polarEventSchema.safeParse({
			type: 'subscription.unknown',
			data: { id: 'sub_001', status: 'active' },
		});
		expect(result.success).toBe(false);
	});

	it('rejects missing data', () => {
		const result = polarEventSchema.safeParse({
			type: 'subscription.created',
		});
		expect(result.success).toBe(false);
	});

	it('rejects missing type', () => {
		const result = polarEventSchema.safeParse({
			data: { id: 'sub_001', status: 'active' },
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// billingEventIdSchema
// ---------------------------------------------------------------------------

describe('billingEventIdSchema', () => {
	it('accepts a valid event_id', () => {
		const result = billingEventIdSchema.safeParse({
			event_id: 'evt_abc123',
		});
		expect(result.success).toBe(true);
	});

	it('rejects an empty event_id', () => {
		const result = billingEventIdSchema.safeParse({
			event_id: '',
		});
		expect(result.success).toBe(false);
	});

	it('rejects missing event_id', () => {
		const result = billingEventIdSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	it('rejects non-string event_id', () => {
		const result = billingEventIdSchema.safeParse({
			event_id: 12345,
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// webhookLogFieldsSchema
// ---------------------------------------------------------------------------

describe('webhookLogFieldsSchema', () => {
	it('accepts a valid ok outcome', () => {
		const result = webhookLogFieldsSchema.safeParse({
			eventType: 'subscription.created',
			userId: 'user_001',
			outcome: 'ok',
			status: 200,
		});
		expect(result.success).toBe(true);
	});

	it('accepts null eventType and userId', () => {
		const result = webhookLogFieldsSchema.safeParse({
			eventType: null,
			userId: null,
			outcome: 'ignored_unknown_event',
			status: 200,
		});
		expect(result.success).toBe(true);
	});

	it('rejects an unknown outcome', () => {
		const result = webhookLogFieldsSchema.safeParse({
			eventType: 'subscription.created',
			userId: 'user_001',
			outcome: 'bogus_outcome',
			status: 200,
		});
		expect(result.success).toBe(false);
	});

	it('rejects status below 100', () => {
		const result = webhookLogFieldsSchema.safeParse({
			eventType: null,
			userId: null,
			outcome: 'ok',
			status: 99,
		});
		expect(result.success).toBe(false);
	});

	it('rejects status above 599', () => {
		const result = webhookLogFieldsSchema.safeParse({
			eventType: null,
			userId: null,
			outcome: 'ok',
			status: 600,
		});
		expect(result.success).toBe(false);
	});

	it('rejects missing status', () => {
		const result = webhookLogFieldsSchema.safeParse({
			eventType: null,
			userId: null,
			outcome: 'ok',
		});
		expect(result.success).toBe(false);
	});
});
