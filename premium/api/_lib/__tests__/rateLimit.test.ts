/**
 * Tests for the hosted-proxy per-user rate limiter (ADA-302).
 *
 * The store is injected, so these run with no network. We assert under-limit
 * allow, over-limit block + Retry-After, per-user isolation, window reset, and
 * fail-open on store error.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	checkRateLimit,
	RATE_LIMIT_MAX_REQUESTS,
	RATE_LIMIT_WINDOW_SECONDS,
	type RateLimitStore,
} from '../rateLimit.js';

/** In-memory fixed-window store mirroring the Postgres increment semantics. */
function memoryStore(): RateLimitStore & { counts: Map<string, number> } {
	const counts = new Map<string, number>();
	return {
		counts,
		async increment(userId: string, windowStartIso: string): Promise<number> {
			const key = `${userId}@${windowStartIso}`;
			const next = (counts.get(key) ?? 0) + 1;
			counts.set(key, next);
			return next;
		},
	};
}

const NOW = Date.parse('2026-05-30T12:02:30.000Z');

describe('checkRateLimit', () => {
	it('allows requests under the limit', async () => {
		const store = memoryStore();
		for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
			const res = await checkRateLimit('user-1', { store, nowMs: NOW });
			expect(res.allowed).toBe(true);
		}
	});

	it('blocks the request that exceeds the limit, with Retry-After', async () => {
		const store = memoryStore();
		let last = await checkRateLimit('user-1', { store, nowMs: NOW });
		for (let i = 1; i < RATE_LIMIT_MAX_REQUESTS; i++) {
			last = await checkRateLimit('user-1', { store, nowMs: NOW });
		}
		expect(last.allowed).toBe(true); // the 200th is allowed
		const over = await checkRateLimit('user-1', { store, nowMs: NOW });
		expect(over.allowed).toBe(false); // the 201st is blocked
		expect(over.retryAfterSeconds).toBeGreaterThan(0);
		expect(over.retryAfterSeconds).toBeLessThanOrEqual(
			RATE_LIMIT_WINDOW_SECONDS,
		);
	});

	it('isolates counters per user', async () => {
		const store = memoryStore();
		for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS + 5; i++) {
			await checkRateLimit('heavy-user', { store, nowMs: NOW });
		}
		const other = await checkRateLimit('light-user', { store, nowMs: NOW });
		expect(other.allowed).toBe(true);
		expect(other.count).toBe(1);
	});

	it('resets when the window rolls over', async () => {
		const store = memoryStore();
		for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS + 1; i++) {
			await checkRateLimit('user-1', { store, nowMs: NOW });
		}
		const blocked = await checkRateLimit('user-1', { store, nowMs: NOW });
		expect(blocked.allowed).toBe(false);
		// Advance past the 5-minute window → fresh counter.
		const nextWindow = NOW + (RATE_LIMIT_WINDOW_SECONDS + 1) * 1000;
		const fresh = await checkRateLimit('user-1', {
			store,
			nowMs: nextWindow,
		});
		expect(fresh.allowed).toBe(true);
		expect(fresh.count).toBe(1);
	});

	it('fails open when the store throws, logging a warning', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store: RateLimitStore = {
			increment: vi.fn(async () => {
				throw new Error('db unreachable');
			}),
		};
		const res = await checkRateLimit('user-1', { store, nowMs: NOW });
		expect(res.allowed).toBe(true);
		expect(res.count).toBeNull();
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it('fails open when no store can be constructed (no env)', async () => {
		const res = await checkRateLimit('user-1', { nowMs: NOW, env: {} });
		expect(res.allowed).toBe(true);
		expect(res.count).toBeNull();
	});
});
