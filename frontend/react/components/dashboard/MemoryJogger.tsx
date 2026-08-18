import type React from 'react';
import { useState } from 'react';
import type { MemoryJogQuestion } from '../../utils/memoryJogger';
import styles from './MemoryJogger.module.css';

interface MemoryJoggerProps {
	questions: MemoryJogQuestion[];
}

/**
 * Collapsible "Need a hint?" panel that renders memory-jog questions on
 * incomplete day cards. Starts collapsed — the user clicks to reveal.
 * Renders nothing when there are no questions.
 */
export const MemoryJogger: React.FC<MemoryJoggerProps> = ({ questions }) => {
	const [expanded, setExpanded] = useState(false);

	if (questions.length === 0) return null;

	return (
		<div className={styles.container}>
			<button
				type="button"
				className={styles.toggle}
				onClick={() => setExpanded((prev) => !prev)}
				aria-expanded={expanded}
			>
				<span className={styles.icon}>{expanded ? '▾' : '▸'}</span>
				Need a hint?
			</button>
			{expanded && (
				<ul className={styles.list}>
					{questions.map((q) => (
						<li key={q.id} className={styles.item}>
							<span className={styles.question}>{q.question}</span>
							{q.hint && <span className={styles.hint}>{q.hint}</span>}
						</li>
					))}
				</ul>
			)}
		</div>
	);
};
