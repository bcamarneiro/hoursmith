import { describe, expect, it } from 'vitest';
import type { WorklogItem } from '../../../services/monthWorklogService';
import {
	deriveWeekGhosts,
	deriveWeekWorklogs,
} from '../useDashboardDataFetcher';

const EMAIL = 'me@example.com';

function makeWorklog(opts: {
	id?: string;
	started: string;
	created?: string;
	timeSpentSeconds?: number;
	comment?: string;
	issueKey?: string;
	authorEmail?: string;
}): WorklogItem {
	return {
		id: opts.id ?? '1',
		self: '',
		author: {
			self: '',
			accountId: 'me',
			displayName: 'Me',
			active: true,
			emailAddress: opts.authorEmail ?? EMAIL,
		},
		updateAuthor: {
			self: '',
			accountId: 'me',
			displayName: 'Me',
			active: true,
		},
		comment: opts.comment ?? '',
		created: opts.created ?? opts.started,
		updated: opts.started,
		started: opts.started,
		timeSpent: '1h',
		timeSpentSeconds: opts.timeSpentSeconds ?? 3600,
		issueId: '12345',
		issueKey: opts.issueKey ?? 'PROJ-1',
		issue: {
			id: '12345',
			key: opts.issueKey ?? 'PROJ-1',
			fields: { summary: 'Test issue' },
		},
		// biome-ignore lint/suspicious/noExplicitAny: test fixture
	} as any;
}

describe('deriveWeekWorklogs', () => {
	it('includes worklogs whose loggedOn falls in the week', () => {
		const wl = makeWorklog({ started: '2025-10-15T09:00:00Z' });
		const result = deriveWeekWorklogs([wl], EMAIL, '2025-10-13', '2025-10-19');
		expect(result).toHaveLength(1);
		expect(result[0].date).toBe('2025-10-15');
	});

	it('uses classifier loggedOn for backdated worklogs', () => {
		// Started 2025-09-30 but created 2025-10-15 — jira-native backdate.
		// loggedOn=2025-10-15 (created), intendedFor=2025-09-30.
		const wl = makeWorklog({
			started: '2025-09-30T09:00:00Z',
			created: '2025-10-15T09:00:00Z',
		});
		const result = deriveWeekWorklogs([wl], EMAIL, '2025-10-13', '2025-10-19');
		expect(result).toHaveLength(1);
		expect(result[0].date).toBe('2025-10-15');
	});

	it('skips worklogs from other authors', () => {
		const wl = makeWorklog({
			started: '2025-10-15T09:00:00Z',
			authorEmail: 'someone-else@example.com',
		});
		expect(
			deriveWeekWorklogs([wl], EMAIL, '2025-10-13', '2025-10-19'),
		).toHaveLength(0);
	});

	it('leaves zero entries when raw worklogs are all other-author (the filtered-out-empty precondition, ADA-436/476)', () => {
		// The hook flags `filteredOutEmpty` when the raw fetch is non-empty but the
		// email filter leaves zero — exactly this shape: 2 raw worklogs, none ours.
		const raw = [
			makeWorklog({
				id: '1',
				started: '2025-10-15T09:00:00Z',
				authorEmail: 'a@other.com',
			}),
			makeWorklog({
				id: '2',
				started: '2025-10-16T09:00:00Z',
				authorEmail: 'b@other.com',
			}),
		];
		expect(raw.length).toBeGreaterThan(0);
		expect(
			deriveWeekWorklogs(raw, EMAIL, '2025-10-13', '2025-10-19'),
		).toHaveLength(0);
	});
});

describe('deriveWeekGhosts', () => {
	it('emits a ghost when intendedFor is in week and loggedOn is outside', () => {
		// intendedFor=2025-10-15 (in week 13–19), loggedOn=2025-11-05 (outside).
		const wl = makeWorklog({
			started: '2025-10-15T09:00:00Z',
			created: '2025-11-05T09:00:00Z',
			timeSpentSeconds: 7200,
		});
		const ghosts = deriveWeekGhosts([wl], EMAIL, '2025-10-13', '2025-10-19');
		expect(ghosts).toHaveLength(1);
		expect(ghosts[0]).toMatchObject({
			date: '2025-10-15',
			intendedFor: '2025-10-15',
			loggedOn: '2025-11-05',
			timeSpentSeconds: 7200,
			issueKey: 'PROJ-1',
		});
		expect(ghosts[0].daysLate).toBeGreaterThan(0);
	});

	it('does not emit a ghost when loggedOn is also inside the week', () => {
		// Same-week backdated entries should NOT show as ghosts.
		const wl = makeWorklog({ started: '2025-10-15T09:00:00Z' });
		const ghosts = deriveWeekGhosts([wl], EMAIL, '2025-10-13', '2025-10-19');
		expect(ghosts).toHaveLength(0);
	});

	it('does not emit a ghost when intendedFor is outside the visible week', () => {
		const wl = makeWorklog({
			started: '2025-09-30T09:00:00Z',
			created: '2025-11-05T09:00:00Z',
		});
		// Visible week 2025-10-13..19 — intendedFor 2025-09-30 is not in it.
		expect(
			deriveWeekGhosts([wl], EMAIL, '2025-10-13', '2025-10-19'),
		).toHaveLength(0);
	});

	it('skips non-author worklogs', () => {
		const wl = makeWorklog({
			started: '2025-10-15T09:00:00Z',
			created: '2025-11-05T09:00:00Z',
			authorEmail: 'other@example.com',
		});
		expect(
			deriveWeekGhosts([wl], EMAIL, '2025-10-13', '2025-10-19'),
		).toHaveLength(0);
	});
});
