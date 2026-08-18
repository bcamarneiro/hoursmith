import type React from 'react';
import * as styles from './ManualFlagToggle.module.css';

type Size = 'sm' | 'md';

type Props = {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label?: string;
	disabled?: boolean;
	size?: Size;
	className?: string;
};

const sizeMap: Record<Size, string> = {
	sm: styles.sm,
	md: styles.md,
};

export const ManualFlagToggle: React.FC<Props> = ({
	checked,
	onChange,
	label,
	disabled = false,
	size = 'md',
	className = '',
}) => {
	const stateClass = checked ? styles.on : styles.off;

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === ' ' || e.key === 'Enter') {
			e.preventDefault();
			if (!disabled) onChange(!checked);
		}
	};

	const handleClick = () => {
		if (!disabled) onChange(!checked);
	};

	const wrapperClass = className ? ` ${className}` : '';

	return (
		<div
			className={`${styles.wrapper}${wrapperClass}`}
			style={disabled ? { opacity: 0.5 } : undefined}
		>
			{label && <span className={styles.label}>{label}</span>}
			<div
				role="switch"
				aria-checked={checked}
				aria-disabled={disabled}
				aria-label={label ? undefined : 'Flag'}
				tabIndex={disabled ? -1 : 0}
				className={`${styles.track} ${sizeMap[size]} ${stateClass}`}
				onClick={handleClick}
				onKeyDown={handleKeyDown}
			>
				<div className={styles.thumb} />
			</div>
		</div>
	);
};
