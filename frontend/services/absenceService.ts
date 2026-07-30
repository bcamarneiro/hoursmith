import type { AbsenceKind } from '../../types/absence';
import { logger } from '../react/utils/logger';
import type { AbsenceAssignment, CalendarFeed } from '../stores/useConfigStore';
import { createCalendarParser } from './providers';
import type { ParsedCalendarEvent } from './providers';
import { fromHttpResponse } from './serviceErrors';

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function matchesTitleFilter(summary: string, titleFilter?: string): boolean {
  if (!titleFilter?.trim()) return true;
  return summary.toLowerCase().includes(titleFilter.trim().toLowerCase());
}

function getAbsenceAttributionMode(feed: CalendarFeed): 'self' | 'shared' {
  return feed.absenceAttribution === 'shared' ? 'shared' : 'self';
}

export function classifyAbsenceKind(summary: string): AbsenceKind {
  const normalized = summary.trim().toLowerCase();
  if (normalized.includes('sick')) return 'sick';
  if (normalized.includes('vacation')) return 'vacation';
  return 'off';
}

function resolveAbsenceKind(
  current: AbsenceKind,
  next: AbsenceKind,
): AbsenceKind {
  // Priority: a more specific reason wins. Sick > holiday > vacation > off.
  // `holiday` ranks above `vacation` so that a public holiday colliding with
  // a personal vacation day still surfaces as "Holiday" in the label.
  const priority: Record<AbsenceKind, number> = {
    off: 1,
    vacation: 2,
    holiday: 3,
    sick: 4,
  };
  return priority[next] >= priority[current] ? next : current;
}

export interface AbsenceDay {
  date: string;
  reasons: string[];
  kind: AbsenceKind;
}

export type UserAbsenceDays = Map<string, Map<string, AbsenceDay>>;

function addAbsenceReason(
  userAbsenceDays: UserAbsenceDays,
  userEmail: string,
  date: string,
  reason: string,
  kind: AbsenceKind,
) {
  const normalizedEmail = userEmail.trim().toLowerCase();
  if (!normalizedEmail) return;

  let userDates = userAbsenceDays.get(normalizedEmail);
  if (!userDates) {
    userDates = new Map();
    userAbsenceDays.set(normalizedEmail, userDates);
  }

  const existing = userDates.get(date);
  if (existing) {
    if (!existing.reasons.includes(reason)) {
      existing.reasons.push(reason);
    }
    existing.kind = resolveAbsenceKind(existing.kind, kind);
    return;
  }

  userDates.set(date, {
    date,
    reasons: [reason],
    kind,
  });
}

function findMatchedUsers(
  summary: string,
  assignments: NormalisedAssignment[],
): string[] {
  const matched = assignments.filter((assignment) =>
    summary.toLowerCase().includes(assignment.pattern.toLowerCase()),
  );
  const out = new Set<string>();
  for (const a of matched) {
    for (const email of a.userEmails) out.add(email);
  }
  return [...out];
}

interface NormalisedAssignment {
  pattern: string;
  userEmails: string[];
}

