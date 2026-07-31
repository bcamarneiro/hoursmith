/**
 * Unit tests for the subscription lifecycle state machine core (ADA-740).
 *
 * Pure rules — no network, no Supabase. Exercises the state guards, the
 * Polar status clamping, and the event → state transition table.
 */

import { describe, expect, it } from 'vitest';

import {
	isPolarSubscriptionEvent,
	isSubscriptionState,
	isSubscriptionStatus,
	isSubscriptionTier,
	normaliseStatus,
	resolveLifecycleTransition,
	SUBSCRIPTION_STATUSES,
	SUBSCRIPTION_TIERS,
} from '../subscriptionLifecycle';

describe('subscription lifecycle state machine', () => {
	describe('state guards', () => {
		it('accepts exactly the DB CHECK statuses', () => {
			for (const status of SUBSCRIPTION_STATUSES) {
				expect(isSubscriptionStatus(status)).toBe(true);
			}
			expect(isSubscriptionStatus('revoked')).toBe(false);
			expect(isSubscriptionStatus('expired')).toBe(false);
			expect(isSubscriptionStatus('')).toBe(false);
			expect(isSubscriptionStatus(null)).toBe(false);
			expect(isSubscriptionStatus(42)).toBe(false);
		});

		it('accepts exactly the two tiers', () => {
			for (const tier of SUBSCRIPTION_TIERS) {
				expect(isSubscriptionTier(tier)).toBe(true);
			}
			expect(isSubscriptionTier('enterprise')).toBe(false);
			expect(isSubscriptionTier(undefined)).toBe(false);
		});

		it('accepts only well-formed states', () => {
			expect(isSubscriptionState({ tier: 'premium', status: 'active' })).toBe(
				true,
			);
			expect(isSubscriptionState({ tier: 'free', status: 'canceled' })).toBe(
				true,
			);
			expect(isSubscriptionState({ tier: 'premium', status: 'revoked' })).toBe(
				false,
			);
			expect(
				isSubscriptionState({ tier: 'enterprise', status: 'active' }),
			).toBe(false);
			expect(isSubscriptionState(null)).toBe(false);
			expect(isSubscriptionState('premium')).toBe(false);
		});

		it('recognises only known Polar lifecycle events', () => {
			expect(isPolarSubscriptionEvent('subscription.active')).toBe(true);
			expect(isPolarSubscriptionEvent('subscription.revoked')).toBe(true);
			expect(isPolarSubscriptionEvent('order.created')).toBe(false);
			expect(isPolarSubscriptionEvent('subscription.unknown')).toBe(false);
		});
	});

	describe('normaliseStatus', () => {
		it('passes through statuses the DB CHECK accepts', () => {
			for (const status of SUBSCRIPTION_STATUSES) {
				expect(normaliseStatus(status)).toBe(status);
			}
		});

		it('maps incomplete_expired to canceled', () => {
			expect(normaliseStatus('incomplete_expired')).toBe('canceled');
		});

		it('fails closed on unknown statuses', () => {
			expect(normaliseStatus('weird')).toBe('incomplete');
			expect(normaliseStatus('')).toBe('incomplete');
		});
	});

	describe('transitions', () => {
		it('grants premium with the clamped status on grant events', () => {
			expect(
				resolveLifecycleTransition('subscription.active', 'active'),
			).toEqual({ tier: 'premium', status: 'active' });
			expect(
				resolveLifecycleTransition('subscription.updated', 'past_due'),
			).toEqual({ tier: 'premium', status: 'past_due' });
			expect(
				resolveLifecycleTransition('subscription.canceled', 'active'),
			).toEqual({ tier: 'premium', status: 'active' });
			expect(
				resolveLifecycleTransition(
					'subscription.created',
					'incomplete_expired',
				),
			).toEqual({ tier: 'premium', status: 'canceled' });
		});

		it('downgrades to free/canceled only on revoked', () => {
			expect(
				resolveLifecycleTransition('subscription.revoked', 'active'),
			).toEqual({ tier: 'free', status: 'canceled' });
			expect(
				resolveLifecycleTransition('subscription.revoked', 'canceled'),
			).toEqual({ tier: 'free', status: 'canceled' });
		});

		it('returns null for events outside the lifecycle', () => {
			expect(resolveLifecycleTransition('order.created', 'active')).toBeNull();
			expect(resolveLifecycleTransition('', 'active')).toBeNull();
		});
	});
});
