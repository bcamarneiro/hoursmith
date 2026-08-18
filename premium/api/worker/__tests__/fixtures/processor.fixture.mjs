/**
 * Fixture processor (default export) used by runWorker CLI tests (ADA-696).
 */

export default async function fixtureProcessor(job) {
	return { ok: true, jobId: job.id };
}
