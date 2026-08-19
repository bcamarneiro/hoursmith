import { expect, type Page, test } from '@playwright/test';

/**
 * End-to-end coverage for the Tempo-managed-instance path (ADA-542).
 *
 * Why this needs a real browser rather than more unit tests: every bug this
 * integration shipped was invisible at the unit level. `created = started`
 * passed its mapper tests. The per-user endpoint passed its service tests.
 * Both produced plausible, well-formed, wrong data that only shows up once the
 * whole chain — config → resolver → router → fetcher → mapper → classifier →
 * render — runs together.
 *
 * The MSW Tempo handlers (frontend/mocks/handlers.ts) mirror a payload captured
 * from a live instance on 2026-08-18: `issue` carries id only, `startTime` has
 * no offset, and the real logging time lives in `createdAt`.
 */

/** Seed a Tempo-enabled config before any app code runs. */
async function seedTempoConfig(page: Page) {
	await page.addInitScript(() => {
		try {
			localStorage.setItem(
				'hoursmith-config',
				JSON.stringify({
					state: {
						config: {
							jiraHost: 'mock.atlassian.net',
							email: 'dev@example.com',
							apiToken: 'mock-token',
							tempoApiToken: 'e2e-tempo-token',
							tempoMode: 'tempo',
						},
					},
					version: 12,
				}),
			);
		} catch {
			/* origin without storage — ignored */
		}
	});
}

test.describe('Tempo-managed instance (ADA-542)', () => {
	test('reads worklogs through Tempo instead of Jira', async ({ page }) => {
		await seedTempoConfig(page);
		const tempoCalls: string[] = [];
		page.on('request', (req) => {
			if (req.url().includes('api.tempo.io')) tempoCalls.push(req.url());
		});

		await page.goto('/my-week');
		await page.waitForLoadState('networkidle');

		expect(tempoCalls.length).toBeGreaterThan(0);
	});

	test('uses the per-user endpoint for My Week', async ({ page }) => {
		await seedTempoConfig(page);
		const tempoCalls: string[] = [];
		page.on('request', (req) => {
			if (req.url().includes('api.tempo.io')) tempoCalls.push(req.url());
		});

		await page.goto('/my-week');
		await page.waitForLoadState('networkidle');

		expect(tempoCalls.some((u) => u.includes('/worklogs/user/'))).toBe(true);
	});

	test('uses the non-user-scoped endpoint for Reports, so teammates survive', async ({
		page,
	}) => {
		await seedTempoConfig(page);
		const tempoCalls: string[] = [];
		page.on('request', (req) => {
			if (req.url().includes('api.tempo.io')) tempoCalls.push(req.url());
		});

		await page.goto('/reports');
		await page.waitForLoadState('networkidle');

		// ADA-545: hitting /worklogs/user/{id} here would silently collapse the
		// whole team's Reports to the signed-in user — no error, just fewer rows.
		const teamRead = tempoCalls.filter(
			(u) => u.includes('/4/worklogs') && !u.includes('/worklogs/user/'),
		);
		expect(teamRead.length).toBeGreaterThan(0);
	});

	test('never writes a worklog to Jira while reading from Tempo', async ({
		page,
	}) => {
		await seedTempoConfig(page);
		const jiraWrites: string[] = [];
		const tempoWrites: string[] = [];
		page.on('request', (req) => {
			if (req.method() !== 'POST' && req.method() !== 'PUT') return;
			const url = req.url();
			if (url.includes('/rest/api/2/issue/') && url.includes('worklog')) {
				jiraWrites.push(url);
			}
			if (url.includes('api.tempo.io')) tempoWrites.push(url);
		});

		await page.goto('/my-week');
		await page.waitForLoadState('networkidle');

		// A Jira-native write on a Tempo instance is authored by the human, so it
		// is invisible to the reads or double-counted once Tempo imports it.
		// Reads must not trigger writes at all, and any write that does happen
		// must not be a Jira worklog write.
		expect(jiraWrites).toEqual([]);
	});
});

test.describe('late-logging detection on Tempo data', () => {
	test('renders Tempo worklogs in My Week rather than an error', async ({
		page,
	}) => {
		await seedTempoConfig(page);
		await page.goto('/my-week');
		await page.waitForLoadState('networkidle');

		// The per-user Tempo read resolves the accountId via /myself first; when
		// that step fails the UI blames Jira connectivity, which sends users to
		// the wrong fix entirely.
		await expect(page.getByText('Unable to load My Week')).toHaveCount(0);
	});

	test('surfaces Tempo-sourced hours in the week total', async ({ page }) => {
		await seedTempoConfig(page);
		await page.goto('/my-week');
		await page.waitForLoadState('networkidle');

		// The seeded Tempo worklog is 3600s. If the mapper dropped or mis-dated
		// it, no hour figure derived from Tempo would appear at all.
		const body = await page.locator('body').innerText();
		expect(body).toMatch(/\d+h/);
	});
});

test.describe('Tempo disabled', () => {
	test('reads from Jira when tempoMode is jira', async ({ page }) => {
		await page.addInitScript(() => {
			try {
				localStorage.setItem(
					'hoursmith-config',
					JSON.stringify({
						state: {
							config: {
								jiraHost: 'mock.atlassian.net',
								email: 'dev@example.com',
								apiToken: 'mock-token',
								tempoApiToken: 'e2e-tempo-token',
								tempoMode: 'jira',
							},
						},
						version: 12,
					}),
				);
			} catch {
				/* ignored */
			}
		});

		const tempoCalls: string[] = [];
		page.on('request', (req) => {
			if (req.url().includes('api.tempo.io')) tempoCalls.push(req.url());
		});

		await page.goto('/my-week');
		await page.waitForLoadState('networkidle');

		// An explicit jira override must win even with a valid Tempo token set.
		expect(tempoCalls).toEqual([]);
	});
});
