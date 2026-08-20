import { describe, it } from 'vitest';
import { layOutDay } from '../dayLayout';

describe('probe', () => {
	it('overflow', () => {
		const out = layOutDay({
			date: '2026-08-07',
			suggestions: Array.from({ length: 6 }, (_, i) => ({
				id: `s${i}`,
				seconds: 3600,
			})),
			activeHours: [20, 21, 22, 23],
			existing: [],
		});
		console.log('OVERFLOW', JSON.stringify(out.map((o) => o.startedAt)));
	});
	it('overrun onto existing', () => {
		const out = layOutDay({
			date: '2026-08-03',
			suggestions: [{ id: 'a', seconds: 2 * 3600 }],
			activeHours: [9, 10, 11, 12, 13, 14, 15, 16],
			existing: [{ startedAt: '2026-08-03T10:00:00', seconds: 7 * 3600 }],
		});
		console.log('OVERRUN', JSON.stringify(out.map((o) => o.startedAt)));
	});
});
