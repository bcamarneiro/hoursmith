import { describe, expect, it } from 'vitest';
import { jiraAuthHeader } from '../jiraAuth';

/**
 * Jira Cloud rejects `Authorization: Bearer <api-token>`. It accepts Basic auth
 * with `email:apiToken`, or a Bearer OAuth 2.0 (3LO) access token — which an
 * `ATATT…` API token is not. Jira Server/DC is the opposite: personal access
 * tokens go in a Bearer header and there is no email to pair them with.
 *
 * Verified against a live Cloud instance on 2026-08-18 through the same CORS
 * proxy, same token, same endpoint: Bearer returned 403, Basic returned 200.
 */
describe('jiraAuthHeader', () => {
	const token = 'ATATT-example';
	const email = 'me@example.com';

	it('uses Basic auth for a Cloud host', () => {
		const header = jiraAuthHeader('acme.atlassian.net', email, token);
		expect(header).toBe(`Basic ${btoa(`${email}:${token}`)}`);
	});

	it('uses Bearer for a self-hosted Server/DC host', () => {
		expect(jiraAuthHeader('jira.acme.com', email, token)).toBe(
			`Bearer ${token}`,
		);
	});

	it('treats a Cloud host with a protocol prefix as Cloud', () => {
		expect(jiraAuthHeader('https://acme.atlassian.net', email, token)).toBe(
			`Basic ${btoa(`${email}:${token}`)}`,
		);
	});

	it('falls back to Bearer on Cloud when no email is configured', () => {
		// Basic auth without the email half authenticates as nobody; Bearer at
		// least produces Jira's own 401 rather than a silently malformed request.
		expect(jiraAuthHeader('acme.atlassian.net', '', token)).toBe(
			`Bearer ${token}`,
		);
	});
});
