import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRescueTimeData } from '../rescueTimeService';
import { ServiceError } from '../serviceErrors';

const HEADERS = [
	'Date',
	'Time Spent (seconds)',
	'Number of People',
	'Activity',
	'Category',
	'Productivity',
];

function mockJsonOnce(body: unknown) {
	return vi.spyOn(global, 'fetch').mockResolvedValueOnce({
		ok: true,
		status: 200,
		json: async () => body,
	} as Response);
}

describe('fetchRescueTimeData', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns an empty map without fetching when no API key is given', async () => {
		const fetchMock = vi.spyOn(global, 'fetch');
		const result = await fetchRescueTimeData(
			'',
			'',
			'2026-06-15',
			'2026-06-21',
		);
		expect(result.size).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('parses a well-formed response correctly', async () => {
		mockJsonOnce({
			row_headers: HEADERS,
			rows: [
				['2026-06-15T00:00:00', 3600, 1, 'VS Code', 'Editing', 2],
				['2026-06-15T00:00:00', 600, 1, 'Reddit', 'General', -2],
				['2026-06-16T00:00:00', 1800, 1, 'Slack', 'Comms', 1],
			],
		});

		const result = await fetchRescueTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
		);

		expect(result.size).toBe(2);
		// Mon: VS Code productive (3600). Reddit is distracting (-2), excluded.
		const mon = result.get('2026-06-15');
		expect(mon?.productiveSeconds).toBe(3600);
		expect(mon?.topActivities.map((a) => a.name)).toEqual(['VS Code']);

		const tue = result.get('2026-06-16');
		expect(tue?.productiveSeconds).toBe(1800);
	});

	it('counts neutral (productivity === 0) activity toward productive time', async () => {
		mockJsonOnce({
			row_headers: HEADERS,
			rows: [
				['2026-06-15T00:00:00', 1200, 1, 'Terminal', 'Uncategorized', 0],
				['2026-06-15T00:00:00', 800, 1, 'YouTube', 'Video', -1],
			],
		});

		const result = await fetchRescueTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
		);

		const mon = result.get('2026-06-15');
		// Neutral Terminal (0) is included; distracting YouTube (-1) is excluded.
		expect(mon?.productiveSeconds).toBe(1200);
		expect(mon?.topActivities.map((a) => a.name)).toEqual(['Terminal']);
	});

	it('merges same-named activities across categories', async () => {
		mockJsonOnce({
			row_headers: HEADERS,
			rows: [
				['2026-06-15T00:00:00', 1000, 1, 'VS Code', 'Editing', 2],
				['2026-06-15T00:00:00', 500, 1, 'VS Code', 'Debugging', 2],
			],
		});

		const result = await fetchRescueTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
		);

		const mon = result.get('2026-06-15');
		expect(mon?.productiveSeconds).toBe(1500);
		expect(mon?.topActivities).toHaveLength(1);
		expect(mon?.topActivities[0]?.seconds).toBe(1500);
	});

	it('throws a ServiceError when row_headers is missing', async () => {
		mockJsonOnce({ rows: [] });

		await expect(
			fetchRescueTimeData('key', '', '2026-06-15', '2026-06-21'),
		).rejects.toThrow(ServiceError);
	});

	it('throws a ServiceError when row_headers is not an array', async () => {
		mockJsonOnce({ row_headers: 'nope', rows: [] });

		await expect(
			fetchRescueTimeData('key', '', '2026-06-15', '2026-06-21'),
		).rejects.toThrow(/row_headers/);
	});

	it('throws a ServiceError when rows is missing', async () => {
		mockJsonOnce({ row_headers: HEADERS });

		await expect(
			fetchRescueTimeData('key', '', '2026-06-15', '2026-06-21'),
		).rejects.toThrow(/rows/);
	});

	it('throws a ServiceError when a required column is absent', async () => {
		// Missing the 'Productivity' column entirely.
		mockJsonOnce({
			row_headers: [
				'Date',
				'Time Spent (seconds)',
				'Number of People',
				'Activity',
				'Category',
			],
			rows: [['2026-06-15T00:00:00', 3600, 1, 'VS Code', 'Editing']],
		});

		await expect(
			fetchRescueTimeData('key', '', '2026-06-15', '2026-06-21'),
		).rejects.toThrow(/Productivity/);
	});

	it('throws an invalid-token ServiceError on HTTP 403', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 403,
		} as Response);

		await expect(
			fetchRescueTimeData('key', '', '2026-06-15', '2026-06-21'),
		).rejects.toMatchObject({ kind: 'invalid-token', status: 403 });
	});
});
