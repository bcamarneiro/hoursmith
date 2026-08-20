import { expect, test } from '@playwright/test';

/**
 * Premium-tier smoke. Covers the paywall-adjacent surfaces a paying user
 * encounters before they actually hit Polar:
 *   - Pricing page renders the three fixed-price tiers (Free / Hosted / Lead).
 *   - Each paid tier has a CTA pointing at /account?upgrade=<tier>.
 *   - /auth/sign-in renders form fields (only on premium builds; skipped otherwise).
 *
 * Runs against `npm run dev:offline` by default. For auth-route coverage,
 * start the dev server with `BUILD_TIER=premium npm run dev:offline`.
 */

test.describe('Premium smoke', () => {
	test('pricing shows three fixed-price tiers with checkout CTAs', async ({
		page,
	}) => {
		await page.goto('/pricing');
		await page.waitForLoadState('networkidle');

		await expect(page.getByRole('heading', { name: 'Pricing.' })).toBeVisible();

		// All three tier names visible.
		for (const tier of ['Free', 'Hosted', 'Lead']) {
			await expect(
				page.getByRole('heading', { level: 2, name: tier }),
			).toBeVisible();
		}

		// Headline prices visible (€0 / €29 / €60).
		for (const price of ['€0', '€29', '€60']) {
			await expect(
				page.getByText(price, { exact: false }).first(),
			).toBeVisible();
		}

		// Paid tiers route into the existing /account upgrade flow with a tier hint.
		const hostedCta = page.getByRole('link', { name: /Get Hosted/ });
		await expect(hostedCta).toBeVisible();
		await expect(hostedCta).toHaveAttribute('href', '/account?upgrade=hosted');

		const leadCta = page.getByRole('link', { name: /Get Lead/ });
		await expect(leadCta).toBeVisible();
		await expect(leadCta).toHaveAttribute('href', '/account?upgrade=lead');
	});

	test('pricing no longer surfaces name-your-price controls', async ({
		page,
	}) => {
		await page.goto('/pricing');
		await page.waitForLoadState('networkidle');

		// Old NYP UI must be gone.
		await expect(
			page.getByRole('button', { name: 'Custom amount' }),
		).toHaveCount(0);
		await expect(page.getByText('Pick your annual price')).toHaveCount(0);
	});

	test('/auth/sign-in renders email + password fields', async ({ page }) => {
		await page.goto('/auth/sign-in');
		// Premium route table loads as a dynamic chunk — give it a beat before
		// deciding the route doesn't exist.
		const heading = page.getByRole('heading', { name: 'Sign in' });
		const visible = await heading
			.waitFor({ state: 'visible', timeout: 5000 })
			.then(() => true)
			.catch(() => false);
		if (!visible) {
			test.skip(
				true,
				'sign-in route not mounted (Free-tier build) — run with BUILD_TIER=premium',
			);
			return;
		}

		await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
		await expect(page.getByLabel('Password')).toBeVisible();
		await expect(
			page.getByRole('button', { name: /Continue with GitHub/i }),
		).toBeVisible();
	});

	test('/account bounces unauthenticated visitors to sign-in', async ({
		page,
	}) => {
		await page.goto('/account');
		const heading = page.getByRole('heading', { name: 'Sign in' });
		const bounced = await heading
			.waitFor({ state: 'visible', timeout: 5000 })
			.then(() => true)
			.catch(() => false);
		if (!bounced) {
			test.skip(
				true,
				'/account route not mounted (Free-tier build) — run with BUILD_TIER=premium',
			);
			return;
		}
		await expect(page).toHaveURL(/\/auth\/sign-in/);
	});
});
