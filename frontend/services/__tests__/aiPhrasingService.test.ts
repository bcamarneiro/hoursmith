import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AI_PHRASING_SYSTEM_PROMPT,
	type AiPhrasingInput,
	containsNumericalValues,
	type PhrasingResult,
	phraseReason,
	sanitizeNumericalContent,
} from '../aiPhrasingService';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Stub an OpenAI‑compatible chat API response. */
function mockLlmResponse(
	content: string,
	status = 200,
): void {
	vi.spyOn(global, 'fetch').mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: async () => ({
			choices: [{ message: { content } }],
		}),
	} as Response);
}

/** Default test options — valid enough to reach the fetch mock. */
const defaultOptions = {
	apiUrl: 'https://api.example.com/v1/chat/completions',
	apiKey: 'sk-test-123',
};

/** Minimal input builder. */
function input(overrides: Partial<AiPhrasingInput> = {}): AiPhrasingInput {
	return { reason: 'PR review', ...overrides };
}

/* ------------------------------------------------------------------ */
/*  containsNumericalValues                                            */
/* ------------------------------------------------------------------ */

describe('containsNumericalValues', () => {
	describe('detects digits', () => {
		it('detects a lone digit', () => {
			expect(containsNumericalValues('fixed 5 bugs')).toBe(true);
		});

		it('detects multi-digit numbers', () => {
			expect(containsNumericalValues('reviewed 42 files')).toBe(true);
		});

		it('detects numbers embedded in text near punctuation', () => {
			expect(containsNumericalValues('took 2h, done.')).toBe(true);
		});
	});

	describe('detects spelled‑out numbers', () => {
		it.each([
			'one',
			'two',
			'three',
			'four',
			'five',
			'six',
			'seven',
			'eight',
			'nine',
			'ten',
			'eleven',
			'twelve',
			'thirteen',
			'twenty',
			'forty',
			'hundred',
			'thousand',
		])('detects "%s"', (word) => {
			expect(containsNumericalValues(`about ${word} items`)).toBe(true);
		});
	});

	describe('detects time formats', () => {
		it.each([
			'2h',
			'30m',
			'1.5h',
			'45 minutes',
			'3 hours',
			'10mins',
			'5hrs',
			'60sec',
		])('detects "%s"', (time) => {
			expect(containsNumericalValues(`worked ${time}`)).toBe(true);
		});
	});

	describe('detects clock times', () => {
		it.each(['14:30', '09:15am', '2:30pm', '14.30'])(
			'detects "%s"',
			(t) => {
				expect(containsNumericalValues(`at ${t}`)).toBe(true);
			},
		);
	});

	describe('detects percentages', () => {
		it.each(['50%', '100%', '12.5%'])('detects "%s"', (pct) => {
			expect(containsNumericalValues(`completed ${pct}`)).toBe(true);
		});
	});

	describe('detects monetary amounts', () => {
		it.each(['$50', '$ 100', '$1,200.50'])(
			'detects "%s"',
			(amount) => {
				expect(containsNumericalValues(`cost ${amount}`)).toBe(true);
			},
		);
	});

	describe('detects dates', () => {
		it.each([
			'2024-01-15',
			'2024/01/15',
			'01/15/2024',
			'15-01-2024',
		])('detects "%s"', (date) => {
			expect(containsNumericalValues(`on ${date}`)).toBe(true);
		});
	});

	describe('detects count‑pattern nouns', () => {
		it.each([
			'4 files',
			'2 items',
			'3 tickets',
			'1 issue',
			'5 PRs',
			'12 commits',
			'8 changes',
			'10 pages',
			'6 users',
			'15 members',
		])('detects "%s"', (phrase) => {
			expect(containsNumericalValues(phrase)).toBe(true);
		});
	});

	describe('clean text returns false', () => {
		it('returns false for text with no numbers', () => {
			expect(
				containsNumericalValues(
					'Reviewed a pull request for the authentication module.',
				),
			).toBe(false);
		});

		it('returns false for empty string', () => {
			expect(containsNumericalValues('')).toBe(false);
		});

		it('returns false for text with only special characters', () => {
			expect(containsNumericalValues('Hello — world!')).toBe(false);
		});

		it('returns false for Jira key alone (letters + hyphen only)', () => {
			// "ADA-588" has a digit — so this WILL be caught by /\d/
			// But PROJ-XYZ has no digits
			expect(containsNumericalValues('PROJ-XYZ')).toBe(false);
		});

		it('returns false for text with only words', () => {
			expect(
				containsNumericalValues(
					'Debugged and fixed an issue in the login flow.',
				),
			).toBe(false);
		});
	});
});

