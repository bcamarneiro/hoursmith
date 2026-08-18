/**
 * Fixture processor (named `processor` export) used by runWorker CLI tests
 * (ADA-696).
 */

export const processor = async function namedProcessor(job) {
	return { named: true, jobId: job.id };
};
