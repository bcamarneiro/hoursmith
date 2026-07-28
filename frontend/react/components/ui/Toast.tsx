import { useCallback, useEffect, useRef, useState } from 'react';
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

const TOAST_DURATION = 3500;

export const ToastContainer: React.FC = () => {
	const [toasts, setToasts] = useState<ToastItem[]>([]);
	const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
		new Map(),
	);
	const remainingRef = useRef<Map<number, number>>(new Map());

	const removeToast = useCallback((id: number) => {
		setToasts((prev) => prev.filter((t) => t.id !== id));
		const timer = timersRef.current.get(id);
		if (timer) {
			clearTimeout(timer);
			timersRef.current.delete(id);
		}
		remainingRef.current.delete(id);
	}, []);

	const scheduleRemoval = useCallback(
		(id: number, delay: number) => {
			const timer = setTimeout(() => {
				removeToast(id);
			}, delay);
			timersRef.current.set(id, timer);
			remainingRef.current.set(id, Date.now() + delay);
		},
		[removeToast],
	);

	const handlePause = useCallback((id: number) => {
		const timer = timersRef.current.get(id);
		if (timer) {
			clearTimeout(timer);
			timersRef.current.delete(id);
		}
		const deadline = remainingRef.current.get(id);
		if (deadline) {
			remainingRef.current.set(id, Math.max(0, deadline - Date.now()));
		}
	}, []);

	const handleResume = useCallback(
		(id: number) => {
			const remaining = remainingRef.current.get(id) ?? TOAST_DURATION;
			scheduleRemoval(id, Math.max(remaining, 500));
		},
		[scheduleRemoval],
	);

	useEffect(() => {
		addToastFn = (message: string, type: ToastType, options?: ToastOptions) => {
			const id = ++toastId;
			setToasts((prev) => [
				...prev,
				{ id, message, type, action: options?.action },
			]);
			scheduleRemoval(id, TOAST_DURATION);
		};
		return () => {
			addToastFn = null;
		};
	}, [scheduleRemoval]);

	if (toasts.length === 0) return null;

	return createPortal(
		<div className={styles.container} aria-live="polite" aria-atomic="false">
			{toasts.map((t) => (
				<div
					key={t.id}
					className={`${styles.toast} ${TYPE_STYLES[t.type]}`}
					role={t.type === 'error' ? 'alert' : undefined}
					onMouseEnter={() => handlePause(t.id)}
					onMouseLeave={() => handleResume(t.id)}
					onFocusCapture={() => handlePause(t.id)}
					onBlurCapture={() => handleResume(t.id)}
				>
					<span className={styles.icon} aria-hidden="true">
						{t.type === 'success' && '\u2713'}
						{t.type === 'error' && '\u2717'}
						{t.type === 'info' && '\u2139'}
					</span>
					<span className={styles.message}>{t.message}</span>
					{t.action && (
						<button
							type="button"
							className={styles.action}
							onClick={() => {
								t.action?.onClick();
								removeToast(t.id);
							}}
						>
							{t.action.label}
						</button>
					)}
					<button
						type="button"
						className={styles.dismiss}
						aria-label="Dismiss"
						onClick={() => removeToast(t.id)}
					>
						&times;
					</button>
				</div>
			))}
		</div>,
		document.body,
	);
};
