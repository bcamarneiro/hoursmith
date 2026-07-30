/**
 * Identity Matching Service
 *
 * Resolves whether two user profiles from different data sources (Jira, GitLab,
 * calendar feeds, etc.) represent the same human. Combines:
 *   1. Input validation — reject obviously bad identity data early.
 *   2. Fuzzy string matching — Levenshtein and Jaro-Winkler on display names.
 *   3. Composite scoring — email match, account id match, name similarity,
 *      normalised token overlap.
 *
 * Design is pure-functional and stateless. No HTTP calls — this is a local
 * utility service.
 */

import type {
	IdentityProfile,
	IdentityResolutionResult,
	MatchMethod,
	MatchResult,
	NameTokens,
	ValidationError,
} from '../../types/identity';

// ────────────────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Validate an e-mail address structurally (RFC 5322 simplified — just checks
 * for exactly one `@` with non-empty local-part and domain).
 */
export function isValidEmail(email: string): boolean {
	if (!email || typeof email !== 'string') return false;
	const trimmed = email.trim().toLowerCase();
	if (trimmed.length > 254) return false; // RFC 5321 limit
	const atIdx = trimmed.lastIndexOf('@');
	if (atIdx < 1 || atIdx === trimmed.length - 1) return false;
	const local = trimmed.slice(0, atIdx);
	const domain = trimmed.slice(atIdx + 1);
	if (local.length > 64) return false; // RFC 5321 limit
	if (!domain.includes('.')) return false;
	return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) &&
		/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(
			domain,
		);
}

/**
 * Normalise an email address: lowercase, trim, strip dots from the local-part
 * of major providers (Gmail, Google Workspace) where they're ignored.
 */
export function normalizeEmail(email: string): string {
	const trimmed = email.trim().toLowerCase();
	const [local, domain] = trimmed.split('@');
	if (!domain) return trimmed;
	// Gmail/Google Apps: dots in local-part are ignored.
	if (domain === 'gmail.com' || domain === 'googlemail.com' || domain.endsWith('.googlemail.com')) {
		return `${local.replace(/\./g, '')}@gmail.com`;
	}
	return trimmed;
}

/**
 * Validate a Display Name — must not be empty and must contain at least one
 * alphabetic character (no pure-whitespace / pure-punctuation names).
 */
export function isValidDisplayName(name: string): boolean {
	if (!name || typeof name !== 'string') return false;
	const trimmed = name.trim();
	if (trimmed.length < 2) return false;
	return /[a-zA-Z\u00C0-\u024F]/.test(trimmed);
}

/**
 * Validate an IdentityProfile. Returns an array of errors (empty = valid).
 * At least one of `email` or `displayName` must be present and well-formed
 * for the profile to be usable for matching.
 */
export function validateProfile(
	profile: IdentityProfile,
): ValidationError[] {
	const errors: ValidationError[] = [];

	if (!profile.source || typeof profile.source !== 'string') {
		errors.push({
			code: 'missing-source',
			field: 'source',
			message: 'Profile source is required.',
		});
	}

	const hasEmail =
		typeof profile.email === 'string' && profile.email.trim().length > 0;
	const hasDisplayName =
		typeof profile.displayName === 'string' &&
		profile.displayName.trim().length > 0;
	const hasAccountId =
		typeof profile.accountId === 'string' &&
		profile.accountId.trim().length > 0;

	if (!hasEmail && !hasDisplayName && !hasAccountId) {
		errors.push({
			code: 'empty-profile',
			field: 'email',
			message:
				'At least one of email, displayName, or accountId is required.',
		});
	}

	if (hasEmail && !isValidEmail(profile.email!)) {
		errors.push({
			code: 'invalid-email',
			field: 'email',
			message: `Invalid email address: "${profile.email}".`,
		});
	}

	return errors;
}

// ────────────────────────────────────────────────────────────────────────────
// Fuzzy string matching — Levenshtein distance
// ────────────────────────────────────────────────────────────────────────────

/**
 * Levenshtein edit distance between two strings.
 * Returns the minimum number of single-character edits.
 */
