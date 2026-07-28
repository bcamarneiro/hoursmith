// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionSection } from '../ConnectionSection';

describe('ConnectionSection', () => {
	it('renders the four connection inputs and the Test button', () => {
		render(
			<ConnectionSection
				formData={{
					jiraHost: 'example.atlassian.net',
					email: 'me@example.com',
					apiToken: 'tok',
					corsProxy: '',
				}}
				handleChange={vi.fn()}
				testJira={vi.fn()}
				canTestJira={true}
				integrationTest={{ loading: false, result: null }}
				jiraHostId="jh"
				emailId="em"
				apiTokenId="at"
				corsProxyId="cp"
			/>,
		);
		expect(screen.getByLabelText('Jira Host')).toHaveValue(
			'example.atlassian.net',
		);
		expect(screen.getByLabelText('Email')).toHaveValue('me@example.com');
		expect(screen.getByLabelText('API Token')).toHaveValue('tok');
		expect(screen.getByRole('button', { name: 'Test' })).toBeEnabled();
	});

	it('disables the Test button when canTestJira is false', () => {
		render(
			<ConnectionSection
				formData={{
					jiraHost: '',
					email: '',
					apiToken: '',
					corsProxy: '',
				}}
				handleChange={vi.fn()}
				testJira={vi.fn()}
				canTestJira={false}
				integrationTest={{ loading: false, result: null }}
				jiraHostId="jh"
				emailId="em"
				apiTokenId="at"
				corsProxyId="cp"
			/>,
		);
		expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled();
	});

	it('masks the API token by default and toggles reveal (ADA-446)', () => {
		render(
			<ConnectionSection
				formData={{
					jiraHost: 'h',
					email: 'e',
					apiToken: 'secret-token',
					corsProxy: '',
				}}
				handleChange={vi.fn()}
				testJira={vi.fn()}
				canTestJira={true}
				integrationTest={{ loading: false, result: null }}
				jiraHostId="jh"
				emailId="em"
				apiTokenId="at"
				corsProxyId="cp"
			/>,
		);
		const tokenInput = screen.getByLabelText('API Token');
		expect(tokenInput).toHaveAttribute('type', 'password');
		expect(tokenInput).toHaveAttribute('autocomplete', 'off');

		const toggle = screen.getByRole('button', { name: 'Show API token' });
		fireEvent.click(toggle);
		expect(screen.getByLabelText('API Token')).toHaveAttribute('type', 'text');

		fireEvent.click(screen.getByRole('button', { name: 'Hide API token' }));
		expect(screen.getByLabelText('API Token')).toHaveAttribute(
			'type',
			'password',
		);
	});

	it('offers an inline 3-step API-token walkthrough that keeps the Atlassian link in a new tab (ADA-468, ADA-484 #2)', () => {
		render(
			<ConnectionSection
				formData={{
					jiraHost: 'h',
					email: 'e',
					apiToken: 't',
					corsProxy: '',
				}}
				handleChange={vi.fn()}
				testJira={vi.fn()}
				canTestJira={true}
				integrationTest={{ loading: false, result: null }}
				jiraHostId="jh"
				emailId="em"
				apiTokenId="at"
				corsProxyId="cp"
			/>,
		);
		// The disclosure is inline (a <summary>), no longer a bare link that
		// navigates the user away mid-setup.
		expect(
			screen.getByText('How do I get an API token?').tagName.toLowerCase(),
		).toBe('summary');
		// Three walkthrough steps.
		expect(screen.getAllByRole('listitem')).toHaveLength(3);
		// The Atlassian page is still reachable — as the first step, in a new tab.
		const link = screen.getByRole('link', {
			name: /Atlassian API tokens page/i,
		});
		expect(link).toHaveAttribute(
			'href',
			'https://id.atlassian.com/manage-profile/security/api-tokens',
		);
		expect(link).toHaveAttribute('target', '_blank');
		expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
	});

	it('shows an inline hint for the Jira Host field (ADA-468)', () => {
		render(
			<ConnectionSection
				formData={{
					jiraHost: '',
					email: '',
					apiToken: '',
					corsProxy: '',
				}}
				handleChange={vi.fn()}
				testJira={vi.fn()}
				canTestJira={false}
				integrationTest={{ loading: false, result: null }}
				jiraHostId="jh"
				emailId="em"
				apiTokenId="at"
				corsProxyId="cp"
			/>,
		);
		expect(
			screen.getByText(/The domain you see in Jira, like/i),
		).toBeInTheDocument();
	});

	it('shows the integration test result message when present', () => {
		render(
			<ConnectionSection
				formData={{
					jiraHost: 'h',
					email: 'e',
					apiToken: 't',
					corsProxy: '',
				}}
				handleChange={vi.fn()}
				testJira={vi.fn()}
				canTestJira={true}
				integrationTest={{
					loading: false,
					result: { success: true, message: 'All good' },
				}}
				jiraHostId="jh"
				emailId="em"
				apiTokenId="at"
				corsProxyId="cp"
			/>,
		);
		expect(screen.getByText(/All good/)).toBeInTheDocument();
	});

	it('hides the proxy/network block behind a collapsed Advanced disclosure on first run, but keeps the field mounted (ADA-484 #1)', () => {
		render(
			<ConnectionSection
				formData={{
					jiraHost: 'h',
					email: 'e',
					apiToken: 't',
					corsProxy: '',
				}}
				handleChange={vi.fn()}
				testJira={vi.fn()}
				canTestJira={true}
				integrationTest={{ loading: false, result: null }}
				jiraHostId="jh"
				emailId="em"
				apiTokenId="at"
				corsProxyId="cp"
			/>,
		);
		const details = screen
			.getByText(/Advanced — proxy/)
			.closest('details') as HTMLDetailsElement;
		expect(details).not.toHaveAttribute('open');
		// Field parity: the CORS Proxy input is still in the DOM, just disclosed.
		expect(
			screen.getByPlaceholderText('http://localhost:8081'),
		).toBeInTheDocument();
	});

	it('opens the Advanced disclosure when a connection test reports a network block (ADA-484 #1/#4)', () => {
		render(
			<ConnectionSection
				formData={{
					jiraHost: 'h',
					email: 'e',
					apiToken: 't',
					corsProxy: '',
				}}
				handleChange={vi.fn()}
				testJira={vi.fn()}
				canTestJira={true}
				integrationTest={{
					loading: false,
					result: {
						success: false,
						message:
							'Your network is blocking direct browser access to Jira — set up a proxy below.',
					},
				}}
				jiraHostId="jh"
				emailId="em"
				apiTokenId="at"
				corsProxyId="cp"
			/>,
		);
		const details = screen
			.getByText(/Advanced — proxy/)
			.closest('details') as HTMLDetailsElement;
		expect(details).toHaveAttribute('open');
	});

	it('opens the Advanced disclosure for a returning user who already set a proxy (ADA-484 #1)', () => {
		render(
			<ConnectionSection
				formData={{
					jiraHost: 'h',
					email: 'e',
					apiToken: 't',
					corsProxy: 'http://localhost:8081',
				}}
				handleChange={vi.fn()}
				testJira={vi.fn()}
				canTestJira={true}
				integrationTest={{ loading: false, result: null }}
				jiraHostId="jh"
				emailId="em"
				apiTokenId="at"
				corsProxyId="cp"
			/>,
		);
		const details = screen
			.getByText(/Advanced — proxy/)
			.closest('details') as HTMLDetailsElement;
		expect(details).toHaveAttribute('open');
	});
});
