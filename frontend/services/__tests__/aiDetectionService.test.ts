import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAIDetectionAnalysis } from '../aiDetectionService';
import type { AIDetectionRequest } from '../../../types/AIDetection';
import { ServiceError } from '../serviceErrors';

const MINIMAL_REQUEST: AIDetectionRequest = {
	timeEntry: {
		tissueKey: 'PROJ-123',
		description: 'Fixed login redirect bug',
		timeSpentSeconds: 3600,
		date: '2026-07-29',
	},
};

const VALID_RESPONSE_BODY = {
	detected: true,
	anomalies: [
		{
			kind: 'description_mismatch',
			severity: 'warning' as const,
			detail: 'Description does not match issue title',
		},
	],
	suggestions: [
		{
			field: 'description' as const,
			value: 'Fix login redirect bug',
			reason: 'Align description with issue PROJ-123',
		},
	],
	confidence: 0.87,
};

const DEFAULT_CONFIG = {
	enabled: true,
	apiKey: 'sk-test-key',
	endpoint: 'https://ai-detect.example.com',
};

function mockFetchOnce(body: unknown, status = 200) {
	return vi.spyOn(global, 'fetch').mockResolvedValueOnce({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response);
}

describe('fetchAIDetectionAnalysis', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns null without fetching when disabled', async () => {
		const fetchMock = vi.spyOn(global, 'fetch');
		const result = await fetchAIDetectionAnalysis(MINIMAL_REQUEST, {
			...DEFAULT_CONFIG,
			enabled: false,
		});
		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns null without fetching when apiKey is empty', async () => {
		const fetchMock = vi.spyOn(global, 'fetch');
		const result = await fetchAIDetectionAnalysis(MINIMAL_REQUEST, {
			...DEFAULT_CONFIG,
			apiKey: '',
		});
		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns null without fetching when endpoint is empty', async () => {
		const fetchMock = vi.spyOn(global, 'fetch');
		const result = await fetchAIDetectionAnalysis(MINIMAL_REQUEST, {
			...DEFAULT_CONFIG,
			endpoint: '',
		});
		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns parsed response when API returns valid data', async () => {
		mockFetchOnce(VALID_RESPONSE_BODY);

		const result = await fetchAIDetectionAnalysis(
			MINIMAL_REQUEST,
			DEFAULT_CONFIG,
		);

		expect(result).not.toBeNull();
		expect(result!.detected).toBe(true);
		expect(result!.anomalies).toHaveLength(1);
		expect(result!.anomalies[0]!.kind).toBe('description_mismatch');
		expect(result!.suggestions).toHaveLength(1);
		expect(result!.suggestions[0]!.field).toBe('description');
		expect(result!.confidence).toBeCloseTo(0.87);
	});

	it('sends the request to the correct endpoint', async () => {
		mockFetchOnce(VALID_RESPONSE_BODY);

		await fetchAIDetectionAnalysis(MINIMAL_REQUEST, DEFAULT_CONFIG);

		expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(
			'https://ai-detect.example.com/api/v1/analyze',
		);
	});

	it('sends the API key as a Bearer token', async () => {
		mockFetchOnce(VALID_RESPONSE_BODY);

		await fetchAIDetectionAnalysis(MINIMAL_REQUEST, DEFAULT_CONFIG);

		const headers = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
		expect((headers.headers as Record<string, string>).Authorization).toBe(
			'Bearer sk-test-key',
		);
	});

	it('throws a ServiceError on HTTP 401', async () => {
		mockFetchOnce({ error: { code: 'invalid_key', message: 'Bad key' } }, 401);

		await expect(
			fetchAIDetectionAnalysis(MINIMAL_REQUEST, DEFAULT_CONFIG),
		).rejects.toMatchObject({ kind: 'invalid-token', status: 401 });
	});

	it('throws a ServiceError on HTTP 403', async () => {
		mockFetchOnce({}, 403);

		await expect(
			fetchAIDetectionAnalysis(MINIMAL_REQUEST, DEFAULT_CONFIG),
		).rejects.toMatchObject({ kind: 'forbidden', status: 403 });
	});

	it('throws a ServiceError on HTTP 422 with the server error message', async () => {
		mockFetchOnce(
			{
				error: { code: 'validation_error', message: 'missing tissueKey' },
			},
			422,
		);

		await expect(
			fetchAIDetectionAnalysis(MINIMAL_REQUEST, DEFAULT_CONFIG),
		).rejects.toThrow(/missing tissueKey/);
	});

	it('throws a rate-limited ServiceError on HTTP 429', async () => {
		mockFetchOnce({}, 429);

		await expect(
			fetchAIDetectionAnalysis(MINIMAL_REQUEST, DEFAULT_CONFIG),
		).rejects.toMatchObject({ kind: 'rate-limited', status: 429 });
	});

	it('throws a ServiceError on HTTP 500', async () => {
		mockFetchOnce({}, 500);

		await expect(
			fetchAIDetectionAnalysis(MINIMAL_REQUEST, DEFAULT_CONFIG),
		).rejects.toThrow(ServiceError);
	});

	it('throws a ServiceError when detected field is missing', async () => {
		mockFetchOnce({
			anomalies: [],
			suggestions: [],
			confidence: 0.5,
		});

		await expect(
			fetchAIDetectionAnalysis(MINIMAL_REQUEST, DEFAULT_CONFIG),
		).rejects.toThrow(/detected/);
	});

	it('throws a ServiceError when anomalies is not an array', async () => {
		mockFetchOnce({
			detected: false,
			anomalies: 'nope',
			suggestions: [],
			confidence: 0.0,
		});

		await expect(
			fetchAIDetectionAnalysis(MINIMAL_REQUEST, DEFAULT_CONFIG),
		).rejects.toThrow(/anomalies/);
	});

	it('throws a ServiceError on network error', async () => {
		vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network failure'));

		await expect(
			fetchAIDetectionAnalysis(MINIMAL_REQUEST, DEFAULT_CONFIG),
		).rejects.toThrow(ServiceError);
	});

	it('re-throws an AbortError when the signal fires', async () => {
		const controller = new AbortController();
		vi.spyOn(global, 'fetch').mockRejectedValueOnce(
			new DOMException('The user aborted a request.', 'AbortError'),
		);

		controller.abort();

		await expect(
			fetchAIDetectionAnalysis(MINIMAL_REQUEST, DEFAULT_CONFIG, controller.signal),
		).rejects.toThrow(DOMException);
	});
});
