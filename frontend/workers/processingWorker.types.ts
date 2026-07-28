/**
 * Message protocol for the processing Web Worker.
 *
 * The worker offloads CPU-heavy derive computations (classify, aggregate,
 * CSV generation) from the main thread so the UI stays responsive on
 * large months/teams.
 */

import type { EnrichedJiraWorklog } from '../../types/jira';
import type { AbsenceDay, UserAbsenceDays } from '../services/absenceService';
import type { TeamMemberSummary } from '../services/teamService';
import type { ClassifierOptions } from '../react/utils/worklogClassifier';
import type { AggregationPolicy } from '../react/utils/csv';

// ── Request types ──────────────────────────────────────────────────

export interface ClassifyRequest {
	type: 'classify';
	id: number;
	payload: {
		worklogs: EnrichedJiraWorklog[];
		classifierOptions?: ClassifierOptions;
	};
}

export interface BuildHeatmapRequest {
	type: 'buildHeatmap';
	id: number;
	payload: {
		worklogs: EnrichedJiraWorklog[];
		email: string;
	};
}

export interface BuildTeamSummariesRequest {
	type: 'buildTeamSummaries';
	id: number;
	payload: {
		worklogs: EnrichedJiraWorklog[];
		weekStart: string;
		weekEnd: string;
		allowedUsers: string;
		/** Serialised UserAbsenceDays — Maps converted to entry arrays. */
		absenceDaysByUser?: [string, [string, AbsenceDay][]][];
	};
}

export interface BuildTimesheetCsvRequest {
	type: 'buildTimesheetCsv';
	id: number;
	payload: {
		worklogs: EnrichedJiraWorklog[];
		issueSummaries: Record<string, string>;
		policy: AggregationPolicy;
		period?: { year: number; month: number };
		classifierOptions?: ClassifierOptions;
		provenance?: {
			jiraHost?: string;
			sourceVersion?: string;
			generatedAt?: string;
		};
		includeProvenance?: boolean;
		/** Serialised absence map — Map converted to entry array. */
		absenceDays?: [string, AbsenceDay][];
		includeAbsenceColumns?: boolean;
	};
}

export interface BuildTeamCsvRequest {
	type: 'buildTeamCsv';
	id: number;
	payload: {
		/** Serialised summaries — Maps converted to entry arrays. */
		summaries: SerializableTeamMemberSummary[];
		weekStart: string;
		weekEnd: string;
		weekdays: string[];
		provenance?: {
			jiraHost?: string;
			sourceVersion?: string;
			generatedAt?: string;
		};
		includeProvenance?: boolean;
		includeAbsenceColumns?: boolean;
	};
}

export type ProcessingWorkerRequest =
	| ClassifyRequest
	| BuildHeatmapRequest
	| BuildTeamSummariesRequest
	| BuildTimesheetCsvRequest
	| BuildTeamCsvRequest;

// ── Response types ─────────────────────────────────────────────────

export interface ClassifiedWorklogResult {
	loggedOn: string;
	intendedFor: string;
	daysLate: number;
	isBackdated: boolean;
	source: 'none' | 'comment' | 'jira-native';
	originalComment: string;
}

export interface ClassifyResponse {
	type: 'classify';
	id: number;
	result: ClassifiedWorklogResult[];
}

export interface HeatmapResult {
	/** Plain-object map (Map not used — structured-clone friendly). */
	data: Record<string, number>;
	backdatedSeconds: Record<string, number>;
}

export interface BuildHeatmapResponse {
	type: 'buildHeatmap';
	id: number;
	result: HeatmapResult;
}

/** Serialisable TeamMemberSummary — Maps converted to entry arrays. */
export interface SerializableTeamMemberSummary {
	email: string;
	displayName: string;
	dailyHours: [string, number][];
	totalSeconds: number;
	targetSeconds: number;
	gapSeconds: number;
	backdatedSeconds?: number;
	backdatedCount?: number;
	workedOnPtoDates?: string[];
}

export interface BuildTeamSummariesResponse {
	type: 'buildTeamSummaries';
	id: number;
	result: SerializableTeamMemberSummary[];
}

export interface BuildTimesheetCsvResponse {
	type: 'buildTimesheetCsv';
	id: number;
	result: string;
}

export interface BuildTeamCsvResponse {
	type: 'buildTeamCsv';
	id: number;
	result: string;
}

export interface ErrorResponse {
	type: 'error';
	id: number;
	error: string;
}

export type ProcessingWorkerResponse =
	| ClassifyResponse
	| BuildHeatmapResponse
	| BuildTeamSummariesResponse
	| BuildTimesheetCsvResponse
	| BuildTeamCsvResponse
	| ErrorResponse;

// ── Serialisation helpers ──────────────────────────────────────────

/** Convert a `UserAbsenceDays` (nested Maps) to a structured-clone-friendly form. */
export function serializeUserAbsenceDays(
	map: UserAbsenceDays | undefined,
): [string, [string, AbsenceDay][]][] | undefined {
	if (!map) return undefined;
	const outer: [string, [string, AbsenceDay][]][] = [];
	for (const [user, inner] of map) {
		outer.push([user, [...inner]]);
	}
	return outer;
}

/** Reconstruct a `UserAbsenceDays` from its serialised form. */
export function deserializeUserAbsenceDays(
	entries: [string, [string, AbsenceDay][]][] | undefined,
): UserAbsenceDays | undefined {
	if (!entries) return undefined;
	const map: UserAbsenceDays = new Map();
	for (const [user, inner] of entries) {
		map.set(user, new Map(inner));
	}
	return map;
}

/** Convert a `Map<string, AbsenceDay>` to an entry array. */
export function serializeAbsenceMap(
	map: Map<string, AbsenceDay> | undefined,
): [string, AbsenceDay][] | undefined {
	if (!map) return undefined;
	return [...map];
}

/** Reconstruct a `Map<string, AbsenceDay>` from entries. */
export function deserializeAbsenceMap(
	entries: [string, AbsenceDay][] | undefined,
): Map<string, AbsenceDay> | undefined {
	if (!entries) return undefined;
	return new Map(entries);
}

/** Convert `TeamMemberSummary[]` (with Maps) to serialisable form. */
export function serializeTeamSummaries(
	summaries: TeamMemberSummary[],
): SerializableTeamMemberSummary[] {
	return summaries.map((s) => ({
		email: s.email,
		displayName: s.displayName,
		dailyHours: [...s.dailyHours],
		totalSeconds: s.totalSeconds,
		targetSeconds: s.targetSeconds,
		gapSeconds: s.gapSeconds,
		backdatedSeconds: s.backdatedSeconds,
		backdatedCount: s.backdatedCount,
		workedOnPtoDates: s.workedOnPtoDates,
	}));
}

/** Reconstruct `TeamMemberSummary[]` from serialised form. */
export function deserializeTeamSummaries(
	items: SerializableTeamMemberSummary[],
): TeamMemberSummary[] {
	return items.map((s) => ({
		email: s.email,
		displayName: s.displayName,
		dailyHours: new Map(s.dailyHours),
		totalSeconds: s.totalSeconds,
		targetSeconds: s.targetSeconds,
		gapSeconds: s.gapSeconds,
		backdatedSeconds: s.backdatedSeconds,
		backdatedCount: s.backdatedCount,
		workedOnPtoDates: s.workedOnPtoDates,
	}));
}
