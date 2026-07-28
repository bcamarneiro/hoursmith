import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWakaTimeData } from '../wakatimeService';
import { ServiceError } from '../serviceErrors';

function mockJsonOnce(body: unknown, status = 200) {
	return vi.spyOn(global, 'fetch').mockResolvedValueOnce({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response);
}

function mockStatusOnce(status: number) {
	return vi.spyOn(global, 'fetch').mockResolvedValueOnce({
		ok: false,
		status,
	} as Response);
}

describe('fetchWakaTimeData', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns an empty map without fetching when no API key is given', async () => {
		const fetchMock = vi.spyOn(global, 'fetch');
		const result = await fetchWakaTimeData(
			'',
			'',
			'2026-06-15',
			'2026-06-21',
		);
		expect(result.size).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('parses a well-formed response with multiple days and projects', async () => {
		mockJsonOnce({
			data: [
				{
					date: '2026-06-15T00:00:00',
					projects: [
						{ name: 'hoursmith', total_seconds: 7200 },
						{ name: 'other-project', total_seconds: 3600 },
					],
				},
				{
					date: '2026-06-16T00:00:00',
					projects: [{ name: 'hoursmith', total_seconds: 1800 }],
				},
			],
		});

		const result = await fetchWakaTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
		);

		expect(result.size).toBe(2);

		const mon = result.get('2026-06-15');
		expect(mon?.totalCodingSeconds).toBe(10800);
		expect(mon?.projects).toHaveLength(2);
		// Sorted descending by duration
		expect(mon?.projects[0]?.name).toBe('hoursmith');
		expect(mon?.projects[0]?.totalSeconds).toBe(7200);
		expect(mon?.projects[1]?.name).toBe('other-project');
		expect(mon?.projects[1]?.totalSeconds).toBe(3600);

		const tue = result.get('2026-06-16');
		expect(tue?.totalCodingSeconds).toBe(1800);
		expect(tue?.projects).toHaveLength(1);
	});

	it('skips days with no valid projects', async () => {
		mockJsonOnce({
			data: [
				{
					date: '2026-06-15T00:00:00',
					projects: [],
				},
				{
					date: '2026-06-16T00:00:00',
					projects: [{ name: 'hoursmith', total_seconds: 1800 }],
				},
			],
		});

		const result = await fetchWakaTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
		);

		// Day with empty projects array is not added
		expect(result.size).toBe(1);
		expect(result.has('2026-06-15')).toBe(false);
		expect(result.has('2026-06-16')).toBe(true);
	});

	it('filters out projects with zero or negative duration', async () => {
		mockJsonOnce({
			data: [
				{
					date: '2026-06-15T00:00:00',
					projects: [
						{ name: 'active', total_seconds: 3600 },
						{ name: 'zero', total_seconds: 0 },
						{ name: 'negative', total_seconds: -100 },
					],
				},
			],
		});

		const result = await fetchWakaTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
		);

		const mon = result.get('2026-06-15');
		expect(mon?.projects).toHaveLength(1);
		expect(mon?.projects[0]?.name).toBe('active');
		expect(mon?.totalCodingSeconds).toBe(3600);
	});

	it('filters out projects with empty or non-string names', async () => {
		mockJsonOnce({
			data: [
				{
					date: '2026-06-15T00:00:00',
					projects: [
						{ name: '', total_seconds: 3600 },
						{ name: 123, total_seconds: 1800 },
						{ name: 'valid', total_seconds: 900 },
					],
				},
			],
		});

		const result = await fetchWakaTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
		);

		const mon = result.get('2026-06-15');
		expect(mon?.projects).toHaveLength(1);
		expect(mon?.projects[0]?.name).toBe('valid');
	});

	it('skips entries with missing or non-string date', async () => {
		mockJsonOnce({
			data: [
				{
					date: 12345,
					projects: [{ name: 'hoursmith', total_seconds: 3600 }],
				},
				{
					projects: [{ name: 'hoursmith', total_seconds: 3600 }],
				},
				{
					date: '2026-06-15T00:00:00',
					projects: [{ name: 'valid', total_seconds: 1800 }],
				},
			],
		});

		const result = await fetchWakaTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
		);

		expect(result.size).toBe(1);
		expect(result.has('2026-06-15')).toBe(true);
	});

	it('skips days where projects is not an array', async () => {
		mockJsonOnce({
			data: [
				{
					date: '2026-06-15T00:00:00',
					projects: 'not-an-array',
				},
				{
					date: '2026-06-16T00:00:00',
					projects: [{ name: 'valid', total_seconds: 1800 }],
				},
			],
		});

		const result = await fetchWakaTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
		);

		expect(result.size).toBe(1);
		expect(result.has('2026-06-16')).toBe(true);
	});

	it('truncates date strings to YYYY-MM-DD (first 10 chars)', async () => {
		mockJsonOnce({
			data: [
				{
					date: '2026-06-15T14:30:00Z',
					projects: [{ name: 'proj', total_seconds: 3600 }],
				},
			],
		});

		const result = await fetchWakaTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
		);

		expect(result.has('2026-06-15')).toBe(true);
	});

	it('uses default total_seconds of 0 when field is missing', async () => {
		mockJsonOnce({
			data: [
				{
					date: '2026-06-15T00:00:00',
					projects: [{ name: 'no-seconds' }],
				},
			],
		});

		const result = await fetchWakaTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
		);

		// Project with 0 seconds is filtered out
		expect(result.size).toBe(0);
	});

	it('throws ServiceError when data array is missing', async () => {
		mockJsonOnce({});

		await expect(
			fetchWakaTimeData('key', '', '2026-06-15', '2026-06-21'),
		).rejects.toThrow(ServiceError);
	});

	it('throws ServiceError when data is not an array', async () => {
		mockJsonOnce({ data: 'not-an-array' });

		await expect(
			fetchWakaTimeData('key', '', '2026-06-15', '2026-06-21'),
		).rejects.toThrow(/data/);
	});

	it('throws invalid-token ServiceError on HTTP 401', async () => {
		mockStatusOnce(401);

		await expect(
			fetchWakaTimeData('key', '', '2026-06-15', '2026-06-21'),
		).rejects.toMatchObject({ kind: 'invalid-token', status: 401 });
	});

	it('throws ServiceError on other HTTP errors', async () => {
		mockStatusOnce(500);

		await expect(
			fetchWakaTimeData('key', '', '2026-06-15', '2026-06-21'),
		).rejects.toThrow(ServiceError);
	});

	it('constructs the correct URL with CORS proxy', async () => {
		const fetchMock = mockJsonOnce({ data: [] });

		await fetchWakaTimeData(
			'my-api-key',
			'https://cors-proxy.example.com/',
			'2026-06-15',
			'2026-06-21',
		);

		expect(fetchMock).toHaveBeenCalledWith(
			'https://cors-proxy.example.com/https://api.wakatime.com/api/v1/users/current/summaries?start=2026-06-15&end=2026-06-21',
			expect.objectContaining({
				headers: {
					Authorization: expect.stringContaining('Basic'),
				},
			}),
		);
	});

	it('uses custom baseUrl when provided', async () => {
		const fetchMock = mockJsonOnce({ data: [] });

		await fetchWakaTimeData(
			'key',
			'',
			'2026-06-15',
			'2026-06-21',
			undefined,
			'https://wakapi.example.com',
		);

		expect(fetchMock).toHaveBeenCalledWith(
			'https://wakapi.example.com/api/v1/users/current/summaries?start=2026-06-15&end=2026-06-21',
			expect.anything(),
		);
	});

	it('sends Basic auth with base64-encoded API key', async () => {
		const fetchMock = mockJsonOnce({ data: [] });

		await fetchWakaTimeData('test-key', '', '2026-06-15', '2026-06-21');

		const expectedAuth = `Basic ${btoa('test-key:')}`;
		expect(fetchMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				headers: {
					Authorization: expectedAuth,
				},
			}),
		);
	});
});
