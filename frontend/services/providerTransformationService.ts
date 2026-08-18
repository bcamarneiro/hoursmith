import type { RescueTimeDaySummary, WorklogSuggestion } from '../../types/Suggestion';
import type { Config } from '../stores/useConfigStore';
import type { CalendarMapping } from '../stores/useUserDataStore';
import { fetchCalendarSuggestions } from './calendarService';
import { fetchGitlabSuggestions } from './gitlabService';
import { fetchJiraActivitySuggestions } from './jiraActivityService';
import { fetchRescueTimeData } from './rescueTimeService';

/**
 * Error produced during a single provider's transformation step.
 */
export interface ProviderError {
	source: 'jira' | 'gitlab' | 'calendar' | 'rescuetime';
	message: string;
}

/**
 * Result of a full provider-transformation run across all configured
 * sources.  Each array/map is either the provider's output or an empty
 * fallback when the provider failed or is not configured.
 */
export interface ProviderTransformationResult {
	jiraSuggestions: WorklogSuggestion[];
	gitlabSuggestions: WorklogSuggestion[];
	calendarSuggestions: WorklogSuggestion[];
	rescueTimeData: Map<string, RescueTimeDaySummary>;
	errors: ProviderError[];
}

/**
 * Input bag for {@link fetchProviderTransformations}.
 */
export interface FetchProviderTransformationsInput {
	config: Config;
	weekStart: string;
	weekEnd: string;
	signal?: AbortSignal;
	calendarMappings?: CalendarMapping[];
}

/**
 * Run every configured provider in parallel, collecting suggestions and
 * errors into a single structured result.
 *
 * Individual provider failures are swallowed into the {@link errors} array
 * so that one broken source doesn't bring down the whole dashboard.
 */
export async function fetchProviderTransformations(
	input: FetchProviderTransformationsInput,
): Promise<ProviderTransformationResult> {
	const {
		config,
		weekStart,
		weekEnd,
		signal,
		calendarMappings = [],
	} = input;

	const hasGitlab = !!(config.gitlabToken && config.gitlabHost);
	const suggestionFeeds = (config.calendarFeeds ?? []).filter(
		(feed) => feed.type === 'suggestion',
	);
	const hasCalendar = suggestionFeeds.length > 0;
	const hasRescueTime = !!config.rescueTimeApiKey;

	const errors: ProviderError[] = [];

	const [
		jiraSuggestions,
		gitlabSuggestions,
		calendarSuggestions,
		rescueTimeData,
	] = await Promise.all([
		// --- Jira ---
		fetchJiraActivitySuggestions(config, weekStart, weekEnd, signal).catch(
			(e: unknown) => {
				errors.push({
					source: 'jira',
					message: e instanceof Error ? e.message : String(e),
				});
				return [] as WorklogSuggestion[];
			},
		),

		// --- GitLab ---
		hasGitlab
			? fetchGitlabSuggestions(
					config.gitlabToken,
					config.gitlabHost,
					config.corsProxy,
					weekStart,
					weekEnd,
					signal,
				).catch((e: unknown) => {
					errors.push({
						source: 'gitlab',
						message: e instanceof Error ? e.message : String(e),
					});
					return [] as WorklogSuggestion[];
				})
			: Promise.resolve([] as WorklogSuggestion[]),

		// --- Calendar ---
		hasCalendar
			? fetchCalendarSuggestions(
					suggestionFeeds,
					config.corsProxy,
					weekStart,
					weekEnd,
					calendarMappings,
					signal,
				).catch((e: unknown) => {
					errors.push({
						source: 'calendar',
						message: e instanceof Error ? e.message : String(e),
					});
					return [] as WorklogSuggestion[];
				})
			: Promise.resolve([] as WorklogSuggestion[]),

		// --- RescueTime ---
		hasRescueTime
			? fetchRescueTimeData(
					config.rescueTimeApiKey,
					config.corsProxy,
					weekStart,
					weekEnd,
					signal,
				).catch((e: unknown) => {
					errors.push({
						source: 'rescuetime',
						message: e instanceof Error ? e.message : String(e),
					});
					return new Map<string, RescueTimeDaySummary>();
				})
			: Promise.resolve(new Map<string, RescueTimeDaySummary>()),
	]);

	return {
		jiraSuggestions,
		gitlabSuggestions,
		calendarSuggestions,
		rescueTimeData,
		errors,
	};
}
