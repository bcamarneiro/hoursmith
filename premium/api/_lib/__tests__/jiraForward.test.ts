import { describe, expect, it } from 'vitest';
import { validateJiraBase } from '../jiraForward';

describe('validateJiraBase — SSRF guard (ADA-296, self-hosted support)', () => {
	describe('accepts public HTTPS Jira hosts', () => {
		it('accepts a *.atlassian.net Jira Cloud site', () => {
			const r = validateJiraBase('https://example.atlassian.net');
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.url.hostname).toBe('example.atlassian.net');
		});

		it('accepts a self-hosted Jira on a public domain (the reported prod bug)', () => {
			const r = validateJiraBase('https://ticket.rsint.net');
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.url.hostname).toBe('ticket.rsint.net');
		});

		it('accepts a self-hosted host with a path and query', () => {
			const r = validateJiraBase(
				'https://jira.mycompany.com/rest/api/2/myself?x=1',
			);
			expect(r.ok).toBe(true);
		});
	});

	describe('rejects SSRF targets', () => {
		it.each([
			['loopback hostname', 'https://localhost'],
			['loopback IPv4', 'https://127.0.0.1'],
			['all-zeros IPv4', 'https://0.0.0.0'],
			['AWS metadata IP', 'https://169.254.169.254/latest/meta-data/'],
			['RFC-1918 10/8', 'https://10.0.0.5'],
			['RFC-1918 192.168/16', 'https://192.168.1.1'],
			['RFC-1918 172.16/12', 'https://172.16.0.1'],
			['public IPv4 literal (no DNS identity)', 'https://8.8.8.8'],
			['IPv6 loopback literal', 'https://[::1]'],
			['IPv6 link-local literal', 'https://[fe80::1]'],
			['IPv6 unique-local literal', 'https://[fc00::1]'],
			['single-label host (no dot)', 'https://jira'],
			['.local mDNS suffix', 'https://jira.local'],
			['.internal suffix', 'https://jira.internal'],
			['.lan suffix', 'https://jira.lan'],
			['*.localhost suffix', 'https://foo.localhost'],
			['private IP behind userinfo trick', 'https://x.atlassian.net@10.0.0.1'],
			['trailing-dot loopback hostname', 'https://localhost.'],
			['trailing-dot loopback IPv4', 'https://127.0.0.1.'],
			['trailing-dot internal suffix', 'https://jira.internal.'],
		])('rejects %s', (_label, base) => {
			const r = validateJiraBase(base);
			expect(r.ok).toBe(false);
		});
	});

	describe('rejects malformed or unsafe inputs', () => {
		it('rejects a missing header', () => {
			expect(validateJiraBase(undefined).ok).toBe(false);
			expect(validateJiraBase('').ok).toBe(false);
		});

		it('rejects a non-URL value', () => {
			expect(validateJiraBase('not a url').ok).toBe(false);
		});

		it('rejects non-https protocols (credentials must not travel plaintext)', () => {
			expect(validateJiraBase('http://jira.mycompany.com').ok).toBe(false);
			expect(validateJiraBase('ftp://example.atlassian.net').ok).toBe(false);
		});
	});
});
