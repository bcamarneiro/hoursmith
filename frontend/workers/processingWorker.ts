/**
 * Processing Web Worker — offloads classify/aggregate/CSV from the main thread.
 *
 * Bundled by rspack as a separate chunk via `new Worker(new URL(…, import.meta.url))`.
 * Imports only pure functions with no DOM dependencies.
 */

import { processMessage } from './processingWorker.handlers';
import type {
	ProcessingWorkerRequest,
	ProcessingWorkerResponse,
} from './processingWorker.types';

self.addEventListener('message', (event: MessageEvent<ProcessingWorkerRequest>) => {
	const response: ProcessingWorkerResponse = processMessage(event.data);
	self.postMessage(response);
});
