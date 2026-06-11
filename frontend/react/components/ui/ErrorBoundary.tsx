import type React from 'react';
import { Component } from 'react';
import { captureException } from '../../../analytics';
import * as styles from './ErrorBoundary.module.css';

type Props = {
	children: React.ReactNode;
	fallbackMessage?: string;
};

type State = {
	hasError: boolean;
	error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, info: React.ErrorInfo): void {
		// Report render crashes to PostHog Error Tracking (dogfooding visibility).
		captureException(error, { componentStack: info.componentStack });
	}

	render() {
		if (this.state.hasError) {
			return (
				<div className={styles.container}>
					<div className={styles.icon}>!</div>
					<p className={styles.message}>
						{this.props.fallbackMessage ||
							'Something went wrong rendering this section.'}
					</p>
					<button
						type="button"
						className={styles.retry}
						onClick={() => this.setState({ hasError: false, error: null })}
					>
						Try again
					</button>
				</div>
			);
		}

		return this.props.children;
	}
}
