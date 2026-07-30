/**
 * CRUD endpoint for per-user, per-date day notes.
 *
 * `GET /api/day-notes`           — list all notes for the authenticated user.
 * `PUT /api/day-notes`           — upsert a note `{ date, note }`.
 * `DELETE /api/day-notes`         — remove a note `{ date }`.
 *
 * The Supabase JWT identifies the user. The endpoint uses the service-role key
 * for writes so that the client does not need RLS insert/update/delete policies
 * — only SELECT (read-own). No anon or authenticated client writes.
 *
 * Logging discipline:
 *   DO log:    timestamp, event type, success/error code, user_id.
 *   DO NOT log: note contents.
 *
 * Linear: ADA-594.
 */

import { userIdFromToken } from '../_lib/auth.js';
import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
	type DayNoteRow,
} from '../_lib/supabaseAdmin.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface DayNotesDeps {
	admin?: SupabaseAdminClient;
	verifyJwt?: (token: string) => Promise<string | null>;
}

export default async function handler(request: Request): Promise<Response> {
	return handleDayNotes(request);
}

export async function handleDayNotes(
	request: Request,
	deps: DayNotesDeps = {},
): Promise<Response> {
	const method = request.method;

	if (method === 'OPTIONS') {
		return new Response(null, { status: 204 });
	}

	if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		logEvent({ event: 'day_notes', status: 401, note: 'missing_token' });
		return jsonResponse(401, { error: 'missing_token' });
	}

	let admin: SupabaseAdminClient;
	try {
		admin = deps.admin ?? defaultSupabaseAdmin();
	} catch (err) {
		logEvent({
			event: 'day_notes',
			status: 500,
			note: `server_misconfigured:${(err as Error).message}`,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	const verifyJwt =
		deps.verifyJwt ??
		((t: string) => userIdFromToken(t, { confirmWithServer: true }));
	const userId = await verifyJwt(token);
	if (!userId) {
		logEvent({ event: 'day_notes', status: 401, note: 'invalid_token' });
		return jsonResponse(401, { error: 'invalid_token' });
	}

	try {
		switch (method) {
			case 'GET':
				return await handleGet(userId, admin);
			case 'PUT':
				return await handlePut(request, userId, admin);
			case 'DELETE':
				return await handleDelete(request, userId, admin);
			default:
				return jsonResponse(405, { error: 'method_not_allowed' });
		}
	} catch (err) {
		logEvent({
			event: 'day_notes',
			status: 500,
			userId,
			note: `handler_error:${(err as Error).message}`,
		});
		return jsonResponse(500, { error: 'internal_error' });
	}
}

async function handleGet(
	userId: string,
	admin: SupabaseAdminClient,
): Promise<Response> {
	const notes = await admin.getDayNotes(userId);
	logEvent({ event: 'day_notes', status: 200, userId, note: 'list' });
	return jsonResponse(200, { notes: notes.map(serializeNote) });
}

async function handlePut(
	request: Request,
	userId: string,
	admin: SupabaseAdminClient,
): Promise<Response> {
	let body: { date?: string; note?: string };
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		logEvent({ event: 'day_notes', status: 400, userId, note: 'invalid_json' });
		return jsonResponse(400, { error: 'invalid_json' });
	}

	if (!body.date || typeof body.date !== 'string') {
		logEvent({ event: 'day_notes', status: 400, userId, note: 'missing_date' });
		return jsonResponse(400, { error: 'missing_date' });
	}

	if (typeof body.note !== 'string') {
		logEvent({
			event: 'day_notes',
			status: 400,
			userId,
			note: 'missing_note',
		});
		return jsonResponse(400, { error: 'missing_note' });
	}

	// Validate date format (YYYY-MM-DD).
	if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
		logEvent({
			event: 'day_notes',
			status: 400,
			userId,
			note: 'invalid_date_format',
		});
		return jsonResponse(400, { error: 'invalid_date_format' });
	}

	if (!body.note.trim()) {
		// Empty note — delete instead.
		try {
			await admin.deleteDayNote(userId, body.date);
			logEvent({ event: 'day_notes', status: 200, userId, note: 'delete_via_empty_note' });
			return jsonResponse(200, { deleted: true, date: body.date });
		} catch (err) {
			logEvent({
				event: 'day_notes',
				status: 500,
				userId,
				note: `delete_failed:${(err as Error).message}`,
			});
			return jsonResponse(500, { error: 'internal_error' });
		}
	}

	await admin.upsertDayNote({
		userId,
		date: body.date,
		note: body.note.trim(),
	});
	logEvent({ event: 'day_notes', status: 200, userId, note: 'upsert' });
	return jsonResponse(200, { ok: true, date: body.date });
}

async function handleDelete(
	request: Request,
	userId: string,
	admin: SupabaseAdminClient,
): Promise<Response> {
	let body: { date?: string };
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		logEvent({
			event: 'day_notes',
			status: 400,
			userId,
			note: 'invalid_json',
		});
		return jsonResponse(400, { error: 'invalid_json' });
	}

	if (!body.date || typeof body.date !== 'string') {
		logEvent({
			event: 'day_notes',
			status: 400,
			userId,
			note: 'missing_date',
		});
		return jsonResponse(400, { error: 'missing_date' });
	}

	// Validate date format (YYYY-MM-DD).
	if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
		logEvent({
			event: 'day_notes',
			status: 400,
			userId,
			note: 'invalid_date_format',
		});
		return jsonResponse(400, { error: 'invalid_date_format' });
	}

	await admin.deleteDayNote(userId, body.date);
	logEvent({ event: 'day_notes', status: 200, userId, note: 'delete' });
	return jsonResponse(200, { deleted: true, date: body.date });
}

function serializeNote(row: DayNoteRow) {
	return {
		id: row.id,
		date: row.date,
		note: row.note,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function extractBearer(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const token = match[1].trim();
	return token.length > 0 ? token : null;
}

function jsonResponse(
	status: number,
	body: Record<string, unknown>,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

interface LogFields {
	event: string;
	status: number;
	userId?: string;
	note?: string;
}

function logEvent(fields: LogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-day-notes',
			event: fields.event,
			status: fields.status,
			...(fields.userId ? { user_id: fields.userId } : {}),
			...(fields.note ? { note: fields.note } : {}),
		}),
	);
}
