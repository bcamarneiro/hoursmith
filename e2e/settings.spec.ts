import { expect, test } from '@playwright/test';
import { openSettingsSection } from './helpers/settings';

test.describe('Settings Page', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/settings');
		await page.waitForLoadState('networkidle');
	});

	test('shows the real settings sections and offline defaults', async ({
		page,
	}) => {
		// The Settings redesign moved each fieldset behind a left rail, so a
		// section has to be opened before its fields are visible. Connection is
		// the section the page opens on.
		await expect(page.getByLabel('Jira Host')).toHaveValue(
			'mock.atlassian.net',
		);
		await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
			'dev@example.com',
		);
		await expect(page.getByLabel('API Token', { exact: true })).toHaveValue(
			'mock-token',
		);

		await openSettingsSection(page, 'Reports Scope');
		await expect(page.getByLabel(/JQL Filter/)).toBeVisible();

		await openSettingsSection(page, 'Permissions');
		await expect(page.getByLabel(/Allow adding worklogs/)).toBeVisible();

		await openSettingsSection(page, 'Preferences');
		await expect(page.getByLabel('Theme')).toBeVisible();

		// Backup / Share Pack / Import / Discard / Save live in the persistent
		// save bar, so they stay reachable whichever section is open.
		await expect(
			page.getByRole('button', { name: 'Backup', exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Share Pack' }),
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Import' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Discard' })).toBeDisabled();
		await expect(
			page.getByRole('button', { name: 'Save', exact: true }),
		).toBeDisabled();
	});

	test('enables discard and save for unsaved changes and can discard them', async ({
		page,
	}) => {
		await openSettingsSection(page, 'Reports Scope');
		const jqlInput = page.getByLabel(/JQL Filter/);
		await jqlInput.fill('project = PLAY');

		await expect(
			page.getByText('Unsaved changes', { exact: true }),
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Discard' })).toBeEnabled();
		await expect(
			page.getByRole('button', { name: 'Save', exact: true }),
		).toBeEnabled();

		await page.getByRole('button', { name: 'Discard' }).click();

		await expect(jqlInput).toHaveValue('');
		await expect(page.getByText('Settings up to date')).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Save', exact: true }),
		).toBeDisabled();
	});

	test('exports settings as a JSON backup', async ({ page }) => {
		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Backup', exact: true }).click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toBe('hoursmith-settings.json');
		const stream = await download.createReadStream();
		let content = '';
		if (stream) {
			for await (const chunk of stream) {
				content += chunk.toString();
			}
		}

		const parsed = JSON.parse(content);
		// Full-backup format bumped to v3 when userData (favorites/templates/
		// commentPresets/dayNotes/reportPresets) was added to the payload.
		expect(parsed.version).toBe(3);
		expect(parsed.config.jiraHost).toBe('mock.atlassian.net');
		expect(Array.isArray(parsed.calendarMappings)).toBe(true);
		expect(parsed.userData).toBeDefined();
	});

	test('imports settings backup into the form', async ({ page }) => {
		const fileInput = page.locator('input[type="file"]');

		await fileInput.setInputFiles({
			name: 'settings.json',
			mimeType: 'application/json',
			buffer: Buffer.from(
				JSON.stringify({
					version: 1,
					config: {
						jiraHost: 'imported.atlassian.net',
						email: 'imported@example.com',
						apiToken: 'imported-token',
						jqlFilter: 'project = IMPORT',
						theme: 'dark',
						timeRounding: '30m',
						calendarFeeds: [
							{
								label: 'Imported',
								url: 'https://calendar.example.com/feed.ics',
								type: 'suggestion',
							},
						],
					},
					calendarMappings: [
						{
							pattern: 'Planning',
							issueKey: 'IMP-42',
						},
					],
				}),
			),
		});

		await expect(
			page.getByText('Settings backup imported into the form'),
		).toBeVisible();
		await expect(page.getByLabel('Jira Host')).toHaveValue(
			'imported.atlassian.net',
		);
		await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
			'imported@example.com',
		);

		await openSettingsSection(page, 'Reports Scope');
		await expect(page.getByLabel(/JQL Filter/)).toHaveValue('project = IMPORT');

		await openSettingsSection(page, 'Preferences');
		await expect(page.getByLabel('Theme')).toHaveValue('dark');
		await expect(page.getByLabel('Time Rounding')).toHaveValue('30m');

		// Calendar mappings now sit inside the Services section of the rail.
		await openSettingsSection(page, 'Services');
		await expect(page.getByText('Planning', { exact: true })).toBeVisible();
		await expect(page.getByText('IMP-42', { exact: true })).toBeVisible();
	});
});