export function levenshteinDistance(a: string, b: string): number {
	const s1 = a.toLowerCase();
	const s2 = b.toLowerCase();
	const m = s1.length;
	const n = s2.length;

	// Optimisation: short-circuit if one string is empty.
	if (m === 0) return n;
	if (n === 0) return m;

	// Use two-row optimisation (O(min(m,n)) memory).
	const row = n < m;
	const short = row ? s1 : s2;
	const long = row ? s2 : s1;
	const sl = short.length;
	const ll = long.length;

	let prev = new Uint32Array(sl + 1);
	let curr = new Uint32Array(sl + 1);

	for (let i = 0; i <= sl; i++) prev[i] = i;

	for (let j = 1; j <= ll; j++) {
		curr[0] = j;
		for (let i = 1; i <= sl; i++) {
			const cost = short[i - 1] === long[j - 1] ? 0 : 1;
			curr[i] = Math.min(
				prev[i] + 1, // deletion
				curr[i - 1] + 1, // insertion
				prev[i - 1] + cost, // substitution
			);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}

	return prev[sl];
}

/**
 * Normalised Levenshtein similarity in [0, 1].
 * 1.0 = identical, 0.0 = completely different.
 */
export function levenshteinSimilarity(a: string, b: string): number {
	const dist = levenshteinDistance(a, b);
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1.0;
	return 1 - dist / maxLen;
}

// ────────────────────────────────────────────────────────────────────────────
// Fuzzy string matching — Jaro-Winkler similarity
// ────────────────────────────────────────────────────────────────────────────

/**
 * Jaro-Winkler similarity (in [0, 1]).
 *
 * The Jaro distance accounts for matching characters and transpositions;
 * Winkler's prefix boost raises the score when the first PREFIX_LEN
 * characters agree.
 */
const JARO_PREFIX_LEN = 4;
const JARO_PREFIX_BOOST = 0.1;

export function jaroWinklerSimilarity(a: string, b: string): number {
	const s1 = a.toLowerCase().trim();
	const s2 = b.toLowerCase().trim();

	if (s1 === s2) return 1.0;
	if (s1.length === 0 || s2.length === 0) return 0.0;

	const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
	const matchWindowClamped = Math.max(0, matchWindow);

	const matched1 = new Array(s1.length).fill(false);
	const matched2 = new Array(s2.length).fill(false);

	let matches = 0;
	let transpositions = 0;

	for (let i = 0; i < s1.length; i++) {
		const start = Math.max(0, i - matchWindowClamped);
		const end = Math.min(i + matchWindowClamped + 1, s2.length);
		for (let j = start; j < end; j++) {
			if (matched2[j]) continue;
			if (s1[i] !== s2[j]) continue;
			matched1[i] = true;
			matched2[j] = true;
			matches++;
			break;
		}
	}

	if (matches === 0) return 0.0;

	let k = 0;
	for (let i = 0; i < s1.length; i++) {
		if (!matched1[i]) continue;
		while (!matched2[k]) k++;
		if (s1[i] !== s2[k]) transpositions++;
		k++;
	}

	const jaro =
		(matches / s1.length +
			matches / s2.length +
			(matches - transpositions / 2) / matches) /
		3;

	// Winkler prefix boost
	let prefixLen = 0;
	const limit = Math.min(JARO_PREFIX_LEN, s1.length, s2.length);
	for (let i = 0; i < limit; i++) {
		if (s1[i] === s2[i]) prefixLen++;
		else break;
	}

	return jaro + prefixLen * JARO_PREFIX_BOOST * (1 - jaro);
}

// ────────────────────────────────────────────────────────────────────────────
// Name token helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Tokenise a display name into alphabetic tokens.  Strips punctuation and
 * splits on whitespace/hyphens; discards tokens shorter than 2 characters.
 *
 *   tokenizeName("Bruno C")        → ["bruno", "c"]
 *   tokenizeName("João Silva")     → ["joão", "silva"]
 *   tokenizeName("")               → []
 */
export function tokenizeName(name: string): NameTokens {
	if (!name) return [];
	return name
		.toLowerCase()
		.trim()
		.split(/[\s-]+/)
		.map((t) => t.replace(/[^a-z\u00C0-\u024F0-9]/g, ''))
		.filter((t) => t.length >= 2);
}

/**
 * Compute the Jaccard index (token overlap ratio) between two token sets.
 *
 *   tokenJaccard(["bruno", "camarneiro"], ["bruno", "c"])  → 1/3 ≈ 0.33
 */
export function tokenJaccard(a: NameTokens, b: NameTokens): number {
	if (a.length === 0 && b.length === 0) return 1.0;
	if (a.length === 0 || b.length === 0) return 0.0;
	const setA = new Set(a);
	const setB = new Set(b);
	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) intersection++;
	}
	const union = new Set([...setA, ...setB]);
	return intersection / union.size;
}

// ────────────────────────────────────────────────────────────────────────────
// Composite matching
// ────────────────────────────────────────────────────────────────────────────

const MATCH_THRESHOLD = 0.5;
const HIGH_CONFIDENCE = 0.9;

/**
 * Compare two identity profiles and produce a structured MatchResult.
 *
 * Strategy (in priority order by reliability):
 *   1. **Email** — normalised exact match → immediate high-confidence match.
 *   2. **Account id** — exact opaque-id match → high-confidence match.
 *   3. **Name** — exact-normalised displayName → high-confidence match.
 *   4. **Name fuzzy** — Jaro-Winkler on full name > 0.92 → match.
 *   5. **Name tokens** — Jaccard index on tokenised name > 0.5 → match.
 *   6. **Fallback** — no-match with aggregated field scores.
 */
