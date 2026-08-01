import { expect, type Locator, type Page } from '@playwright/test';

export type ErrorModalOptions = {
	/** Expected modal title (accessible name of the dialog). */
	title?: string | RegExp;
	/** Expected inline error message shown inside the modal body. */
	message?: string | RegExp;
};

/**
 * ErrorModal page object.
 *
 * The hoursmith frontend renders every modal through the shared `Modal`
 * component (`frontend/react/components/ui/Modal.tsx`), which outputs a native
 * `<dialog>` with:
 *   - `aria-labelledby` pointing at an `<h2>` title heading
 *   - a close `<button aria-label="Close">`
 *   - a content div holding the children
 *
 * Error surfaces that use this modal:
 *   - Add/Edit worklog (DayCard): on submit failure the modal stays open and
 *     WorklogForm renders an inline error message (client-side validation or
 *     the API error text on a failed save). There is no dedicated
 *     "Error"-titled modal in the app, so "error modal" == the open modal
 *     whose body shows the failure message.
 *
 * The methods below are the reusable accessibility contract an error modal
 * must satisfy. Individual assertions are split out so callers can pick just
 * the ones they need.
 */
export class ErrorModal {
	readonly dialog: Locator;
	readonly titleHeading: Locator;
	readonly closeButton: Locator;

	constructor(readonly page: Page) {
		// Only the open native <dialog> is visible; once `close()` runs the
		// `open` attribute is removed and the UA hides the dialog.
		this.dialog = page.locator('dialog[open]');
		this.titleHeading = this.dialog.locator('h2');
		this.closeButton = this.dialog.getByRole('button', { name: 'Close' });
	}

	/** The error modal is open and visible. */
	async expectVisible(): Promise<void> {
		await expect(this.dialog).toBeVisible();
	}

	/** The modal has been closed (dismissed, backdrop click, or Escape). */
	async expectClosed(): Promise<void> {
		await expect(this.dialog).toBeHidden();
	}

	/**
	 * The modal title is exposed as the dialog's accessible name:
	 * `aria-labelledby` must reference the visible `<h2>` heading whose text
	 * matches `title`.
	 */
	async expectAccessibleTitle(title: string | RegExp): Promise<void> {
		const labelledBy = await this.dialog.getAttribute('aria-labelledby');
		expect(labelledBy, 'dialog must set aria-labelledby').toBeTruthy();
		await expect(this.titleHeading).toBeVisible();
		// The heading referenced by aria-labelledby is the one in the dialog.
		await expect(this.titleHeading).toHaveId(labelledBy as string);
		await expect(this.titleHeading).toHaveText(title);
		// End-to-end: the dialog's accessible name resolves through aria-labelledby.
		await expect(this.dialog).toHaveAccessibleName(title);
	}

	/** The close button is a reachable, labelled button. */
	async expectAccessibleCloseButton(): Promise<void> {
		await expect(this.closeButton).toBeVisible();
		await expect(this.closeButton).toBeEnabled();
		await expect(this.closeButton).toHaveAttribute('type', 'button');
		await expect(this.closeButton).toHaveAccessibleName('Close');
	}

	/**
	 * The error message is rendered inside the modal body. The app currently
	 * renders it as a plain div (no `role="alert"`); the assertion checks the
	 * text is visible within the still-open modal, so the failure is at least
	 * readable and the modal never auto-closes on error.
	 */
	async expectAccessibleMessage(message: string | RegExp): Promise<void> {
		await expect(this.dialog.getByText(message)).toBeVisible();
		await expect(this.dialog).toBeVisible();
	}

	/**
	 * Full accessibility contract for an error modal: an open dialog with an
	 * accessible title, a labelled close button, and the inline error message.
	 */
	async expectAccessible(opts: ErrorModalOptions = {}): Promise<void> {
		await this.expectVisible();
		if (opts.title !== undefined) {
			await this.expectAccessibleTitle(opts.title);
		}
		await this.expectAccessibleCloseButton();
		if (opts.message !== undefined) {
			await this.expectAccessibleMessage(opts.message);
		}
	}

	/** Dismiss the modal via its labelled close button. */
	async dismiss(): Promise<void> {
		await this.closeButton.click();
		await this.expectClosed();
	}
}

/**
 * Convenience wrapper: assert the currently open error modal meets the
 * accessibility contract (open dialog + accessible title + close button +
 * inline error message) and return the page object for further assertions.
 */
export async function expectErrorModalAccessible(
	page: Page,
	opts: ErrorModalOptions = {},
): Promise<ErrorModal> {
	const modal = new ErrorModal(page);
	await modal.expectAccessible(opts);
	return modal;
}