/* ------------------------------------------------------------------ */
/*  sanitizeNumericalContent                                           */
/* ------------------------------------------------------------------ */

describe('sanitizeNumericalContent', () => {
	it('strips time durations', () => {
		expect(
			sanitizeNumericalContent('worked 2h on the feature'),
		).toBe('worked on the feature');
	});

	it('strips standalone numbers', () => {
		expect(
			sanitizeNumericalContent('reviewed 42 files today'),
		).toBe('reviewed files today');
	});

	it('strips clock times', () => {
		expect(
			sanitizeNumericalContent('meeting at 14:30 finished'),
		).toBe('meeting at finished');
	});

	it('strips percentages', () => {
		expect(sanitizeNumericalContent('done 75%')).toBe('done');
	});

	it('strips dollar amounts', () => {
		expect(sanitizeNumericalContent('cost $ 100 total')).toBe(
			'cost total',
		);
	});

	it('handles empty string', () => {
		expect(sanitizeNumericalContent('')).toBe('');
	});

	it('handles text with no numerical content', () => {
		const clean = 'Reviewed a pull request.';
		expect(sanitizeNumericalContent(clean)).toBe(clean);
	});

	it('strips mixed numerical patterns', () => {
		expect(
			sanitizeNumericalContent(
				'fixed 3 bugs in 2h, completed 75% by 2024-01-15',
			),
		).toBe('fixed bugs in , completed by');
	});

	it('collapses multiple spaces', () => {
		expect(
			sanitizeNumericalContent('fixed  3  bugs'),
		).toBe('fixed bugs');
	});
});

/* ------------------------------------------------------------------ */
/*  phraseReason                                                       */
/* ------------------------------------------------------------------ */

