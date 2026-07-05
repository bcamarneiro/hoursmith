import { describe, expect, it } from 'vitest';
import type { TeamMemberSummary } from '../../../services/teamService';
import { teamMembersToReminderInputs } from '../useReminderStateSync';

function member(over: Partial<TeamMemberSummary>): TeamMemberSummary {
	return {
		email: 'a@b.co',
		displayName: 'A',
		dailyHours: new Map(),
		totalSeconds: 0,
		targetSeconds: 8 * 3600,
		gapSeconds: 8 * 3600,
		...over,
	};
}

describe('teamMembersToReminderInputs', () => {
	it('marks a member who met what is owed so far as complete', () => {
		const [input] = teamMembersToReminderInputs([
			member({ proratedGapSeconds: 0, gapSeconds: 3600 }),
		]);
		// prorated (owed-so-far) wins over the full-week gap
		expect(input.complete).toBe(true);
	});

	it('marks a member still behind as incomplete', () => {
		const [input] = teamMembersToReminderInputs([
			member({ proratedGapSeconds: 3600 }),
		]);
		expect(input.complete).toBe(false);
	});

	it('treats a zero-target (full leave) member as on leave', () => {
		const [input] = teamMembersToReminderInputs([
			member({ targetSeconds: 0, gapSeconds: 0 }),
		]);
		expect(input.onLeave).toBe(true);
	});

	it('falls back to the full-week gap when prorated is absent', () => {
		const [input] = teamMembersToReminderInputs([
			member({ proratedGapSeconds: undefined, gapSeconds: 0 }),
		]);
		expect(input.complete).toBe(true);
	});

	it('drops members without an email (the server-side key)', () => {
		const inputs = teamMembersToReminderInputs([
			member({ email: '' }),
			member({ email: 'x@y.co' }),
		]);
		expect(inputs).toHaveLength(1);
		expect(inputs[0].email).toBe('x@y.co');
	});
});