export function matchProfiles(
	a: IdentityProfile,
	b: IdentityProfile,
): MatchResult {
	const fieldScores: Record<string, number> = {};
	const matchedFields: string[] = [];

	// 1. Email match
	const emailA = a.email ? normalizeEmail(a.email) : '';
	const emailB = b.email ? normalizeEmail(b.email) : '';
	if (emailA && emailB) {
		if (emailA === emailB) {
			fieldScores.email = 1.0;
			matchedFields.push('email');
		} else {
			// Fuzzy email similarity (local-part only, after normalisation)
			const [localA] = emailA.split('@');
			const [localB] = emailB.split('@');
			fieldScores.email = levenshteinSimilarity(localA, localB);
		}
	}

	// 2. Account id match
	const idA = a.accountId?.trim().toLowerCase() ?? '';
	const idB = b.accountId?.trim().toLowerCase() ?? '';
	if (idA && idB && idA === idB) {
		fieldScores.accountId = 1.0;
		matchedFields.push('accountId');
	}

	// 3. Display name matches
	const nameA = a.displayName?.trim() ?? '';
	const nameB = b.displayName?.trim() ?? '';
	let nameScore = 0;

	if (nameA && nameB) {
		const nameALower = nameA.toLowerCase();
		const nameBLower = nameB.toLowerCase();

		// Exact (case-insensitive)
		if (nameALower === nameBLower) {
			nameScore = 1.0;
			matchedFields.push('displayName');
		} else {
			// Jaro-Winkler on full name
			const jw = jaroWinklerSimilarity(nameA, nameB);
			if (jw > 0.92) {
				nameScore = jw;
				matchedFields.push('displayName');
			} else {
				// Token-level Jaccard index
				const tokensA = tokenizeName(nameA);
				const tokensB = tokenizeName(nameB);
				const jaccard = tokenJaccard(tokensA, tokensB);
				if (jaccard > 0.5) {
					nameScore = jaccard;
					matchedFields.push('displayName');
				} else if (jw > 0.7) {
					// Moderate Jaro-Winkler still contributes
					nameScore = jw;
				}
			}
		}
	}
	fieldScores.displayName = nameScore;

	// 4. Aggregate
	const emailWeight = emailA && emailB ? 3 : 0;
	const idWeight = idA && idB ? 3 : 0;
	const nameWeight = nameA && nameB ? 2 : 0;
	const totalWeight = emailWeight + idWeight + nameWeight;

	let weighted = 0;
	if (totalWeight > 0) {
		weighted =
			((fieldScores.email ?? 0) * emailWeight +
				(fieldScores.accountId ?? 0) * idWeight +
				(fieldScores.displayName ?? 0) * nameWeight) /
			totalWeight;
	}

	const method = determineMethod(weighted, matchedFields);
	const match = weighted >= MATCH_THRESHOLD;

	// Clamp confidence to [0, 1].
	const confidence = Math.min(1, Math.max(0, weighted));

	return {
		match,
		confidence,
		method,
		matchedFields,
		fieldScores,
	};
}

function determineMethod(
	score: number,
	matchedFields: string[],
): MatchMethod {
	if (score >= MATCH_THRESHOLD) {
		if (matchedFields.includes('email')) return 'email-exact';
		if (matchedFields.includes('accountId')) return 'account-id-exact';
		if (score >= HIGH_CONFIDENCE && matchedFields.includes('displayName')) {
			return 'name-exact';
		}
		if (matchedFields.includes('displayName')) return 'name-fuzzy';
		return 'name-subset';
	}
	return 'no-match';
}

// ────────────────────────────────────────────────────────────────────────────
// Profile resolution
// ────────────────────────────────────────────────────────────────────────────

/**
 * Given a query profile and a pool of candidates, find the best matching
 * profile. Returns ranked candidates and the best match (or null if no
 * candidate scores above threshold).
 *
 * Useful for resolving e.g. a GitLab activity author against a known roster
 * of Jira users.
 */
export function resolveIdentity(
	query: IdentityProfile,
	candidates: IdentityProfile[],
): IdentityResolutionResult {
	const scored = candidates
		.map((candidate) => ({
			profile: candidate,
			result: matchProfiles(query, candidate),
		}))
		.sort((a, b) => b.result.confidence - a.result.confidence);

	const bestScored = scored[0];
	const best =
		bestScored && bestScored.result.confidence >= MATCH_THRESHOLD
			? bestScored.profile
			: null;

	return {
		candidates: scored.map((s) => ({
			profile: s.profile,
			score: s.result.confidence,
		})),
		best,
		confidence: bestScored?.result.confidence ?? 0,
	};
}
