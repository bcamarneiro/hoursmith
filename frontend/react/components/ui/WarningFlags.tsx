import type React from 'react';
import * as styles from './WarningFlags.module.css';

/**
 * Categories of warnings that can be raised on a time-entry day.
 *
 * Each category maps to a severity (for colour coding) and a default
 * visual label. Extend this union as new warning types are introduced.
 */
export type WarningFlagKind =
	| 'incomplete'
	| 'missing'
	| 'backdated'
	| 'overtime'
	| 'weekend-work'
	| 'absence-gap';

export interface WarningFlag {
	kind: WarningFlagKind;
	message: string;
	/** Optional structured payload for tooltips or further detail. */
	detail?: string;
}

interface Props {
	flags: WarningFlag[];
	/** Display as a compact inline row (`inline`) or a vertical list (`list`). */
	layout?: 'inline' | 'list';
	className?: string;
}

/* ------------------------------------------------------------------ */
/*  Icons — simple UTF-8 glyphs; swap for SVG sprites when available. */
/* ------------------------------------------------------------------ */

const kindIcons: Record<WarningFlagKind, string> = {
	incomplete: '\u26A0', // ⚠
	missing: '\u2716', // ✖
	backdated: '\u2139', // ℹ
	overtime: '\u2191', // ↑
	'weekend-work': '\u23F0', // ⏰
	'absence-gap': '\u2757', // ❗
};

/* ------------------------------------------------------------------ */
/*  Severity class lookup — static property access for tree-shaking    */
/* ------------------------------------------------------------------ */

function severityClass(
	kind: WarningFlagKind,
	moduleStyles: typeof styles,
): string {
	switch (kind) {
		case 'incomplete':
			return moduleStyles.severityIncomplete;
		case 'missing':
			return moduleStyles.severityMissing;
		case 'backdated':
			return moduleStyles.severityBackdated;
		case 'overtime':
			return moduleStyles.severityOvertime;
		case 'weekend-work':
			return moduleStyles.severityWeekendWork;
		case 'absence-gap':
			return moduleStyles.severityAbsenceGap;
	}
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const WarningFlags: React.FC<Props> = ({
	flags,
	layout = 'list',
	className,
}) => {
	if (flags.length === 0) return null;

	const containerClass = [
		styles.container,
		layout === 'inline' ? styles.layoutInline : styles.layoutList,
		className ?? '',
	]
		.filter(Boolean)
		.join(' ');

	return (
		<ul className={containerClass} aria-label="Warnings" data-layout={layout}>
			{flags.map((flag, idx) => (
				<li
					key={`${flag.kind}-${idx}`}
					className={`${styles.flag} ${severityClass(flag.kind, styles)}`}
					title={flag.detail ?? flag.message}
				>
					<span className={styles.icon} aria-hidden="true">
						{kindIcons[flag.kind]}
					</span>
					<span className={styles.message}>{flag.message}</span>
				</li>
			))}
		</ul>
	);
};
