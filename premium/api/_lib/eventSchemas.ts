/**
 * Validated schemas for product events (ADA-721).
 *
 * Every event that enters the `events` queue is validated at the producer
 * boundary before enqueue: an event with an unknown type or a malformed
 * payload must never be produced, because a queue is a durable contract —
 * junk written today is replayed by every consumer forever. These validators
 * are deliberately dependency-free (matching the rest of the premium API:
 * `redisConfig`, `rateLimit`, `aesCrypto` all hand-roll their checks) and
 * return a list of human-readable errors so callers can fix the payload
 * without re-trying blind.
 *
 * Event names mirror the Polar domain the premium API already consumes
 * (`subscription.*` webhooks) so producers and consumers share vocabulary.
 */

// --- Types ---

/** Canonical event types the premium API can produce. */
export const EVENT_TYPES = {
	/** Polar `subscription.active` — a subscription became active. */
	SUBSCRIPTION_ACTIVE: 'billing.subscription_active',
	/** Polar `subscription.revoked` — a subscription was revoked. */
	SUBSCRIPTION_REVOKED: 'billing.subscription_revoked',
	/** Polar `subscription.updated` — status/period changed on an existing subscription. */
	SUBSCRIPTION_UPDATED: 'billing.subscription_updated',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/**
 * Payload of a billing subscription event. Field names are camelCase
 * versions of the Polar webhook fields the premium API already reads
 * (`customer_id`, `id`, `status`, `current_period_end`, `modified_at`).
 */
export interface SubscriptionEventPayload {
	/** Stripe customer id resolved from the Polar event. */
	customerId: string;
	/** Polar subscription id (`data.id` on the webhook). */
	subscriptionId: string;
	/** Normalised subscription status (`active`, `past_due`, `canceled`, ...). */
	status: string;
	/** ISO timestamp of the current period end, when known. */
	currentPeriodEnd?: string;
}

/** Union of every typed event payload the producer can publish. */
export type EventPayload = SubscriptionEventPayload;

/**
 * Envelope every product event must satisfy before it is produced.
 * `occurredAt` is optional at the call site; the producer defaults it to
 * `new Date().toISOString()` when it is omitted.
 */
export interface ProductEvent {
	type: EventType;
	/** ISO-8601 timestamp of when the event happened. */
	occurredAt?: string;
	payload: EventPayload;
}

/** Result of validating an event payload: errors are empty when valid. */
export interface EventSchema {
	type: EventType;
	validate(value: unknown): string[];
}

// --- Errors ---

/** Thrown when an event fails schema validation before enqueue. */
export class EventValidationError extends Error {
	/** One human-readable message per invalid field; empty when none. */
	readonly errors: string[];

	constructor(errors: string[], type?: string) {
		super(
			errors.length === 0
				? 'Invalid product event.'
				: `Invalid product event${type ? ` (${type})` : ''}: ${errors.join('; ')}`,
		);
		this.name = 'EventValidationError';
		this.errors = errors;
	}
}

// --- Validators ---

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		!Number.isNaN(Date.parse(value))
	);
}

function validateSubscriptionPayload(value: unknown): string[] {
	const errors: string[] = [];
	if (!isRecord(value)) {
		return ['payload must be an object'];
	}
	if (!isNonEmptyString(value.customerId)) {
		errors.push('payload.customerId must be a non-empty string');
	}
	if (!isNonEmptyString(value.subscriptionId)) {
		errors.push('payload.subscriptionId must be a non-empty string');
	}
	if (!isNonEmptyString(value.status)) {
		errors.push('payload.status must be a non-empty string');
	}
	const periodEnd = value.currentPeriodEnd;
	if (
		periodEnd !== undefined &&
		periodEnd !== null &&
		!isIsoTimestamp(periodEnd)
	) {
		errors.push(
			'payload.currentPeriodEnd must be an ISO timestamp when present',
		);
	}
	return errors;
}

/** Registry of every event type the producer accepts, keyed by type. */
export const EVENT_SCHEMAS: Record<EventType, EventSchema> = {
	[EVENT_TYPES.SUBSCRIPTION_ACTIVE]: {
		type: EVENT_TYPES.SUBSCRIPTION_ACTIVE,
		validate: validateSubscriptionPayload,
	},
	[EVENT_TYPES.SUBSCRIPTION_REVOKED]: {
		type: EVENT_TYPES.SUBSCRIPTION_REVOKED,
		validate: validateSubscriptionPayload,
	},
	[EVENT_TYPES.SUBSCRIPTION_UPDATED]: {
		type: EVENT_TYPES.SUBSCRIPTION_UPDATED,
		validate: validateSubscriptionPayload,
	},
};

/**
 * Validate an unknown value against the event registry and return a
 * normalized `ProductEvent` (with `occurredAt` defaulted to now).
 *
 * Throws `EventValidationError` listing every problem when the value is not
 * a valid event; a valid event never triggers a network call here.
 */
export function validateProductEvent(value: unknown): ProductEvent {
	const errors: string[] = [];
	if (!isRecord(value)) {
		throw new EventValidationError(['event must be an object']);
	}
	const type = value.type;
	if (typeof type !== 'string' || !(type in EVENT_SCHEMAS)) {
		errors.push(`type must be one of ${Object.values(EVENT_TYPES).join(', ')}`);
	}
	const occurredAt = value.occurredAt;
	if (occurredAt !== undefined && !isIsoTimestamp(occurredAt)) {
		errors.push('occurredAt must be an ISO timestamp when present');
	}
	const schema =
		typeof type === 'string' ? EVENT_SCHEMAS[type as EventType] : undefined;
	if (schema) {
		errors.push(...schema.validate(value.payload));
	}
	if (errors.length > 0) {
		throw new EventValidationError(
			errors,
			typeof type === 'string' ? type : undefined,
		);
	}
	return {
		type: type as EventType,
		occurredAt: (occurredAt as string | undefined) ?? new Date().toISOString(),
		payload: value.payload as EventPayload,
	};
}
