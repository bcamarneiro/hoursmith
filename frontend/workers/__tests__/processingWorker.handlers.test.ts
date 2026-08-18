import { describe, expect, it } from 'vitest';
import { processMessage } from '../processingWorker.handlers';
import type {
	ProcessingWorkerRequest,
	ClassifyRequest,
	BuildHeatmapRequest,
	BuildTeamSummariesRequest,
	BuildTeamCsvRequest,
} from '../processingWorker.types';
import type { EnrichedJiraWorklog } from '../../../types/jira';

function makeWorklog(overrides: Partial<EnrichedJiraWorklog> = {}): EnrichedJiraWorklog {
	return {
		id: '10001',
		author: { emailAddress: 'alice@example.com', displayName: 'Alice' },
		comment: '',
		created: '2025-01-15T10:00:00.000+0000',
		updated: '2025-01-15T10:00:00.000+0000',
		started: '2025-01-15T09:00:00.000+0000',
		timeSpentSeconds: 28800, // 8h
		issue: { id: '100', key: 'PROJ-1', fields: { summary: 'Test issue' } },
		...overrides,
	} as EnrichedJiraWorklog;
}

describe('processMessage', () => {
	describe('classify', () => {
		it('classifies an empty worklog list', () => {
			const req: ClassifyRequest = {
				type: 'classify',
				id: 1,
				payload: { worklogs: [] },
			};
			const res = processMessage(req);
			expect(res.type).toBe('classify');
			expect(res.id).toBe(1);
			if (res.type === 'classify') {
				expect(res.result).toEqual([]);
			}
		});

		it('classifies a same-day worklog as not backdated', () => {
			const wl = makeWorklog({
				started: '2025-01-15T09:00:00.000+0000',
				created: '2025-01-15T10:00:00.000+0000',
			});
			const req: ClassifyRequest = {
				type: 'classify',
				id: 2,
				payload: { worklogs: [wl] },
			};
			const res = processMessage(req);
			expect(res.type).toBe('classify');
			if (res.type === 'classify') {
				expect(res.result).toHaveLength(1);
				expect(res.result[0].isBackdated).toBe(false);
				expect(res.result[0].loggedOn).toBe('2025-01-15');
			}
		});

		it('classifies a backdated worklog (Pattern B: jira-native)', () => {
			const wl = makeWorklog({
				started: '2024-12-10T09:00:00.000+0000', // intended for Dec 10
				created: '2025-01-15T10:00:00.000+0000', // actually logged on Jan 15 (different month)
			});
			const req: ClassifyRequest = {
				type: 'classify',
				id: 3,
				payload: { worklogs: [wl] },
			};
			const res = processMessage(req);
			expect(res.type).toBe('classify');
			if (res.type === 'classify') {
				expect(res.result).toHaveLength(1);
				expect(res.result[0].isBackdated).toBe(true);
				expect(res.result[0].loggedOn).toBe('2025-01-15');
				expect(res.result[0].intendedFor).toBe('2024-12-10');
			}
		});

		it('preserves the request id in the response', () => {
			const req: ClassifyRequest = {
				type: 'classify',
				id: 42,
				payload: { worklogs: [] },
			};
			const res = processMessage(req);
			expect(res.id).toBe(42);
		});
	});

	describe('buildHeatmap', () => {
		it('returns empty maps for no worklogs', () => {
			const req: BuildHeatmapRequest = {
				type: 'buildHeatmap',
				id: 10,
				payload: { worklogs: [], email: 'alice@example.com' },
			};
			const res = processMessage(req);
			expect(res.type).toBe('buildHeatmap');
			if (res.type === 'buildHeatmap') {
				expect(res.result.data).toEqual({});
				expect(res.result.backdatedSeconds).toEqual({});
			}
		});

		it('buckets a same-day worklog into the correct day', () => {
			const wl = makeWorklog({
				author: { emailAddress: 'alice@example.com', displayName: 'Alice' },
				started: '2025-01-15T09:00:00.000+0000',
				created: '2025-01-15T10:00:00.000+0000',
				timeSpentSeconds: 28800,
			});
			const req: BuildHeatmapRequest = {
				type: 'buildHeatmap',
				id: 11,
				payload: { worklogs: [wl], email: 'alice@example.com' },
			};
			const res = processMessage(req);
			expect(res.type).toBe('buildHeatmap');
			if (res.type === 'buildHeatmap') {
				expect(res.result.data['2025-01-15']).toBe(28800);
			}
		});

		it('separates backdated seconds into a different map', () => {
			const wl = makeWorklog({
				author: { emailAddress: 'alice@example.com', displayName: 'Alice' },
				started: '2024-12-10T09:00:00.000+0000', // different month from created
				created: '2025-01-15T10:00:00.000+0000',
				timeSpentSeconds: 7200,
			});
			const req: BuildHeatmapRequest = {
				type: 'buildHeatmap',
				id: 12,
				payload: { worklogs: [wl], email: 'alice@example.com' },
			};
			const res = processMessage(req);
			expect(res.type).toBe('buildHeatmap');
			if (res.type === 'buildHeatmap') {
				// Backdated worklogs should NOT appear in the main data map
				expect(res.result.data['2025-01-15']).toBeUndefined();
				// They should appear in the backdatedSeconds map
				const backdatedTotal = Object.values(res.result.backdatedSeconds).reduce(
					(a, b) => a + b,
					0,
				);
				expect(backdatedTotal).toBeGreaterThan(0);
			}
		});

		it('returns plain objects (not Maps) for structured-clone compatibility', () => {
			const req: BuildHeatmapRequest = {
				type: 'buildHeatmap',
				id: 13,
				payload: { worklogs: [], email: 'alice@example.com' },
			};
			const res = processMessage(req);
			if (res.type === 'buildHeatmap') {
				expect(res.result.data).toBeInstanceOf(Object);
				expect(res.result.data).not.toBeInstanceOf(Map);
				expect(res.result.backdatedSeconds).toBeInstanceOf(Object);
				expect(res.result.backdatedSeconds).not.toBeInstanceOf(Map);
			}
		});
	});

	describe('buildTeamSummaries', () => {
		it('returns summaries for allowed users even with no worklogs', () => {
			const req: BuildTeamSummariesRequest = {
				type: 'buildTeamSummaries',
				id: 20,
				payload: {
					worklogs: [],
					weekStart: '2025-01-13',
					weekEnd: '2025-01-17',
					allowedUsers: 'alice@example.com',
				},
			};
			const res = processMessage(req);
			expect(res.type).toBe('buildTeamSummaries');
			if (res.type === 'buildTeamSummaries') {
				expect(res.result).toHaveLength(1);
				expect(res.result[0].email).toBe('alice@example.com');
				expect(res.result[0].totalSeconds).toBe(0);
			}
		});

		it('produces serialisable summaries (dailyHours as entry arrays)', () => {
			const wl = makeWorklog({
				author: { emailAddress: 'alice@example.com', displayName: 'Alice' },
				started: '2025-01-15T09:00:00.000+0000',
				created: '2025-01-15T10:00:00.000+0000',
				timeSpentSeconds: 28800,
			});
			const req: BuildTeamSummariesRequest = {
				type: 'buildTeamSummaries',
				id: 21,
				payload: {
					worklogs: [wl],
					weekStart: '2025-01-13',
					weekEnd: '2025-01-17',
					allowedUsers: 'alice@example.com',
				},
			};
			const res = processMessage(req);
			expect(res.type).toBe('buildTeamSummaries');
			if (res.type === 'buildTeamSummaries') {
				expect(res.result).toHaveLength(1);
				const member = res.result[0];
				expect(member.email).toBe('alice@example.com');
				// dailyHours must be an array of entries, not a Map
				expect(Array.isArray(member.dailyHours)).toBe(true);
				expect(member.totalSeconds).toBe(28800);
			}
		});
	});

	describe('buildTeamCsv', () => {
		it('returns a CSV string for serialised summaries', () => {
			const req: BuildTeamCsvRequest = {
				type: 'buildTeamCsv',
				id: 30,
				payload: {
					summaries: [
						{
							email: 'alice@example.com',
							displayName: 'Alice',
							dailyHours: [['2025-01-15', 8]] as [string, number][],
							totalSeconds: 28800,
							targetSeconds: 28800,
							gapSeconds: 0,
						},
					],
					weekStart: '2025-01-13',
					weekEnd: '2025-01-17',
					weekdays: ['2025-01-13', '2025-01-14', '2025-01-15', '2025-01-16', '2025-01-17'],
				},
			};
			const res = processMessage(req);
			expect(res.type).toBe('buildTeamCsv');
			if (res.type === 'buildTeamCsv') {
				expect(typeof res.result).toBe('string');
				expect(res.result.length).toBeGreaterThan(0);
				// Should contain the user's email in the CSV
				expect(res.result).toContain('alice@example.com');
			}
		});
	});

	describe('unknown message type', () => {
		it('returns an error response for unknown types', () => {
			const req = {
				type: 'unknownType',
				id: 99,
				payload: {},
			} as unknown as ProcessingWorkerRequest;
			const res = processMessage(req);
			expect(res.type).toBe('error');
			expect(res.id).toBe(99);
			if (res.type === 'error') {
				expect(res.error).toContain('Unknown message type');
				expect(res.error).toContain('unknownType');
			}
		});
	});
});
