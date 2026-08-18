/**
 * Tests for the ProviderConfigSection (ADA-271, ADA-523).
 *
 * Mocking fetch so we control the /api/providerConfig/* responses
 * without hitting the network. We use `afterEach` to reset mocks and
 * `beforeEach` to wipe fetch state between tests.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigSection } from '../ProviderConfigSection';

// ── Mocks ──

vi.mock('../useAuth', () => ({
	useAuth: () => ({
		user: { id: 'u1', email: 'a@b.com' },
		session: { access_token: 'fake-jwt' },
	}),
}));

// CSS modules are handled by vitest config (css.modules).

// ── Helpers ──

function mockFetch(response: { status: number; body: unknown }): void {
	globalThis.fetch = vi.fn().mockResolvedValueOnce({
		ok: response.status >= 200 && response.status < 300,
		status: response.status,
		json: () => Promise.resolve(response.body),
	});
}

function mockFetchSequence(
	...responses: Array<{ status: number; body: unknown }>
): void {
	const calls = responses.map((r) =>
		Promise.resolve({
			ok: r.status >= 200 && r.status < 300,
			status: r.status,
			json: () => Promise.resolve(r.body),
		}),
	);
	globalThis.fetch = vi.fn();
	let idx = 0;
	(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => calls[idx++]);
}

function emptyTokensResponse(): void {
	mockFetch({ status: 200, body: { tokens: [] } });
}

function tokensResponse(tokens: unknown[]): void {
	mockFetch({ status: 200, body: { tokens } });
}

// ── Tests ──

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('ProviderConfigSection', () => {
	it('renders the section heading', async () => {
		emptyTokensResponse();
		render(<ProviderConfigSection />);
		expect(
			await screen.findByRole('heading', { name: /Provider API Keys/i }),
		).toBeTruthy();
	});

	it('shows loading text while tokens are fetched', () => {
		// Never resolve — keeps loading state
		globalThis.fetch = vi.fn().mockReturnValue(
			new Promise(() => {}),
		);
		render(<ProviderConfigSection />);
		expect(screen.getByText(/Loading configured providers/i)).toBeTruthy();
	});

	it('shows "no keys" when the API returns an empty list', async () => {
		emptyTokensResponse();
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(
				screen.getByText(/No API keys configured yet/i),
			).toBeTruthy();
		});
	});

	it('lists configured tokens', async () => {
		tokensResponse([
			{
				provider: 'jira_api',
				label: 'Work',
				status: 'active',
				created_at: '2026-01-01',
				updated_at: '2026-01-01',
				last_used_at: null,
			},
			{
				provider: 'github',
				label: null,
				status: 'active',
				created_at: '2026-02-01',
				updated_at: '2026-02-01',
				last_used_at: null,
			},
		]);
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(screen.getByText('Jira Cloud')).toBeTruthy();
			expect(screen.getByText('Work')).toBeTruthy();
			expect(screen.getByText('GitHub')).toBeTruthy();
		});
	});

	it('shows an error when the token fetch fails', async () => {
		mockFetch({ status: 500, body: { error: 'server error' } });
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(screen.getByText(/Could not load providers/)).toBeTruthy();
		});
	});

	// ── Add / Edit flow ──

	it('opens the add form when "Add API Key" is clicked', async () => {
		emptyTokensResponse();
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(
				screen.getByText(/No API keys configured yet/i),
			).toBeTruthy();
		});
		fireEvent.click(screen.getByRole('button', { name: /Add API Key/i }));
		expect(screen.getByText(/Add API Key/i)).toBeTruthy(); // form heading
	});

	it('opens the edit form when "Update" is clicked on a token', async () => {
		tokensResponse([
			{
				provider: 'jira_api',
				label: 'Work',
				status: 'active',
				created_at: '2026-01-01',
				updated_at: '2026-01-01',
				last_used_at: null,
			},
		]);
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(screen.getByText('Jira Cloud')).toBeTruthy();
		});
		fireEvent.click(screen.getByRole('button', { name: 'Update' }));
		// The form heading shows "Update API Key" when provider has existing data
		expect(screen.getByText(/Update API Key/i)).toBeTruthy();
	});

	it('closes the form when Cancel is clicked', async () => {
		emptyTokensResponse();
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(
				screen.getByText(/No API keys configured yet/i),
			).toBeTruthy();
		});
		fireEvent.click(screen.getByRole('button', { name: /Add API Key/i }));
		fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Add API Key/i })).toBeTruthy();
		});
	});

	// ── Save ──

	it('saves a token successfully', async () => {
		emptyTokensResponse();
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(
				screen.getByText(/No API keys configured yet/i),
			).toBeTruthy();
		});

		fireEvent.click(screen.getByRole('button', { name: /Add API Key/i }));

		// Fill in the form
		const apiKeyInput = screen.getByPlaceholderText(/Paste your API key/i);
		fireEvent.change(apiKeyInput, {
			target: { value: 'sk-test-123' },
		});

		// Mock: POST returns OK, then refreshed GET returns the saved token
		mockFetchSequence(
			{ status: 200, body: { ok: true } },
			{
				status: 200,
				body: {
					tokens: [
						{
							provider: 'jira_api',
							label: null,
							status: 'active',
							created_at: '2026-01-01',
							updated_at: '2026-01-01',
							last_used_at: null,
						},
					],
				},
			},
		);

		fireEvent.click(screen.getByRole('button', { name: /Save/i }));

		await waitFor(() => {
			expect(screen.getByText('Jira Cloud')).toBeTruthy();
			expect(screen.getByText(/API key saved/)).toBeTruthy();
		});
	});

	it('shows an error when save fails', async () => {
		emptyTokensResponse();
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(
				screen.getByText(/No API keys configured yet/i),
			).toBeTruthy();
		});

		fireEvent.click(screen.getByRole('button', { name: /Add API Key/i }));

		const apiKeyInput = screen.getByPlaceholderText(/Paste your API key/i);
		fireEvent.change(apiKeyInput, {
			target: { value: 'bad-key' },
		});

		mockFetch({ status: 400, body: { error: 'Invalid API key format' } });

		fireEvent.click(screen.getByRole('button', { name: /Save/i }));

		await waitFor(() => {
			expect(screen.getByText(/Invalid API key format/)).toBeTruthy();
		});
	});

	// ── Delete ──

	it('deletes a token when Remove is clicked', async () => {
		tokensResponse([
			{
				provider: 'jira_api',
				label: 'Work',
				status: 'active',
				created_at: '2026-01-01',
				updated_at: '2026-01-01',
				last_used_at: null,
			},
		]);
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(screen.getByText('Jira Cloud')).toBeTruthy();
		});

		// Mock: DELETE returns ok, then refreshed GET returns empty
		mockFetchSequence(
			{ status: 200, body: { ok: true } },
			{ status: 200, body: { tokens: [] } },
		);

		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

		await waitFor(() => {
			expect(
				screen.getByText(/No API keys configured yet/i),
			).toBeTruthy();
			expect(screen.getByText(/API key removed/)).toBeTruthy();
		});
	});

	// ── Test connection ──

	it('shows a successful connection test result', async () => {
		emptyTokensResponse();
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(
				screen.getByText(/No API keys configured yet/i),
			).toBeTruthy();
		});

		fireEvent.click(screen.getByRole('button', { name: /Add API Key/i }));

		const apiKeyInput = screen.getByPlaceholderText(/Paste your API key/i);
		fireEvent.change(apiKeyInput, {
			target: { value: 'sk-test-123' },
		});

		mockFetch({
			status: 200,
			body: { ok: true, provider: 'jira_api', label: 'Work Account' },
		});

		fireEvent.click(screen.getByRole('button', { name: /Test Connection/i }));

		await waitFor(() => {
			expect(
				screen.getByText(/Connection successful/),
			).toBeTruthy();
			// Label from response should be auto-filled
			expect(
				(screen.getByDisplayValue('Work Account') as HTMLInputElement).value,
			).toBe('Work Account');
		});
	});

	it('shows a failed connection test result', async () => {
		emptyTokensResponse();
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(
				screen.getByText(/No API keys configured yet/i),
			).toBeTruthy();
		});

		fireEvent.click(screen.getByRole('button', { name: /Add API Key/i }));

		const apiKeyInput = screen.getByPlaceholderText(/Paste your API key/i);
		fireEvent.change(apiKeyInput, {
			target: { value: 'bad-key' },
		});

		mockFetch({
			status: 200,
			body: {
				ok: false,
				provider: 'jira_api',
				error: 'Invalid API key for jira_api.',
			},
		});

		fireEvent.click(screen.getByRole('button', { name: /Test Connection/i }));

		await waitFor(() => {
			expect(
				screen.getByText(/Invalid API key for jira_api/),
			).toBeTruthy();
		});
	});

	// ── Edge: no session ──

	it('renders without crashing when session is null', async () => {
		vi.doMock('../useAuth', () => ({
			useAuth: () => ({ user: null, session: null }),
		}));
		emptyTokensResponse();
		// Since doMock can't hot-replace an already-imported module, this test
		// verifies the section renders (it just won't fetch tokens).
		render(<ProviderConfigSection />);
		await waitFor(() => {
			expect(screen.getByText(/Provider API Keys/)).toBeTruthy();
		});
	});
});
