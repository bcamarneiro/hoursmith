import type { ClassifiedWorklog } from '../frontend/react/utils/worklogClassifier';

export interface JiraUser {
	self?: string;
	accountId?: string;
	emailAddress?: string;
	displayName?: string;
	active?: boolean;
	[key: string]: unknown;
}

export interface JiraIssue {
	expand?: string;
	id: string;
	self?: string;
	key: string;
	fields: {
		summary?: string;
		[key: string]: unknown;
	};
}

export interface JiraWorklog {
	self?: string;
	id?: string;
	author?: JiraUser;
	updateAuthor?: JiraUser;
	comment?: string | Record<string, unknown>;
	created?: string;
	updated?: string;
	started?: string;
	timeSpent?: string;
	timeSpentSeconds?: number;
	issueId?: string;
	issueKey?: string;
	/** Pre-computed classification result. Attached at ingest to avoid re-classifying the same worklog across multiple consumers. */
	classified?: ClassifiedWorklog;
	[key: string]: unknown;
}

export interface EnrichedJiraWorklog extends JiraWorklog {
	issue: JiraIssue;
}

export type GroupedWorklogs = Record<
	string,
	Record<string, EnrichedJiraWorklog[]>
>;
