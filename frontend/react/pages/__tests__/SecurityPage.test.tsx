/**
 * SecurityPage (ADA-305): the trust hub must surface the core procurement
 * claims and route reviewers to the sub-processors + privacy detail pages.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SecurityPage } from '../SecurityPage';

describe('SecurityPage', () => {
	it('renders the trust sections and links to the detail pages', () => {
		render(
			<MemoryRouter>
				<SecurityPage />
			</MemoryRouter>,
		);

		expect(
			screen.getByRole('heading', { name: /Security & trust/i, level: 1 }),
		).toBeInTheDocument();
		expect(
			screen.getByRole('heading', { name: /How your data flows/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole('heading', { name: /Solo founder by design/i }),
		).toBeInTheDocument();

		// Data Processing Agreement is offered on request, not a fabricated file.
		expect(
			screen.getByRole('heading', { name: /Data Processing Agreement/i }),
		).toBeInTheDocument();

		// Routes reviewers to the canonical sub-processors + privacy pages.
		const subProcessorLinks = screen.getAllByRole('link', {
			name: /sub-processors/i,
		});
		expect(subProcessorLinks.length).toBeGreaterThan(0);
		expect(subProcessorLinks[0]).toHaveAttribute('href', '/sub-processors');
		expect(
			screen.getByRole('link', { name: /privacy policy/i }),
		).toHaveAttribute('href', '/privacy');
	});
});
