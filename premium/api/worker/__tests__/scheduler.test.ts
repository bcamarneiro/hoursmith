/**
 * Tests for the cron scheduler sync (ADA-697).
 *
 * BullMQ is not touched here: the scheduler is exercised against a fake
 * queue implementing exactly the JobScheduler surface it uses
 * (`upsertJobScheduler`, `getJobSchedulers`, `removeJobScheduler`), so the
 * sync semantics (idempotent upsert, stale pruning, fail-loud errors,
 * payload-free logging) are tested without Redis.
 */

import type { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CronTask } from '../cron.js';
import { CronSchedulerError, syncCronTasks } from '../scheduler.js';

interface FakeScheduler {
	key: string;
	pattern?: string;
	every?: number;
}

function makeQueue(initialSchedulers: FakeScheduler[] = []): {
	queue: Queue;
	upsertJobScheduler: ReturnType<typeof vi.fn>;
	getJobSchedulers: ReturnType<typeof vi.fn>;
	removeJobScheduler: ReturnType<typeof vi.fn>;
} {
	const schedulers: FakeScheduler[] = [...initialSchedulers];
	const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
	const getJobSchedulers = vi
		.fn()
		.mockImplementation(async () => [...schedulers]);
	const removeJobScheduler = vi.fn().mockImplementation(async (id: string) => {
		const index = schedulers.findIndex((s) => s.key === id);
		if (index !== -1) {
			schedulers.splice(index, 1);
		}
		return true;
	});
	return {
		queue: {
			name: 'raw-commits',
			upsertJobScheduler,
			getJobSchedulers,
			removeJobScheduler,
		} as unknown as Queue,
		upsertJobScheduler,
		getJobSchedulers,
		removeJobScheduler,
	};
}

const TASKS: readonly CronTask[] = [
	{
		id: 'raw-commits-reconcile',
		queue: 'raw-commits',
		pattern: '*/5 * * * *',
		timezone: 'UTC',
		jobName: 'reconcile',
		data: {},
	},
	{
		id: 'report-rollup',
		queue: 'raw-commits',
		pattern: '0 2 * * *',
		jobName: 'rollup',
		data: { scope: 'daily' },
	},
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe('syncCronTasks', () => {
	it('upserts every task as a BullMQ job scheduler', async () => {
		const { queue, upsertJobScheduler } = makeQueue();
		await syncCronTasks(queue, TASKS);

		expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
		expect(upsertJobScheduler).toHaveBeenCalledWith(
			'raw-commits-reconcile',
			{ pattern: '*/5 * * * *', tz: 'UTC' },
			{ name: 'reconcile', data: {} },
		);
		expect(upsertJobScheduler).toHaveBeenCalledWith(
			'report-rollup',
			{ pattern: '0 2 * * *', tz: undefined },
			{ name: 'rollup', data: { scope: 'daily' } },
		);
	});

	it('defaults job name to the task id and data to an empty object', async () => {
		const { queue, upsertJobScheduler } = makeQueue();
		await syncCronTasks(queue, [
			{ id: 'bare-task', queue: 'raw-commits', pattern: '* * * * *' },
		]);

		expect(upsertJobScheduler).toHaveBeenCalledWith(
			'bare-task',
			expect.anything(),
			{ name: 'bare-task', data: {} },
		);
	});

	it('removes schedulers that are no longer in the registry', async () => {
		const { queue, removeJobScheduler } = makeQueue([
			{ key: 'raw-commits-reconcile', pattern: '*/5 * * * *' },
			{ key: 'zombie-schedule', pattern: '0 0 * * *' },
		]);

		await syncCronTasks(queue, TASKS);

		expect(removeJobScheduler).toHaveBeenCalledWith('zombie-schedule');
		expect(removeJobScheduler).not.toHaveBeenCalledWith(
			'raw-commits-reconcile',
		);
	});

	it('is idempotent: does not remove schedulers that are still wanted', async () => {
		const { queue, removeJobScheduler, upsertJobScheduler } = makeQueue([
			{ key: 'raw-commits-reconcile', pattern: '*/5 * * * *' },
			{ key: 'report-rollup', pattern: '0 2 * * *' },
		]);

		await syncCronTasks(queue, TASKS);

		expect(removeJobScheduler).not.toHaveBeenCalled();
		expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
	});

	it('wraps upsert failures in a CronSchedulerError naming the task and queue', async () => {
		const { queue, upsertJobScheduler } = makeQueue();
		upsertJobScheduler.mockRejectedValueOnce(new Error('pattern is invalid'));

		const error = await syncCronTasks(queue, TASKS).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(CronSchedulerError);
		expect((error as Error).message).toContain(
			'failed to upsert schedule "raw-commits-reconcile" on queue "raw-commits"',
		);
	});

	it('wraps stale-pruning failures in a CronSchedulerError', async () => {
		const { queue, removeJobScheduler } = makeQueue([
			{ key: 'zombie-schedule' },
		]);
		removeJobScheduler.mockRejectedValueOnce(new Error('redis down'));

		const error = await syncCronTasks(queue, TASKS).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(CronSchedulerError);
		expect((error as Error).message).toContain(
			'failed to reconcile stale schedules on queue "raw-commits"',
		);
	});

	it('never logs job payloads, only schedule metadata', async () => {
		const { queue } = makeQueue();
		const log = vi.fn();
		await syncCronTasks(queue, TASKS, { log });

		const logged = JSON.stringify(log.mock.calls);
		expect(logged).not.toContain('scope');
		expect(logged).not.toContain('daily');
		expect(logged).toContain('raw-commits-reconcile');
		expect(logged).toContain('*/5 * * * *');
	});
});
