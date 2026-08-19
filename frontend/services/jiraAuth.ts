/**
 * Single source of truth for the Jira `Authorization` header.
 *
 * The two deployment flavours want different schemes, and getting it wrong
 * fails in a way that reads like a permissions problem rather than an auth-shape
 * problem:
 *
 *   - **Cloud** (`*.atlassian.net`) rejects `Bearer <api-token>`. It wants Basic
 *     auth over `email:apiToken`, or a Bearer OAuth 2.0 (3LO) *access token* —
 *     which an `ATATT…` API token is not. Sending Bearer returns **403**, not
 *     401, so the UI reported "check the account's permissions" while the
 *     account's permissions were fine.
 *   - **Server / Data Center** uses personal access tokens in a Bearer header,
 *     and has no email to pair them with.
 *
 * Verified against a live Cloud instance on 2026-08-18 through the same CORS
 * proxy, same token, same endpoint: Bearer → 403, Basic → 200.
 *
 * The hosted Premium relay already got this right (it sends `X-Jira-Auth: Basic`
 * and the Edge function forwards it), so this only ever affected the direct and
 * self-hosted paths — i.e. every self-hosting Cloud user.
 */

import { isCloudJira } from './jiraSearch';

function encodeBasic(email: string, apiToken: string): string {
	const raw = `${email}:${apiToken}`;
	if (typeof btoa === 'function') return btoa(raw);
	return Buffer.from(raw, 'utf8').toString('base64');
}

export function jiraAuthHeader(
	jiraHost: string,
	email: string,
	apiToken: string,
): string {
	// Basic auth without the email half authenticates as nobody. Falling back to
	// Bearer at least surfaces Jira's own 401 instead of a malformed request.
	if (isCloudJira(jiraHost) && email.trim()) {
		return `Basic ${encodeBasic(email.trim(), apiToken)}`;
	}
	return `Bearer ${apiToken}`;
}