export async function fetchAbsenceDaysByUser(
  feeds: CalendarFeed[],
  assignments: AbsenceAssignment[],
  currentUserEmail: string,
  corsProxy: string,
  rangeStart: string,
  rangeEnd: string,
  signal?: AbortSignal,
): Promise<UserAbsenceDays> {
  const absenceFeeds = feeds.filter(
    (feed) => feed.type === 'absence' && feed.url.trim(),
  );
  const holidayFeeds = feeds.filter(
    (feed) => feed.type === 'holiday' && feed.url.trim(),
  );
  if (absenceFeeds.length === 0 && holidayFeeds.length === 0) return new Map();

  const normalizedAssignments: NormalisedAssignment[] = assignments
    .map((assignment) => ({
      pattern: assignment.pattern.trim(),
      userEmails: assignment.userEmails
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0),
    }))
    .filter(
      (assignment) => assignment.pattern && assignment.userEmails.length > 0,
    );
  const normalizedCurrentUser = currentUserEmail.trim().toLowerCase();

  type FeedResult = {
    feedType: 'absence' | 'holiday';
    label: string;
    absenceAttribution: 'self' | 'shared';
    titleFilter?: string;
    events: ParsedCalendarEvent[];
  };

  const allFeeds: { feed: CalendarFeed; feedType: 'absence' | 'holiday' }[] = [
    ...absenceFeeds.map((feed) => ({ feed, feedType: 'absence' as const })),
    ...holidayFeeds.map((feed) => ({ feed, feedType: 'holiday' as const })),
  ];

  const results = await Promise.allSettled(
    allFeeds.map<Promise<FeedResult>>(async ({ feed, feedType }) => {
      const url = corsProxy
        ? `${corsProxy.replace(/\/$/, '')}/${feed.url}`
        : feed.url;
      const res = await fetch(url, { signal });
      if (!res.ok) throw fromHttpResponse('Absence feed', res.status);
      const text = await res.text();
      return {
        feedType,
        label: feed.label,
        absenceAttribution: getAbsenceAttributionMode(feed),
        titleFilter: feed.titleFilter,
        events: createCalendarParser(feedType).parse(text),
      };
    }),
  );

  const userAbsenceDays: UserAbsenceDays = new Map();
  // Holiday events whose summary doesn't match any assignment pattern apply
  // to *every* user (the nationwide default). We collect them here and merge
  // onto every known user after the per-user passes populate the recipient
  // set.
  const nationwideHolidays = new Map<string, { reason: string }>();

  for (const result of results) {
    if (result.status !== 'fulfilled') {
      if (!isAbortError(result.reason)) {
        logger.warn('[Absence] Feed failed:', result.reason);
      }
      continue;
    }

    const { feedType, label, absenceAttribution, titleFilter, events } =
      result.value;

    if (feedType === 'holiday') {
      for (const event of events) {
        if (!matchesTitleFilter(event.summary, titleFilter)) continue;
        // Regional holidays: assignments whose pattern matches the event
        // title scope the holiday to those users. No match → nationwide.
        const regionalUsers = findMatchedUsers(
          event.summary,
          normalizedAssignments,
        );
        const dates = createCalendarParser(feedType).expand(event, rangeStart, rangeEnd);
        if (regionalUsers.length > 0) {
          for (const { date, summary } of dates) {
            const reason = label ? `[${label}] ${summary}` : summary;
            for (const userEmail of regionalUsers) {
              addAbsenceReason(
                userAbsenceDays,
                userEmail,
                date,
                reason,
                'holiday',
              );
            }
          }
        } else {
          for (const { date, summary } of dates) {
            if (!nationwideHolidays.has(date)) {
              const reason = label ? `[${label}] ${summary}` : summary;
              nationwideHolidays.set(date, { reason });
            }
          }
        }
      }
      continue;
    }

    for (const event of events) {
      const matchedUsers =
        absenceAttribution === 'shared'
          ? new Set(findMatchedUsers(event.summary, normalizedAssignments))
          : new Set<string>();
      if (
        absenceAttribution === 'self' &&
        normalizedCurrentUser &&
        matchesTitleFilter(event.summary, titleFilter)
      ) {
        matchedUsers.add(normalizedCurrentUser);
      }
      if (matchedUsers.size === 0) continue;

      const dates = createCalendarParser(feedType).expand(event, rangeStart, rangeEnd);
      for (const { date, summary } of dates) {
        const reason = label ? `[${label}] ${summary}` : summary;
        const kind = classifyAbsenceKind(summary);
        for (const userEmail of matchedUsers) {
          addAbsenceReason(userAbsenceDays, userEmail, date, reason, kind);
        }
      }
    }
  }

  // Merge nationwide holiday dates into every known user, plus the current
  // user (so a workspace configured with only a holiday feed still has the
  // current user in the map).
  if (nationwideHolidays.size > 0) {
    const recipients = new Set<string>(userAbsenceDays.keys());
    if (normalizedCurrentUser) recipients.add(normalizedCurrentUser);
    // Include any user that received a regional holiday from the same
    // feed loop above so they pick up nationwide ones too.
    for (const email of userAbsenceDays.keys()) recipients.add(email);
    for (const [date, { reason }] of nationwideHolidays) {
      for (const userEmail of recipients) {
        addAbsenceReason(userAbsenceDays, userEmail, date, reason, 'holiday');
      }
    }
  }

  if (signal?.aborted) {
    return new Map();
  }

  logger.debug(
    `[Absence] ${absenceFeeds.length} absence + ${holidayFeeds.length} holiday feeds → ${userAbsenceDays.size} users with absences in range ${rangeStart}..${rangeEnd}`,
  );

  return userAbsenceDays;
}

/**
 * Fetch absence-type calendar feeds and extract all-day events as absence dates.
 * Returns a Map of date string → AbsenceDay with aggregated reasons.
 */
export async function fetchAbsenceDays(
  feeds: CalendarFeed[],
  assignments: AbsenceAssignment[],
  currentUserEmail: string,
  corsProxy: string,
  rangeStart: string,
  rangeEnd: string,
  signal?: AbortSignal,
): Promise<Map<string, AbsenceDay>> {
  const userAbsenceDays = await fetchAbsenceDaysByUser(
    feeds,
    assignments,
    currentUserEmail,
    corsProxy,
    rangeStart,
    rangeEnd,
    signal,
  );

  return (
    userAbsenceDays.get(currentUserEmail.trim().toLowerCase()) ?? new Map()
  );
}
