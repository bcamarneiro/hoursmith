import type React from 'react';
import { useEffect, useId, useRef } from 'react';
import * as styles from './Modal.module.css';

type Props = {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	children: React.ReactNode;
};

export const Modal: React.FC<Props> = ({
	isOpen,
	onClose,
	title,
	children,
}) => {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const titleId = useId();

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		if (isOpen) {
			if (!dialog.open) {
				dialog.showModal();
			}
			document.body.style.overflow = 'hidden';
		} else {
			if (dialog.open) {
				dialog.close();
			}
			document.body.style.overflow = 'unset';
		}

		return () => {
			// When the dialog is removed from the DOM while still open
			// (conditional rendering in the parent), close it first so the
			// native <dialog> API restores focus to the previously-focused
			// element rather than letting it land on <body>.
			if (dialog.open) {
				dialog.close();
			}
			document.body.style.overflow = 'unset';
		};
	}, [isOpen]);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		const handleCancel = (e: Event) => {
			e.preventDefault();
			onClose();
		};

		dialog.addEventListener('cancel', handleCancel);
		return () => dialog.removeEventListener('cancel', handleCancel);
	}, [onClose]);

	const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
		if (e.target === dialogRef.current) {
			onClose();
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
		// Native dialog handles Escape key, but we add this for linter compliance
		if (e.key === 'Escape') {
			onClose();
		}
	};

	return (
		<dialog
			ref={dialogRef}
			className={styles.dialog}
			onClick={handleBackdropClick}
			onKeyDown={handleKeyDown}
			aria-labelledby={titleId}
		>
			<div className={styles.modal}>
				<div className={styles.header}>
					<h2 id={titleId} className={styles.title}>
						{title}
					</h2>
					<button
						type="button"
						className={styles.closeButton}
						onClick={onClose}
						aria-label="Close"
					>
						×
					</button>
				</div>
				<div className={styles.content}>{children}</div>
			</div>
		</dialog>
	);
};
