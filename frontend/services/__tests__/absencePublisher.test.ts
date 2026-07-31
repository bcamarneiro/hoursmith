import { describe, expect, it, vi } from 'vitest';
import {
	mapAndPublish,
	publishAbsenceRecords,
	type AbsencePublishSink,
} from '../absencePublisher';
import type { UserAbsenceUpsert } from '../absences';

const record = (overrides: Partial<UserAbsenceUpsert> = {}): UserAbsenceUpsert => ({
	user_id: 'bruno@example.com',
	provider_id: null,
	absence_date: '2026-04-07',
	kind: 'vacation',
	reason: 'Bruno C - Vacation',
	...overrides,
});

describe('publishAbsenceRecords', () => {
	it('publishes the whole batch when the sink succeeds', async () => {
		const sink = vi.fn<AbsencePublishSink>(async () => {});
		const records = [record(), record({ absence_date: '2026-04-08' })];

		const result = await publishAbsenceRecords(records, sink);

		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink).toHaveBeenCalledWith(records);
		expect(result).toEqual({
			attempted: 2,
			published: 2,
			failed: 0,
			failures: [],
		});
	});

	it('falls back to per-record delivery when the batch rejects', async () => {
		const sink = vi.fn<AbsencePublishSink>(async (records) => {
			if (records.length > 1) throw new Error('batch too big');
			if (records[0].absence_date === '2026-04-09') {
				throw new Error('provider rejected');
			}
		});
		const records = [
			record(),
			record({ absence_date: '2026-04-08' }),
			record({ absence_date: '2026-04-09' }),
		];

		const result = await publishAbsenceRecords(records, sink);

		expect(result.attempted).toBe(3);
		expect(result.published).toBe(2);
		expect(result.failed).toBe(1);
		expect(result.failures).toEqual([
			{ index: 2, reason: 'provider rejected' },
		]);
		// Batch attempt + 3 single-record attempts.
		expect(sink).toHaveBeenCalledTimes(4);
	});

	it('never throws and reports every record as failed when the sink always throws', async () => {
		const sink = vi.fn<AbsencePublishSink>(async () => {
			throw new Error('down');
		});

		const result = await publishAbsenceRecords([record(), record()], sink);

		expect(result.published).toBe(0);
		expect(result.failed).toBe(2);
		expect(result.failures).toHaveLength(2);
		expect(result.failures[0]).toEqual({ index: 0, reason: 'down' });
	});

	it('is a no-op for empty records and never calls the sink', async () => {
		const sink = vi.fn<AbsencePublishSink>(async () => {});

		const result = await publishAbsenceRecords([], sink);

		expect(result).toEqual({
			attempted: 0,
			published: 0,
			failed: 0,
			failures: [],
		});
		expect(sink).not.toHaveBeenCalled();
	});

	it('falls back to the default log sink when no sink is provided', async () => {
		const result = await publishAbsenceRecords([record()]);

		expect(result).toEqual({
			attempted: 1,
			published: 1,
			failed: 0,
			failures: [],
		});
	});
});

describe('mapAndPublish', () => {
	it('invokes the publisher upon successful mapping', async () => {
		const records = [record(), record({ absence_date: '2026-04-08' })];
		const sink = vi.fn<AbsencePublishSink>(async () => {});
		const produce = vi.fn(async () => records);

		const result = await mapAndPublish(produce, sink);

		expect(produce).toHaveBeenCalledTimes(1);
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink).toHaveBeenCalledWith(records);
		expect(result.published).toBe(2);
		expect(result.failed).toBe(0);
	});

	it('is fail-safe when mapping throws: logs, reports, and never publishes', async () => {
		const sink = vi.fn<AbsencePublishSink>(async () => {});

		const result = await mapAndPublish(
			() => {
				throw new Error('boom');
			},
			sink,
		);

		expect(sink).not.toHaveBeenCalled();
		expect(result).toEqual({
			attempted: 0,
			published: 0,
			failed: 0,
			failures: [{ index: -1, reason: 'boom' }],
			mappingError: 'boom',
		});
	});
});
