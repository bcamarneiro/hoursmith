interface Props {
	show: boolean;
	onConnect: () => void;
}

export function TempoConnectBanner({ show, onConnect }: Props) {
	if (!show) return null;
	return (
		<div role="alert" className="tempo-connect-banner">
			<span>
				This Jira logs time through Tempo. Connect Tempo to see and edit your
				worklogs.
			</span>
			<button type="button" onClick={onConnect}>
				Connect Tempo
			</button>
		</div>
	);
}
