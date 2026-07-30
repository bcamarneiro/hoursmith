/**
 * AI Detection API Client (ADA-622).
 *
 * Client for the AI Detection service that analyses time entries for
 * anomalies — mismatched descriptions, implausible durations, duplicates,
 * off-hours entries, and other quality signals.
 *
 * The service is fully optional. When disabled or unconfigured,
 * `fetchAnalysis` returns null without making a network request.
 *
 * SECURITY — API KEY EXPOSURE:
 * The API key is sent as a Bearer token in the Authorization header.
 * When `corsProxy` is configured, the entire request — including the
 * Authorization header — is proxied through the user-configured CORS
 * proxy. Only use a trusted proxy. Never log the request URL, headers,
 * or apiKey.
 */

import type {
	AIDetectionErrorResponse,
	AIDetectionRequest,
	AIDetectionResponse,
} from '../../types/AIDetection';
import {
	fromHttpResponse,
	fromHttpResponseAsync,
	fromNetworkError,
	ServiceError,
} from './serviceErrors';

/** Configuration injected by the caller (sourced from ConfigStore). */
export interface AIDetectionConfig {
	/** Whether AI detection is enabled in settings. */
	enabled: boolean;
	/** API key for the AI Detection service. */
	apiKey: string;
	/** Base URL for the AI Detection API (with no trailing slash). */
	endpoint: string;
	/** Optional CORS proxy URL for environments that block direct fetch. */
	corsProxy?: string;
}

/**
 * Validate the response body shape from the AI Detection API.
 * Throws a ServiceError if the shape is unrecognisable so callers
 * never silently consume a malformed response.
 */
function validateResponse(body: unknown): AIDetectionResponse {
	if (!body || typeof body !== 'object') {
		throw new ServiceError({
			kind: 'unknown',
			source: 'AIDetection',
			message: 'AI Detection response malformed: expected a JSON object',
		});
	}

	const parsed = body as Record<string, unknown>;

	if (typeof parsed.detected !== 'boolean') {
		throw new ServiceError({
			kind: 'unknown',
			source: 'AIDetection',
			message:
				'AI Detection response malformed: missing or invalid "detected" field',
		});
	}

	if (!Array.isArray(parsed.anomalies)) {
		throw new ServiceError({
			kind: 'unknown',
			source: 'AIDetection',
			message:
				'AI Detection response malformed: missing or invalid "anomalies" array',
		});
	}

	if (!Array.isArray(parsed.suggestions)) {
		throw new ServiceError({
			kind: 'unknown',
			source: 'AIDetection',
			message:
				'AI Detection response malformed: missing or invalid "suggestions" array',
		});
	}

	if (typeof parsed.confidence !== 'number') {
		throw new ServiceError({
			kind: 'unknown',
			source: 'AIDetection',
			message:
				'AI Detection response malformed: missing or invalid "confidence" field',
		});
	}

	return parsed as unknown as AIDetectionResponse;
}

/**
 * Build the full request URL, optionally wrapping through a CORS proxy.
 */
function buildRequestUrl(baseUrl: string, corsProxy?: string): string {
	return corsProxy
		? `${corsProxy.replace(/\/+$/, '')}/${baseUrl.replace(/^\/+/, '')}`
		: baseUrl;
}

/**
 * Analyse a single time entry via the AI Detection API.
 *
 * Returns `null` when the service is disabled, the API key is empty, or the
 * endpoint is not configured — no network request is made. Throws a typed
 * `ServiceError` for HTTP errors, network failures, or malformed responses.
 *
 * @param request - The time entry to analyse, with optional sibling entries.
 * @param config - API configuration from the user's settings.
 * @param signal - Optional AbortSignal for request cancellation.
 */
export async function fetchAIDetectionAnalysis(
	request: AIDetectionRequest,
	config: AIDetectionConfig,
	signal?: AbortSignal,
): Promise<AIDetectionResponse | null> {
	// Guard: disabled or unconfigured — no request, no error.
	if (!config.enabled || !config.apiKey || !config.endpoint) {
		return null;
	}

	const url = buildRequestUrl(
		`${config.endpoint}/api/v1/analyze`,
		config.corsProxy,
	);

	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify(request),
			signal,
		});
	} catch (error) {
		// Preserve ServiceError and AbortError; wrap everything else as network.
		if (error instanceof ServiceError) throw error;
		if (error instanceof DOMException && error.name === 'AbortError') {
			throw error;
		}
		if (error instanceof Error && error.name === 'AbortError') throw error;
		throw fromNetworkError('AIDetection', error);
	}

	if (!res.ok) {
		// Try to parse the error body for a machine-readable code.
		const body: unknown = await res.json().catch(() => undefined);
		const errBody = body as AIDetectionErrorResponse | undefined;
		const code = errBody?.error?.code;

		if (res.status === 401) {
			throw new ServiceError({
				kind: 'invalid-token',
				status: 401,
				source: 'AIDetection',
				message: code
					? `AI Detection rejected the API key (401): ${code}`
					: 'AI Detection rejected the API key (401). Check the key in Settings.',
			});
		}

		if (res.status === 403) {
			throw new ServiceError({
				kind: 'forbidden',
				status: 403,
				source: 'AIDetection',
				message: 'AI Detection access denied (403). Check your subscription status.',
			});
		}

		if (res.status === 422) {
			const detail =
				errBody?.error?.message || 'unprocessable time-entry data';
			throw new ServiceError({
				kind: 'unknown',
				status: 422,
				source: 'AIDetection',
				message: `AI Detection rejected the request (422): ${detail}`,
			});
		}

		if (res.status === 429) {
			throw new ServiceError({
				kind: 'rate-limited',
				status: 429,
				source: 'AIDetection',
				message:
					'AI Detection rate limit exceeded (429). Please wait and retry.',
			});
		}

		throw await fromHttpResponseAsync('AIDetection', res);
	}

	const body: unknown = await res.json();
	return validateResponse(body);
}
