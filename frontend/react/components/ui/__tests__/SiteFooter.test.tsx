/**
 * SiteFooter (ADA-367): the global footer must expose the legal + trust links
 * (Privacy, Terms, Sub-processors, contact, GitHub) on every route.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from '../SiteFooter';

describe('SiteFooter', () => {
	it('renders the legal and trust links with correct targets', () => {
		render(
			<MemoryRouter>
				<SiteFooter />
			</MemoryRouter>,
		);
		expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute(
			'href',
			'/privacy',
		);
		expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute(
			'href',
			'/terms',
		);
		expect(
			screen.getByRole('link', { name: 'Sub-processors' }),
		).toHaveAttribute('href', '/sub-processors');
		expect(screen.getByRole('link', { name: 'Contact' })).toHaveAttribute(
			'href',
			'mailto:privacy@hoursmith.io',
		);
		expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
			'href',
			'https://github.com/bcamarneiro/hoursmith',
		);
	});
});
