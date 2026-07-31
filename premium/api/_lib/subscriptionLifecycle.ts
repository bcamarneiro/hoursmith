/**
 * Subscription lifecycle state machine core (ADA-740).
 *
 * Dependency-free definition of the states a Hoursmith Premium subscription
 * can occupy, the Polar lifecycle events that drive it, and the guards that
 * decide which (event, status) pairs may be written to the
 * `public.subscriptions` table.
 *
 * The table is persistence, not policy: rows are written only by the Polar
 * webhook (upserts) and the checkout flow (initial `incomplete` row). This
 * module is the single place that maps a Polar lifecycle event to the row
 * shape the DB CHECK constraints accept, so the webhook, the entitlement
 * check and the admin client all read the same enums.
 *
 * Invariants (ADA-294, hardened ADA-455):
 * - A subscription canceled at period end (`subscription.canceled`) keeps
 *   `premium` access until the period elapses; Polar then fires
 *   `subscription.revoked`, and ONLY that event downgrades the user to free.
 * - Polar statuses are clamped onto the DB CHECK set. Anything unrecognised
 *   fails closed to `incomplete` (never a silent grant).
 * - `incomplete_expired` is the terminal state of an abandoned checkout:
 *   mapped to `canceled`.
 *
 * Linear: ADA-740.
 */

export const SUBSCRIPTION_TIERS = ['free', 'premium'] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

/** Statuses the `subscriptions_status_check` CHECK constraint accepts. */
export const SUBSCRIPTION_STATUSES = [
	'active',
	'past_due',
	'canceled',
	'incomplete',
	'trialing',
	'unpaid',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** A persisted row's state: tier + status. */
export interface SubscriptionState {
	tier: SubscriptionTier;
	status: SubscriptionStatus;
}

/** Polar webhook event types that drive the subscription lifecycle. */
export const POLAR_SUBSCRIPTION_EVENTS = [
	'subscription.created',
	'subscription.updated',
	'subscription.active',
	'subscription.canceled',
	'subscription.revoked',
] as const;
export type PolarSubscriptionEvent = (typeof POLAR_SUBSCRIPTION_EVENTS)[number];

/** Polar status values and the DB status they clamp onto. */
export const POLAR_STATUS_MAP: Record<string, SubscriptionStatus> = {
	active: 'active',
	past_due: 'past_due',
	canceled: 'canceled',
	incomplete: 'incomplete',
	trialing: 'trialing',
	unpaid: 'unpaid',
	incomplete_expired: 'canceled',
};

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

export function isSubscriptionTier(value: unknown): value is SubscriptionTier {
	return (
		typeof value === 'string' &&
		(SUBSCRIPTION_TIERS as readonly string[]).includes(value)
	);
}

export function isSubscriptionStatus(
	value: unknown,
): value is SubscriptionStatus {
	return (
		typeof value === 'string' &&
		(SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
	);
}

export function isSubscriptionState(
	value: unknown,
): value is SubscriptionState {
	if (typeof value !== 'object' || value === null) return false;
	const state = value as Record<string, unknown>;
	return isSubscriptionTier(state.tier) && isSubscriptionStatus(state.status);
}

export function isPolarSubscriptionEvent(
	value: string,
): value is PolarSubscriptionEvent {
	return (POLAR_SUBSCRIPTION_EVENTS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Transition rules                                                    */
/* ------------------------------------------------------------------ */

/** Terminal outcome of `subscription.revoked`: access ends, downgrade. */
const REVOKED_STATE: SubscriptionState = { tier: 'free', status: 'canceled' };

function grantPremium(polarStatus: string): SubscriptionState {
	return { tier: 'premium', status: normaliseStatus(polarStatus) };
}

/**
 * Transition rules: Polar event type → resulting state. Every grant event
 * keeps premium access (status clamped by {@link normaliseStatus}); only
 * `revoked` downgrades to free.
 */
export const LIFECYCLE_TRANSITIONS: Record<
	PolarSubscriptionEvent,
	(polarStatus: string) => SubscriptionState
> = {
	'subscription.created': grantPremium,
	'subscription.updated': grantPremium,
	'subscription.active': grantPremium,
	'subscription.canceled': grantPremium,
	'subscription.revoked': () => REVOKED_STATE,
};

/**
 * Apply a Polar event + status and return the state to persist, or `null`
 * when the event is outside the subscription lifecycle (callers ignore it).
 */
export function resolveLifecycleTransition(
	eventType: string,
	polarStatus: string,
): SubscriptionState | null {
	const apply = LIFECYCLE_TRANSITIONS[eventType as PolarSubscriptionEvent];
	if (!apply) return null;
	return apply(polarStatus);
}

/**
 * Clamp a Polar status onto the values the DB CHECK accepts. Unrecognised
 * statuses fail closed to `incomplete` — never a silent grant.
 */
export function normaliseStatus(status: string): SubscriptionStatus {
	return POLAR_STATUS_MAP[status] ?? 'incomplete';
}
