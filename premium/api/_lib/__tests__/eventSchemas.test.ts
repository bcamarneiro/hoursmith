/**
 * Tests for product event schemas (ADA-721).
 *
 * `validateProductEvent` is the producer boundary: it must accept every
 * canonical event type, reject unknown types, and return a normalized event
 * with `occurredAt` defaulted — all without touching the network. These tests
 * pin that contract so producers can rely on the return value.
 */

import { describe, expect, it } from 'vitest';

import {
	EVENT_SCHEMAS,
	EVENT_TYPES,
	EventValidationError,
	validateProductEvent,
} from '../eventSchemas.js';

const validSubscriptionPayload = {
	customerId: 'cus_test123',
	subscriptionId: 'sub_test123',
	status: 'active',
	currentPeriodEnd: '2026-08-01T12:00:00.000Z',
};

const validEvent = {
	type: EVENT_TYPES.SUBSCRIPTION_ACTIVE,
	occurredAt: '2026-07-01T12:00:00.000Z',
	payload: validSubscriptionPayload,
};

describe('validateProductEvent — accepted events', () => {
	it('accepts every canonical subscription event type', () => {
		for (const type of Object.values(EVENT_TYPES)) {
			expect(() => validateProductEvent({ ...validEvent, type })).not.toThrow();
		}
	});

	it('returns a normalized event with occurredAt preserved', () => {
		const result = validateProductEvent(validEvent);
		expect(result).toEqual(validEvent);
	});

	it('defaults a missing occurredAt to the current ISO timestamp', () => {
		const { occurredAt, ...withoutTimestamp } = validEvent;
		const result = validateProductEvent(withoutTimestamp);
		expect(occurredAt).toBeDefined();
		expect(Number.isNaN(Date.parse(result.occurredAt ?? ''))).toBe(false);
	});

	it('registers a schema for every canonical type', () => {
		expect(Object.keys(EVENT_SCHEMAS).sort()).toEqual(
			Object.values(EVENT_TYPES).sort(),
		);
	});
});

describe('validateProductEvent — rejected events', () => {
	it('rejects non-object events', () => {
		for (const bad of [null, undefined, 'event', 42, ['type']]) {
			expect(() => validateProductEvent(bad)).toThrow(EventValidationError);
		}
	});

	it('rejects an unknown event type', () => {
		const event = { ...validEvent, type: 'billing.nope' };
		try {
			validateProductEvent(event);
			throw new Error('expected EventValidationError');
		} catch (err) {
			expect(err).toBeInstanceOf(EventValidationError);
			const validationError = err as EventValidationError;
			expect(validationError.errors[0]).toContain('type must be one of');
		}
	});

	it('rejects a missing payload', () => {
		const { payload: _payload, ...withoutPayload } = validEvent;
		expect(() => validateProductEvent(withoutPayload)).toThrow(
			'payload must be an object',
		);
	});

	it('rejects a non-object payload', () => {
		expect(() =>
			validateProductEvent({ ...validEvent, payload: 'nope' }),
		).toThrow('payload must be an object');
	});

	it('rejects missing or empty required payload fields', () => {
		const cases = [
			{ ...validSubscriptionPayload, customerId: '' },
			{ ...validSubscriptionPayload, customerId: undefined },
			{ ...validSubscriptionPayload, subscriptionId: '' },
			{ ...validSubscriptionPayload, status: undefined },
		];
		for (const payload of cases) {
			expect(() => validateProductEvent({ ...validEvent, payload })).toThrow(
				EventValidationError,
			);
		}
	});

	it('rejects a non-ISO occurredAt', () => {
		expect(() =>
			validateProductEvent({ ...validEvent, occurredAt: 'yesterday' }),
		).toThrow('occurredAt must be an ISO timestamp when present');
	});

	it('rejects a non-ISO currentPeriodEnd', () => {
		expect(() =>
			validateProductEvent({
				...validEvent,
				payload: { ...validSubscriptionPayload, currentPeriodEnd: 'later' },
			}),
		).toThrow('payload.currentPeriodEnd must be an ISO timestamp when present');
	});

	it('collects every error into the EventValidationError', () => {
		try {
			validateProductEvent({
				type: EVENT_TYPES.SUBSCRIPTION_ACTIVE,
				occurredAt: 'nope',
				payload: { customerId: '' },
			});
			throw new Error('expected EventValidationError');
		} catch (err) {
			const validationError = err as EventValidationError;
			expect(validationError).toBeInstanceOf(EventValidationError);
			expect(validationError.errors.length).toBeGreaterThanOrEqual(4);
			expect(
				validationError.errors.some((e) =>
					e.includes('payload.subscriptionId'),
				),
			).toBe(true);
		}
	});
});
