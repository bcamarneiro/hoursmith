import { useCallback, useEffect, useState } from 'react';
import type { DaySummary } from '../../../types/Suggestion';
import { useDashboardStore } from '../../stores/useDashboardStore';

interface KeyboardShortcutsResult {
	focusedDayIndex: number;
	focusedSuggestionIndex: number;
	showHelp: boolean;
	setShowHelp: (show: boolean) => void;
}

function isInputFocused(): boolean {
	const el = document.activeElement;
	if (!el) return false;
	const tag = el.tagName;
	// Yield to any interactive element so the user can interact with buttons,
	// links, and editable content inside a suggestion card without the global
	// keyboard shortcuts swallowing their keystrokes.
	if (
		tag === 'INPUT' ||
		tag === 'TEXTAREA' ||
		tag === 'SELECT' ||
		tag === 'DIALOG' ||
		tag === 'BUTTON' ||
		tag === 'A'
	) {
		return true;
	}
	// contentEditable divs (some rich-text fields) also need unhindered key input.
	if (el instanceof HTMLElement && el.isContentEditable) {
		return true;
	}
	return false;
}

export function useKeyboardShortcuts(
	weekdays: DaySummary[],
	onLogSuggestion?: (suggestionId: string) => void,
	onDismissSuggestion?: (suggestionId: string) => void,
	onLogAll?: (date: string) => void,
	onFillDay?: (date: string) => void,
): KeyboardShortcutsResult {
	const [focusedDayIndex, setFocusedDayIndex] = useState(-1);
	const [focusedSuggestionIndex, setFocusedSuggestionIndex] = useState(-1);
	const [showHelp, setShowHelp] = useState(false);

	const dismiss = useDashboardStore((s) => s.dismissSuggestion);
	const fillDayGap = useDashboardStore((s) => s.fillDayGap);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (isInputFocused()) return;
			if (showHelp && e.key !== '?' && e.key !== 'Escape') return;

			const daysWithGaps = weekdays.filter((d) => d.gapSeconds > 0);
			if (daysWithGaps.length === 0 && e.key !== '?') return;

			switch (e.key) {
				case 'ArrowLeft': {
					e.preventDefault();
					setFocusedDayIndex((prev) => {
						const next = prev <= 0 ? daysWithGaps.length - 1 : prev - 1;
						setFocusedSuggestionIndex(-1);
						return next;
					});
					break;
				}
				case 'ArrowRight': {
					e.preventDefault();
					setFocusedDayIndex((prev) => {
						const next = prev >= daysWithGaps.length - 1 ? 0 : prev + 1;
						setFocusedSuggestionIndex(-1);
						return next;
					});
					break;
				}
				case 'ArrowUp': {
					e.preventDefault();
					if (focusedDayIndex < 0 || focusedDayIndex >= daysWithGaps.length)
						break;
					const dayUp = daysWithGaps[focusedDayIndex];
					const activeUp = dayUp.suggestions.filter((s) => !s.logged);
					if (activeUp.length === 0) {
						// No suggestions left — return focus to the day card.
						setFocusedSuggestionIndex(-1);
						break;
					}
					setFocusedSuggestionIndex((prev) => {
						if (prev === -1) return activeUp.length - 1;
						if (prev === 0) return -1;
						return prev - 1;
					});
					break;
				}
				case 'ArrowDown': {
					e.preventDefault();
					if (focusedDayIndex < 0 || focusedDayIndex >= daysWithGaps.length)
						break;
					const dayDown = daysWithGaps[focusedDayIndex];
					const activeDown = dayDown.suggestions.filter((s) => !s.logged);
					if (activeDown.length === 0) {
						// No suggestions left — return focus to the day card.
						setFocusedSuggestionIndex(-1);
						break;
					}
					setFocusedSuggestionIndex((prev) => {
						if (prev === -1) return 0;
						if (prev >= activeDown.length - 1) return -1;
						return prev + 1;
					});
					break;
				}
				case 'Enter': {
					// Belt-and-suspenders: if real DOM focus is on a native
					// interactive control inside a card, let the browser handle
					// the keystroke rather than swallowing it.
					const activeEl = document.activeElement;
					if (activeEl instanceof HTMLElement) {
						const t = activeEl.tagName;
						if (t === 'BUTTON' || t === 'A' || t === 'INPUT') return;
					}
					e.preventDefault();
					if (focusedDayIndex < 0 || focusedDayIndex >= daysWithGaps.length)
						break;
					const dayEnter = daysWithGaps[focusedDayIndex];
					const activeEnter = dayEnter.suggestions.filter((s) => !s.logged);
					if (
						focusedSuggestionIndex >= 0 &&
						focusedSuggestionIndex < activeEnter.length
					) {
						const suggestion = activeEnter[focusedSuggestionIndex];
						if (onLogSuggestion) {
							onLogSuggestion(suggestion.id);
						}
					}
					break;
				}
				case 'Escape': {
					if (showHelp) {
						setShowHelp(false);
						break;
					}
					if (focusedDayIndex < 0 || focusedDayIndex >= daysWithGaps.length)
						break;
					const dayEsc = daysWithGaps[focusedDayIndex];
					const activeEsc = dayEsc.suggestions.filter((s) => !s.logged);
					if (
						focusedSuggestionIndex >= 0 &&
						focusedSuggestionIndex < activeEsc.length
					) {
						const suggestion = activeEsc[focusedSuggestionIndex];
						if (onDismissSuggestion) {
							onDismissSuggestion(suggestion.id);
						} else {
							dismiss(suggestion.id);
						}
						setFocusedSuggestionIndex((prev) => Math.max(-1, prev - 1));
					}
					break;
				}
				case 'a': {
					e.preventDefault();
					if (focusedDayIndex < 0 || focusedDayIndex >= daysWithGaps.length)
						break;
					const dayAll = daysWithGaps[focusedDayIndex];
					if (onLogAll) {
						onLogAll(dayAll.date);
					}
					break;
				}
				case 'f': {
					e.preventDefault();
					if (focusedDayIndex < 0 || focusedDayIndex >= daysWithGaps.length)
						break;
					const dayFill = daysWithGaps[focusedDayIndex];
					if (onFillDay) {
						onFillDay(dayFill.date);
					} else {
						fillDayGap(dayFill.date);
					}
					break;
				}
				case '?': {
					e.preventDefault();
					setShowHelp((prev) => !prev);
					break;
				}
			}
		},
		[
			weekdays,
			focusedDayIndex,
			focusedSuggestionIndex,
			showHelp,
			onLogSuggestion,
			onDismissSuggestion,
			onLogAll,
			onFillDay,
			dismiss,
			fillDayGap,
		],
	);

	useEffect(() => {
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [handleKeyDown]);

	return { focusedDayIndex, focusedSuggestionIndex, showHelp, setShowHelp };
}
