import { expect, test } from '@playwright/test';
import { ErrorModal } from './helpers/errorModal';

/**
 * Error-modal E2E coverage.
 *
 * The app has no dedicated "Error"-titled modal: every modal is the shared
 * `Modal` component (a native `<dialog>`), and worklog create/update failures
 * surface as an inline error message inside the open Add/Edit worklog modal —
 * the modal stays open on failure.
 *
 * These tests drive the real failing-worklog case (client-side validation:
 * empty issue key) and assert the modal's accessibility contract through the
 * reusable ErrorModal page object.
 */
test.describe('Error modal — worklog create failure', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/dashboard');
		await page.waitForLoadState('networkidle');
	});

	test('submit with empty issue key keeps modal open and shows inline error', async ({
		page,
	}) => {
		// Open the Add worklog modal for a workday (weekend cards hide the button).
		await page
			.getByRole('button', { name: /Add a worklog for/ })
			.filter({ visible: true })
			.first()
			.click();

		const modal = new ErrorModal(page);
		await modal.expectVisible();

		// The modal title is the Add-worklog heading (day of week + date).
		await modal.expectAccessibleTitle(/^Add worklog — /);

		// Guarantee a valid time-spent value so the only validation failure is
		// the empty issue key (some mock days have a zero gap, which would leave
		// the required time-spent field empty and trip native validation first).
		// Scope to the dialog: the page also has a TemplatesManager "Time Spent" input.
		await modal.dialog.getByLabel('Time Spent').fill('1h');

		// Submit with an empty issue key → client-side validation error.
		await page.getByRole('button', { name: 'Create Worklog' }).click();

		// Full accessibility contract for the error state: dialog stays open,
		// the aria-labelledby title and labelled close button are intact, and
		// the inline error message is visible in the modal body.
		await modal.expectAccessible({
			title: /^Add worklog — /,
			message: 'Issue key is required',
		});

		// The failure never auto-closes the modal; it dismisses only via the
		// labelled close button.
		await modal.dismiss();
		await modal.expectClosed();
		await expect(page.getByText('Issue key is required')).toBeHidden();
	});
});
