import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPremiumBuild } from '../../../../buildTier';
import { FirstRunOnboarding } from '../FirstRunOnboarding';

vi.mock('../../../../buildTier', () => ({ isPremiumBuild: vi.fn() }));
vi.mock('../../../../analytics', () => ({ trackEvent: vi.fn() }));

const mockedIsPremium = vi.mocked(isPremiumBuild);

describe('FirstRunOnboarding (ADA-470)', () => {
	beforeEach(() => {
		mockedIsPremium.mockReset();
	});

	it('offers both a Hosted and a self-host path', () => {
		mockedIsPremium.mockReturnValue(false);
		render(
			<MemoryRouter>
				<FirstRunOnboarding onChooseSelfHost={() => {}} />
			</MemoryRouter>,
		);
		expect(screen.getByText('Zero setup — Hosted')).toBeTruthy();
		expect(screen.getByText('Self-host — for developers')).toBeTruthy();
	});

	it('routes non-devs to the waitlist on free builds (no purchasable Hosted yet)', () => {
		mockedIsPremium.mockReturnValue(false);
		render(
			<MemoryRouter>
				<FirstRunOnboarding onChooseSelfHost={() => {}} />
			</MemoryRouter>,
		);
		expect(screen.getByText('Coming soon')).toBeTruthy();
		// Free build can't sell Hosted — no create-account CTA.
		expect(screen.queryByText('Create account')).toBeNull();
	});

	it('offers Create account on hosted builds', () => {
		mockedIsPremium.mockReturnValue(true);
		render(
			<MemoryRouter>
				<FirstRunOnboarding onChooseSelfHost={() => {}} />
			</MemoryRouter>,
		);
		expect(screen.getByText('Create account')).toBeTruthy();
		expect(screen.queryByText('Coming soon')).toBeNull();
	});

	it('dismisses to the setup form when the self-host path is chosen', () => {
		mockedIsPremium.mockReturnValue(false);
		const onChooseSelfHost = vi.fn();
		render(
			<MemoryRouter>
				<FirstRunOnboarding onChooseSelfHost={onChooseSelfHost} />
			</MemoryRouter>,
		);
		fireEvent.click(screen.getByText(/show the setup form/i));
		expect(onChooseSelfHost).toHaveBeenCalledTimes(1);
	});
});
