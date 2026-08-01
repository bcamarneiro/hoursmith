import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import * as styles from './Toast.module.css';

type ToastType = 'success' | 'error' | 'info';

const TYPE_STYLES: Record<ToastType, string> = {
	success: styles.success,
	error: styles.error,
	info: styles.info,
};

export interface ToastAction {
	label: string;
	onClick: () => void;
}

interface ToastItem {
	id: number;
	message: string;
	type: ToastType;
	action?: ToastAction;
}

interface ToastOptions {
	action?: ToastAction;
}

let toastId = 0;
let addToastFn:
	| ((message: string, type: ToastType, options?: ToastOptions) => void)
	| null = null;

export function toast(
	message: string,
	type: ToastType = 'info',
	options?: ToastOptions,
) {
	addToastFn?.(message, type, options);
}

toast.success = (message: string, options?: ToastOptions) =>
	toast(message, 'success', options);
toast.error = (message: string, options?: ToastOptions) =>
	toast(message, 'error', options);
toast.info = (message: string, options?: ToastOptions) =>
	toast(message, 'info', options);

export const ToastContainer: React.FC = () => {
	const [toasts, setToasts] = useState<ToastItem[]>([]);

	useEffect(() => {
		addToastFn = (message: string, type: ToastType, options?: ToastOptions) => {
			const id = ++toastId;
			setToasts((prev) => [
				...prev,
				{ id, message, type, action: options?.action },
			]);
			setTimeout(() => {
				setToasts((prev) => prev.filter((t) => t.id !== id));
			}, 3500);
		};
		return () => {
			addToastFn = null;
		};
	}, []);

	if (toasts.length === 0) return null;

	return createPortal(
		<div className={styles.container} aria-live="polite">
			{toasts.map((t) => (
				<div
					key={t.id}
					className={`${styles.toast} ${TYPE_STYLES[t.type]}`}
					role={t.type === 'error' ? 'alert' : 'status'}
				>
					<span className={styles.icon}>
						{t.type === 'success' && '\u2713'}
						{t.type === 'error' && '\u2717'}
						{t.type === 'info' && '\u2139'}
					</span>
					<span className={styles.message}>{t.message}</span>
					{t.action && (
						<button
							type="button"
							className={styles.action}
							aria-label={t.action.label}
							onClick={() => {
								t.action?.onClick();
								setToasts((prev) => prev.filter((x) => x.id !== t.id));
							}}
						>
							{t.action.label}
						</button>
					)}
					<button
						type="button"
						className={styles.dismiss}
						aria-label="Dismiss notification"
						onClick={() =>
							setToasts((prev) => prev.filter((x) => x.id !== t.id))
						}
					>
						&times;
					</button>
				</div>
			))}
		</div>,
		document.body,
	);
};