describe('phraseReason', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('happy path', () => {
		it('returns phrased result when LLM replies with clean text', async () => {
			mockLlmResponse('Reviewed a pull request for authentication.');

			const result = await phraseReason(
				input({ reason: 'PR review for AUTH-42, 2h' }),
				defaultOptions,
			);

			expect(result.original).toBe('PR review for AUTH-42, 2h');
			expect(result.phrased).toBe(
				'Reviewed a pull request for authentication.',
			);
			expect(result.validated).toBe(true);
		});

		it('passes reason, issueKey and issueSummary to the LLM', async () => {
			mockLlmResponse('Fixed a login issue.');

			await phraseReason(
				input({
					reason: 'Bug fix',
					issueKey: 'LOGIN-42',
					issueSummary: 'Users cannot log in',
				}),
				defaultOptions,
			);

			expect(fetch).toHaveBeenCalledOnce();

			const body = JSON.parse(
				(fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
			);
			expect(body.messages[1].content).toContain('LOGIN-42');
			expect(body.messages[1].content).toContain(
				'Users cannot log in',
			);
		});

		it('sends the system prompt as the first message', async () => {
			mockLlmResponse('Some phrasing.');

			await phraseReason(input(), defaultOptions);

			const body = JSON.parse(
				(fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
			);
			expect(body.messages[0].role).toBe('system');
			expect(body.messages[0].content).toBe(AI_PHRASING_SYSTEM_PROMPT);
		});
	});

	describe('validation guard', () => {
		it('sanitises output when LLM returns numbers and sets validated=false', async () => {
			mockLlmResponse('Fixed 3 bugs in the login flow, took 2h.');

			const result = await phraseReason(
				input({ reason: 'Bug fix, 3 bugs, 2h' }),
				defaultOptions,
			);

			expect(result.validated).toBe(false);
			// Should have numbers removed
			expect(result.phrased).not.toMatch(/\d/);
			expect(result.phrased).toContain('login flow');
		});

		it('preserves original when validation passes', async () => {
			const clean = 'Debugged and fixed an issue in the auth flow.';
			mockLlmResponse(clean);

			const result = await phraseReason(
				input({ reason: '30m debugging auth flow' }),
				defaultOptions,
			);

			expect(result.phrased).toBe(clean);
			expect(result.validated).toBe(true);
		});
	});

	describe('HTTP error handling', () => {
		it('throws ServiceError on HTTP 401', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValue({
				ok: false,
				status: 401,
				json: async () => ({}),
			} as Response);

			await expect(
				phraseReason(input(), defaultOptions),
			).rejects.toThrow('HTTP 401');
		});

		it('throws ServiceError on HTTP 500', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValue({
				ok: false,
				status: 500,
				json: async () => ({}),
			} as Response);

			await expect(
				phraseReason(input(), defaultOptions),
			).rejects.toThrow('HTTP 500');
		});
	});

	describe('network error handling', () => {
		it('throws ServiceError on network failure', async () => {
			vi.spyOn(global, 'fetch').mockRejectedValue(
				new TypeError('Failed to fetch'),
			);

			await expect(
				phraseReason(input(), defaultOptions),
			).rejects.toThrow('Failed to fetch');
		});

		it('throws ServiceError with network kind', async () => {
			vi.spyOn(global, 'fetch').mockRejectedValue(
				new TypeError('Failed to fetch'),
			);

			await expect(
				phraseReason(input(), defaultOptions),
			).rejects.toMatchObject({ kind: 'network' });
		});
	});

	describe('malformed response handling', () => {
		it('throws ServiceError on empty JSON body', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({}),
			} as Response);

			await expect(
				phraseReason(input(), defaultOptions),
			).rejects.toThrow('Empty response');
		});

		it('throws ServiceError on missing choices array', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ choices: [] }),
			} as Response);

			await expect(
				phraseReason(input(), defaultOptions),
			).rejects.toThrow('Empty response');
		});

		it('throws ServiceError on invalid JSON', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => {
					throw new SyntaxError('Unexpected token');
				},
			} as Response);

			await expect(
				phraseReason(input(), defaultOptions),
			).rejects.toThrow('Invalid JSON');
		});
	});

	describe('request shape', () => {
		it('sends POST to the configured apiUrl', async () => {
			mockLlmResponse('ok');

			await phraseReason(input(), {
				apiUrl: 'https://llm.example.com/chat',
				apiKey: 'sk-xyz',
			});

			expect(fetch).toHaveBeenCalledWith(
				'https://llm.example.com/chat',
				expect.objectContaining({ method: 'POST' }),
			);
		});

		it('includes Authorization header when apiKey is provided', async () => {
			mockLlmResponse('ok');

			await phraseReason(
				input(),
				{ apiUrl: 'https://example.com/api', apiKey: 'sk-test' },
			);

			const headers = (
				fetch as ReturnType<typeof vi.fn>
			).mock.calls[0][1].headers;
			expect(headers.Authorization).toBe('Bearer sk-test');
		});

		it('omits Authorization header when apiKey is not provided', async () => {
			mockLlmResponse('ok');

			await phraseReason(
				input(),
				{ apiUrl: 'https://example.com/api' },
			);

			const headers = (
				fetch as ReturnType<typeof vi.fn>
			).mock.calls[0][1].headers;
			expect(headers.Authorization).toBeUndefined();
		});

		it('sends the configured model name', async () => {
			mockLlmResponse('ok');

			await phraseReason(
				input(),
				{
					apiUrl: 'https://example.com/api',
					model: 'gpt-4',
				},
			);

			const body = JSON.parse(
				(fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
			);
			expect(body.model).toBe('gpt-4');
		});

		it('defaults model to gpt-4o-mini', async () => {
			mockLlmResponse('ok');

			await phraseReason(input(), defaultOptions);

			const body = JSON.parse(
				(fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
			);
			expect(body.model).toBe('gpt-4o-mini');
		});

		it('sends low temperature and reasonable max_tokens', async () => {
			mockLlmResponse('ok');

			await phraseReason(input(), defaultOptions);

			const body = JSON.parse(
				(fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
			);
			expect(body.temperature).toBe(0.3);
			expect(body.max_tokens).toBe(150);
		});
	});

	describe('AbortSignal', () => {
		it('passes the signal through to fetch', async () => {
			mockLlmResponse('ok');

			const controller = new AbortController();
			await phraseReason(
				input(),
				{ ...defaultOptions, signal: controller.signal },
			);

			const opts = (
				fetch as ReturnType<typeof vi.fn>
			).mock.calls[0][1];
			expect(opts.signal).toBe(controller.signal);
		});
	});
});
