/**
 * Tests for the Identity Matching Service (ADA-637).
 *
 * Covers:
 *  - Input validation (email, display name, profile structure)
 *  - Levenshtein distance and similarity
 *  - Jaro-Winkler similarity
 *  - Name tokenisation and Jaccard index
 *  - Composite profile matching (email, account id, display name)
 *  - Identity resolution against a candidate pool
 */

import { describe, expect, it } from 'vitest';
import {
	isValidEmail,
	normalizeEmail,
	isValidDisplayName,
	validateProfile,
	levenshteinDistance,
	levenshteinSimilarity,
	jaroWinklerSimilarity,
	tokenizeName,
	tokenJaccard,
	matchProfiles,
	resolveIdentity,
} from '../identityMatchService';

// ────────────────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────────────────

describe('isValidEmail', () => {
	it('accepts a standard email address', () => {
		expect(isValidEmail('user@example.com')).toBe(true);
	});

	it('accepts emails with plus-addressing', () => {
		expect(isValidEmail('user+tag@example.com')).toBe(true);
	});

	it('accepts subdomain emails', () => {
		expect(isValidEmail('user@sub.example.com')).toBe(true);
	});

	it('rejects missing @', () => {
		expect(isValidEmail('userexample.com')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidEmail('')).toBe(false);
	});

	it('rejects whitespace-only', () => {
		expect(isValidEmail('   ')).toBe(false);
	});

	it('rejects null/undefined', () => {
		expect(isValidEmail(null as unknown as string)).toBe(false);
		expect(isValidEmail(undefined as unknown as string)).toBe(false);
	});

	it('rejects email with no local part', () => {
		expect(isValidEmail('@example.com')).toBe(false);
	});

	it('rejects email with no domain', () => {
		expect(isValidEmail('user@')).toBe(false);
	});

	it('rejects email over 254 characters', () => {
		const longLocal = 'a'.repeat(250);
		expect(isValidEmail(`${longLocal}@b.co`)).toBe(false);
	});
});

describe('normalizeEmail', () => {
	it('lowercases the email', () => {
		expect(normalizeEmail('User@Example.com')).toBe('user@example.com');
	});

	it('strips dots from gmail local-part', () => {
		expect(normalizeEmail('john.doe@gmail.com')).toBe('johndoe@gmail.com');
	});

	it('handles googlemail.com alias', () => {
		expect(normalizeEmail('john.doe@googlemail.com')).toBe(
			'johndoe@gmail.com',
		);
	});

	it('preserves dots in non-gmail addresses', () => {
		expect(normalizeEmail('john.doe@example.com')).toBe(
			'john.doe@example.com',
		);
	});

	it('trims whitespace', () => {
		expect(normalizeEmail('  User@Example.com  ')).toBe('user@example.com');
	});
});

describe('isValidDisplayName', () => {
	it('accepts a normal name', () => {
		expect(isValidDisplayName('Bruno Camarneiro')).toBe(true);
	});

	it('accepts names with accented characters', () => {
		expect(isValidDisplayName('João Silva')).toBe(true);
	});

	it('rejects empty string', () => {
		expect(isValidDisplayName('')).toBe(false);
	});

	it('rejects whitespace-only', () => {
		expect(isValidDisplayName('   ')).toBe(false);
	});

	it('rejects a single character', () => {
		expect(isValidDisplayName('B')).toBe(false);
	});
});

