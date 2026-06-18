import { describe, expect, it } from 'vitest';
import { buildProvenanceFooter, csvEscape } from '../csvHelpers';

describe('csvEscape', () => {
	it('returns empty string for nullish or whitespace input', () => {
		expect(csvEscape('')).toBe('');
		expect(csvEscape('   ')).toBe('');
		expect(csvEscape(null as unknown as string)).toBe('');
	});

	it('collapses whitespace and trims', () => {
		expect(csvEscape('  foo\n\tbar   baz  ')).toBe('foo bar baz');
	});

	it('quotes when the value contains "', () => {
		expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
	});

	it('quotes when the value contains ,', () => {
		expect(csvEscape('Doe, Jane')).toBe('"Doe, Jane"');
	});

	it('quotes when the value contains ;', () => {
		expect(csvEscape('a;b')).toBe('"a;b"');
	});

	it('does not quote plain values', () => {
		expect(csvEscape('Alex')).toBe('Alex');
	});

	describe('formula injection (ADA-460)', () => {
		it('neutralises a leading = with a single quote', () => {
			expect(csvEscape('=cmd')).toBe("'=cmd");
		});

		it('neutralises a leading = and still quotes when delimiters present', () => {
			expect(csvEscape('=1+2;3')).toBe(`"'=1+2;3"`);
		});

		it('neutralises leading +, -, and @', () => {
			expect(csvEscape('+1')).toBe("'+1");
			expect(csvEscape('-1')).toBe("'-1");
			expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
		});

		it('does not touch values where the trigger is not the first char', () => {
			expect(csvEscape('a=b')).toBe('a=b');
			expect(csvEscape('user@example.com')).toBe('user@example.com');
		});
	});
});

describe('buildProvenanceFooter', () => {
	const provenance = {
		jiraHost: 'mock.example.com',
		sourceVersion: '1.2.3',
		generatedAt: '2026-05-12T10:00:00.000Z',
	};

	it('csv.ts style: emits all 5 fields with fallbacks', () => {
		expect(
			buildProvenanceFooter({
				policy: 'logged',
				period: '2025-10',
				provenance,
				jiraHostFallback: 'unknown',
				versionFallback: 'dev',
			}),
		).toBe(
			'# generated=2026-05-12T10:00:00.000Z jira=mock.example.com policy=logged period=2025-10 version=1.2.3',
		);
	});

	it('csv.ts style: uses fallbacks when provenance is empty', () => {
		expect(
			buildProvenanceFooter({
				policy: 'logged',
				period: 'all',
				jiraHostFallback: 'unknown',
				versionFallback: 'dev',
				provenance: { generatedAt: '2026-05-12T10:00:00.000Z' },
			}),
		).toBe(
			'# generated=2026-05-12T10:00:00.000Z jira=unknown policy=logged period=all version=dev',
		);
	});

	it('week/team style: omits version when missing and omitMissingVersion=true', () => {
		expect(
			buildProvenanceFooter({
				policy: 'logged',
				period: '2025-10-06..2025-10-12',
				provenance: { generatedAt: '2026-05-12T10:00:00.000Z' },
				omitMissingVersion: true,
			}),
		).toBe(
			'# generated=2026-05-12T10:00:00.000Z jira= policy=logged period=2025-10-06..2025-10-12',
		);
	});

	it('week/team style: emits version when provided', () => {
		expect(
			buildProvenanceFooter({
				policy: 'logged',
				period: '2025-10-06..2025-10-12',
				provenance,
				omitMissingVersion: true,
			}),
		).toBe(
			'# generated=2026-05-12T10:00:00.000Z jira=mock.example.com policy=logged period=2025-10-06..2025-10-12 version=1.2.3',
		);
	});

	it('escapes whitespace/`;`/`,`/`"` in footer values (audit #46)', () => {
		expect(
			buildProvenanceFooter({
				policy: 'logged',
				period: '2025-10',
				provenance: {
					jiraHost: 'host with;weird,chars',
					sourceVersion: 'v 1.0',
					generatedAt: '2026-05-12T10:00:00.000Z',
				},
				jiraHostFallback: '',
				versionFallback: '',
			}),
		).toBe(
			'# generated=2026-05-12T10:00:00.000Z jira=host-with-weird-chars policy=logged period=2025-10 version=v-1.0',
		);
	});

	it('defaults generatedAt to now() when not provided', () => {
		const result = buildProvenanceFooter({
			policy: 'logged',
			period: '2025-10',
		});
		expect(result).toMatch(
			/^# generated=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
		);
	});
});
