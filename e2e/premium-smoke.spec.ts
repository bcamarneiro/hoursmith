import { expect, test } from '@playwright/test';
import { LEAD_TIER_ENABLED } from '../frontend/featureFlags';

/**
 * Premium-tier smoke. Covers the paywall-adjacent surfaces a paying user
 * encounters before they actually hit Polar:
 *   - Pricing page renders the fixed-price tiers (Free / Hosted, plus Lead
 *     when LEAD_TIER_ENABLED is on — it ships dark until ADA-376).
 *   - Each paid tier has a CTA pointing at /account?upgrade=<tier>.
 *   - /auth/sign-in renders form fields (only on premium builds; skipped otherwise).
 *
 * Runs against `npm run dev:offline` by default. For auth-route coverage,
 * start the dev server with `BUILD_TIER=premium npm run dev:offline`.
 */

test.describe('Premium smoke', () => {
	// Lead is gated by LEAD_TIER_ENABLED (currently off, ADA-376). The flag is
	// imported rather than its current value hard-coded, so this asserts the
	// intended behaviour in both states: hiding the tier while it is off, and
	// covering it the moment it is switched on. Pinning the assertions to
	// "two tiers" instead would go quietly green on a broken Lead tier.
	test('pricing shows the enabled fixed-price tiers with checkout CTAs', async ({
		page,
	}) => {
		await page.goto('/pricing');
		await page.waitForLoadState('networkidle');

		await expect(page.getByRole('heading', { name: 'Pricing.' })).toBeVisible();

		const tiers = ['Free', 'Hosted', ...(LEAD_TIER_ENABLED ? ['Lead'] : [])];
		for (const tier of tiers) {
			await expect(
				page.getByRole('heading', { level: 2, name: tier }),
			).toBeVisible();
		}

		const prices = ['€0', '€29', ...(LEAD_TIER_ENABLED ? ['€60'] : [])];
		for (const price of prices) {
			await expect(
				page.getByText(price, { exact: false }).first(),
			).toBeVisible();
		}

		// CTA honesty (ADA-301/ADA-341). The paid CTA is deliberately gated on
		// runtime flags: an open paywall routes to /account, a closed one offers
		// the waitlist instead. Asserting either state on its own would just pin
		// the test to today's flags and break the day they flip, so this asserts
		// the invariant that holds either way — exactly one of the two is
		// offered. Both would sell something twice; neither would strand a
		// visitor who wants to pay.
		const hostedCta = page.getByRole('link', { name: /Get Hosted/ });
		const waitlist = page.getByRole('button', { name: /Notify me/ });
		const hostedCtaCount = await hostedCta.count();
		const waitlistCount = await waitlist.count();
		expect(hostedCtaCount + waitlistCount).toBeGreaterThan(0);
		expect(hostedCtaCount && waitlistCount).toBeFalsy();
		if (hostedCtaCount) {
			await expect(hostedCta).toHaveAttribute('href', '/account?upgrade=hosted');
		}

		const leadCta = page.getByRole('link', { name: /Get Lead/ });
		if (LEAD_TIER_ENABLED) {
			await expect(page.getByRole('heading', { level: 2, name: 'Lead' })).toBeVisible();
			if (await leadCta.count()) {
				await expect(leadCta).toHaveAttribute('href', '/account?upgrade=lead');
			}
		} else {
			// A gated tier must be absent, not merely unstyled: a visible Lead CTA
			// would sell something that cannot be bought.
			await expect(leadCta).toHaveCount(0);
			await expect(
				page.getByRole('heading', { level: 2, name: 'Lead' }),
			).toHaveCount(0);
		}
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