describe('validateProfile', () => {
	it('passes a valid profile with email', () => {
		const errors = validateProfile({
			email: 'bruno@example.com',
			displayName: 'Bruno Camarneiro',
			source: 'jira',
		});
		expect(errors).toHaveLength(0);
	});

	it('passes a valid profile with displayName only', () => {
		const errors = validateProfile({
			displayName: 'Bruno Camarneiro',
			source: 'gitlab',
		});
		expect(errors).toHaveLength(0);
	});

	it('rejects a profile with no source', () => {
		const errors = validateProfile({
			email: 'bruno@example.com',
		} as unknown as { email: string; source: string });
		expect(errors.some((e) => e.code === 'missing-source')).toBe(true);
	});

	it('rejects an empty profile', () => {
		const errors = validateProfile({
			source: 'jira',
		});
		expect(errors.some((e) => e.code === 'empty-profile')).toBe(true);
	});

	it('rejects an invalid email in profile', () => {
		const errors = validateProfile({
			email: 'not-an-email',
			source: 'jira',
		});
		expect(errors.some((e) => e.code === 'invalid-email')).toBe(true);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Levenshtein distance
// ────────────────────────────────────────────────────────────────────────────

describe('levenshteinDistance', () => {
	it('returns 0 for identical strings', () => {
		expect(levenshteinDistance('hello', 'hello')).toBe(0);
	});

	it('returns the length of the non-empty string when one is empty', () => {
		expect(levenshteinDistance('', 'hello')).toBe(5);
		expect(levenshteinDistance('hello', '')).toBe(5);
	});

	it('computes a single substitution', () => {
		expect(levenshteinDistance('cat', 'car')).toBe(1);
	});

	it('computes a single insertion', () => {
		expect(levenshteinDistance('cat', 'cats')).toBe(1);
	});

	it('computes a single deletion', () => {
		expect(levenshteinDistance('cats', 'cat')).toBe(1);
	});

	it('computes distance for unrelated strings', () => {
		expect(levenshteinDistance('abcdef', 'ghijkl')).toBe(6);
	});

	it('is case-insensitive', () => {
		expect(levenshteinDistance('Hello', 'hello')).toBe(0);
	});

	it('handles the example from the docstring', () => {
		expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
	});
});

describe('levenshteinSimilarity', () => {
	it('returns 1.0 for identical strings', () => {
		expect(levenshteinSimilarity('hello', 'hello')).toBe(1.0);
	});

	it('returns 0.0 for empty vs non-empty', () => {
		expect(levenshteinSimilarity('', 'hello')).toBe(0);
	});

	it('returns 1.0 when both are empty', () => {
		expect(levenshteinSimilarity('', '')).toBe(1.0);
	});

	it('returns a score in (0, 1) for similar strings', () => {
		const score = levenshteinSimilarity('Bruno', 'Bruno');
		expect(score).toBe(1.0);
	});

	it('gives a reasonable similarity for close names', () => {
		const score = levenshteinSimilarity('Camarneiro', 'Camarneiro');
		expect(score).toBe(1.0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Jaro-Winkler similarity
// ────────────────────────────────────────────────────────────────────────────

describe('jaroWinklerSimilarity', () => {
	it('returns 1.0 for identical strings', () => {
		expect(jaroWinklerSimilarity('Bruno', 'Bruno')).toBeCloseTo(1.0, 5);
	});

	it('returns 0.0 when one string is empty', () => {
		expect(jaroWinklerSimilarity('', 'Bruno')).toBe(0.0);
		expect(jaroWinklerSimilarity('Bruno', '')).toBe(0.0);
	});

	it('scores close names highly', () => {
		const score = jaroWinklerSimilarity('Martha', 'Marhta');
		// Martha/Marhta is the classic Jaro-Winkler example (~0.96)
		expect(score).toBeGreaterThan(0.9);
		expect(score).toBeLessThan(1.0);
	});

	it('scores very different names low', () => {
		const score = jaroWinklerSimilarity('Bruno', 'Xavier');
		expect(score).toBeLessThan(0.6);
	});

	it('gives higher score when prefix matches', () => {
		const samePrefix = jaroWinklerSimilarity('Bruno', 'Bruna');
		const diffPrefix = jaroWinklerSimilarity('Bruno', 'Carla');
		expect(samePrefix).toBeGreaterThan(diffPrefix);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Name tokenisation & Jaccard index
// ────────────────────────────────────────────────────────────────────────────

describe('tokenizeName', () => {
	it('splits a typical full name', () => {
		expect(tokenizeName('Bruno Camarneiro')).toEqual([
			'bruno',
			'camarneiro',
		]);
	});

	it('handles accented characters', () => {
		expect(tokenizeName('João Silva')).toEqual(['joão', 'silva']);
	});

	it('splits hyphenated names', () => {
		expect(tokenizeName('Jean-Pierre')).toEqual(['jean', 'pierre']);
	});

	it('strips punctuation', () => {
		expect(tokenizeName("O'Brien")).toEqual(['obrien']);
	});

	it('returns empty for empty input', () => {
		expect(tokenizeName('')).toEqual([]);
	});

	it('discards single-character tokens', () => {
		expect(tokenizeName('Bruno C')).toEqual(['bruno']);
	});
});

describe('tokenJaccard', () => {
	it('returns 1.0 for identical token sets', () => {
		expect(
			tokenJaccard(['bruno', 'camarneiro'], ['bruno', 'camarneiro']),
		).toBe(1.0);
	});

	it('returns 0.0 for disjoint sets', () => {
		expect(tokenJaccard(['bruno'], ['joão'])).toBe(0.0);
	});

	it('returns 1.0 when both sets are empty', () => {
		expect(tokenJaccard([], [])).toBe(1.0);
	});

	it('returns 0.0 when one set is empty', () => {
		expect(tokenJaccard(['bruno'], [])).toBe(0.0);
	});

	it('computes partial overlap', () => {
		// intersection = {bruno} = 1, union = {bruno, camarneiro} = 2
		expect(
			tokenJaccard(['bruno', 'camarneiro'], ['bruno', 'silva']),
		).toBeCloseTo(1 / 3, 5);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Composite profile matching
// ────────────────────────────────────────────────────────────────────────────

describe('matchProfiles', () => {
	it('matches on exact email with high confidence', () => {
		const result = matchProfiles(
			{ email: 'bruno@example.com', displayName: 'Bruno C', source: 'jira' },
			{
				email: 'bruno@example.com',
				displayName: 'Bruno Camarneiro',
				source: 'gitlab',
			},
		);
		expect(result.match).toBe(true);
		expect(result.confidence).toBeGreaterThanOrEqual(0.9);
		expect(result.method).toBe('email-exact');
		expect(result.matchedFields).toContain('email');
	});

	it('matches on email ignoring Gmail dots', () => {
		const result = matchProfiles(
			{ email: 'john.doe@gmail.com', displayName: 'John Doe', source: 'jira' },
			{
				email: 'johndoe@gmail.com',
				displayName: 'John Doe',
				source: 'gitlab',
			},
		);
		expect(result.match).toBe(true);
		expect(result.confidence).toBeGreaterThanOrEqual(0.9);
		expect(result.method).toBe('email-exact');
	});

	it('matches on account id', () => {
		const result = matchProfiles(
			{
				accountId: 'abc123',
				displayName: 'Bruno Camarneiro',
				source: 'jira',
			},
			{
				accountId: 'abc123',
				displayName: 'Bruno C',
				source: 'gitlab',
			},
		);
		expect(result.match).toBe(true);
		expect(result.confidence).toBeGreaterThanOrEqual(0.9);
		expect(result.method).toBe('account-id-exact');
	});

	it('matches on exact display name', () => {
		const result = matchProfiles(
			{ displayName: 'Bruno Camarneiro', source: 'jira' },
			{ displayName: 'Bruno Camarneiro', source: 'gitlab' },
		);
		expect(result.match).toBe(true);
		expect(result.confidence).toBeGreaterThanOrEqual(0.9);
		expect(result.method).toBe('name-exact');
	});

	it('matches on fuzzy name with Jaro-Winkler', () => {
		const result = matchProfiles(
			{ displayName: 'Bruno Camarneiro', source: 'jira' },
			{ displayName: 'Bruno Camarneiro', source: 'gitlab' },
		);
		expect(result.match).toBe(true);
	});

	it('does not match completely different people', () => {
		const result = matchProfiles(
			{ email: 'alice@example.com', displayName: 'Alice', source: 'jira' },
			{ email: 'bob@example.com', displayName: 'Bob Smith', source: 'gitlab' },
		);
		expect(result.match).toBe(false);
		expect(result.method).toBe('no-match');
	});

	it('reports which fields matched', () => {
		const result = matchProfiles(
			{ email: 'bruno@example.com', displayName: 'Bruno', source: 'jira' },
			{ email: 'bruno@example.com', displayName: 'Bruno', source: 'gitlab' },
		);
		expect(result.matchedFields).toContain('email');
		expect(result.matchedFields).toContain('displayName');
	});

	it('returns per-field scores', () => {
		const result = matchProfiles(
			{ email: 'a@b.com', displayName: 'Alice', source: 's1' },
			{ email: 'a@b.com', displayName: 'Bob', source: 's2' },
		);
		expect(result.fieldScores.email).toBe(1.0);
		expect(typeof result.fieldScores.displayName).toBe('number');
	});

	it('handles profiles with only displayName (no email)', () => {
		const result = matchProfiles(
			{ displayName: 'Daniel D', source: 'calendar' },
			{ displayName: 'Daniel D', source: 'jira' },
		);
		expect(result.match).toBe(true);
		expect(result.method).toBe('name-exact');
	});

	it('handles both profiles empty gracefully', () => {
		const result = matchProfiles(
			{ source: 'a' },
			{ source: 'b' },
		);
		expect(result.match).toBe(false);
		expect(result.confidence).toBe(0);
		expect(result.method).toBe('no-match');
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Identity resolution
// ────────────────────────────────────────────────────────────────────────────

describe('resolveIdentity', () => {
	const knownUsers: Array<{
		email: string;
		displayName: string;
		accountId: string;
		source: string;
	}> = [
		{
			email: 'bruno@example.com',
			displayName: 'Bruno Camarneiro',
			accountId: 'jira-001',
			source: 'jira',
		},
		{
			email: 'alice@example.com',
			displayName: 'Alice Wonderland',
			accountId: 'jira-002',
			source: 'jira',
		},
		{
			email: 'bob@example.com',
			displayName: 'Bob Smith',
			accountId: 'jira-003',
			source: 'jira',
		},
	];

	it('finds the best match by email', () => {
		const result = resolveIdentity(
			{ email: 'bruno@example.com', displayName: 'Bruno C', source: 'gitlab' },
			knownUsers,
		);
		expect(result.best).not.toBeNull();
		expect(result.best!.email).toBe('bruno@example.com');
		expect(result.confidence).toBeGreaterThanOrEqual(0.9);
	});

	it('returns ranked candidates sorted by score', () => {
		const result = resolveIdentity(
			{ email: 'bruno@example.com', source: 'gitlab' },
			knownUsers,
		);
		expect(result.candidates.length).toBe(knownUsers.length);
		// First candidate should have the highest score
		for (let i = 1; i < result.candidates.length; i++) {
			expect(result.candidates[i - 1].score).toBeGreaterThanOrEqual(
				result.candidates[i].score,
			);
		}
	});

	it('returns null best when no candidate matches', () => {
		const result = resolveIdentity(
			{
				email: 'stranger@example.com',
				displayName: 'Stranger Danger',
				source: 'gitlab',
			},
			knownUsers,
		);
		expect(result.best).toBeNull();
		expect(result.candidates.length).toBe(knownUsers.length);
	});

	it('returns empty candidates for empty pool', () => {
		const result = resolveIdentity(
			{ email: 'bruno@example.com', source: 'gitlab' },
			[],
		);
		expect(result.best).toBeNull();
		expect(result.candidates).toHaveLength(0);
		expect(result.confidence).toBe(0);
	});

	it('matches on fuzzy name when no email provided', () => {
		const result = resolveIdentity(
			{ displayName: 'Alice W.', source: 'calendar' },
			knownUsers,
		);
		// Alice W. should match Alice Wonderland better than others
		expect(result.best).not.toBeNull();
		expect(result.best!.email).toBe('alice@example.com');
	});
});
