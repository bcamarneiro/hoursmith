import { describe, expect, it } from 'vitest';
import { normalizeUIPersistedState } from '../useUIStore';

/**
 * The store's `merge` returns `{ ...current, ...normalizeUIPersistedState(p) }`,
 * so any key the normaliser omits is silently replaced by the in-memory default
 * on every load. Persisting a key in `partialize` therefore does nothing unless
 * the normaliser carries it back out.
 *
 * That matters here specifically: `auto` is the default mode, and a
 * `tempoSuspected` that resets to `false` on every load means the first write
 * after a reload goes to Jira on a Tempo-managed instance — the
 * invisible-or-double-counted worklog this integration exists to avoid.
 *
 * A setter-only test cannot see this, which is why the previous one missed it.
 */
describe('tempoSuspected survives rehydration', () => {
	it('carries the flag and its fingerprint back out of persisted state', () => {
		const out = normalizeUIPersistedState({
			tempoSuspected: true,
			tempoSuspectedFingerprint: 'host::email',
		} as never);
		expect(out.tempoSuspected).toBe(true);
		expect(out.tempoSuspectedFingerprint).toBe('host::email');
	});

	it('defaults to not-suspected when nothing was persisted', () => {
		const out = normalizeUIPersistedState(undefined);
		expect(out.tempoSuspected).toBe(false);
		expect(out.tempoSuspectedFingerprint).toBeNull();
	});

	it('drops a suspicion with no fingerprint, which cannot be scoped', () => {
		// An unscoped suspicion would apply to whatever instance is configured
		// next, including one with no Tempo at all.
		const out = normalizeUIPersistedState({ tempoSuspected: true } as never);
		expect(out.tempoSuspected).toBe(false);
	});

	it('ignores a non-boolean flag from a hand-edited blob', () => {
		const out = normalizeUIPersistedState({
			tempoSuspected: 'yes',
			tempoSuspectedFingerprint: 'host::email',
		} as never);
		expect(out.tempoSuspected).toBe(false);
	});
});
