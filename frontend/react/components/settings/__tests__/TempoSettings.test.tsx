import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TempoConnectBanner } from '../TempoConnectBanner';

describe('TempoConnectBanner', () => {
	it('renders a connect prompt when shown', () => {
		render(<TempoConnectBanner show onConnect={() => {}} />);
		expect(screen.getByText(/logs time through Tempo/i)).toBeInTheDocument();
	});
	it('renders nothing when show is false', () => {
		const { container } = render(
			<TempoConnectBanner show={false} onConnect={() => {}} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
