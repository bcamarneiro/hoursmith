import { describe, expect, it } from 'vitest';
import { extractJiraKeys } from '../jiraKeys';

describe('extractJiraKeys', () => {
	it('extracts multiple unique keys', () => {
		expect(extractJiraKeys('PUMA-12 and ABC-3 and PUMA-12')).toEqual([
			'PUMA-12',
			'ABC-3',
		]);
	});

	it('respects the left boundary (no PROJ-5 from XPROJ-5)', () => {
		expect(extractJiraKeys('XPROJ-5')).toEqual(['XPROJ-5']);
		expect(extractJiraKeys('XPROJ-5')).not.toContain('PROJ-5');
	});

	it('allows single-letter project keys', () => {
		expect(extractJiraKeys('A-1 fix')).toEqual(['A-1']);
	});

	it('returns [] when there are no keys', () => {
		expect(extractJiraKeys('no keys here')).toEqual([]);
	});
});
