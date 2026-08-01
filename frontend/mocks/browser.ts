import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import {
	createPermanentErrorHandlers,
	getPermanentErrorScenario,
} from './permanentErrors';

// ADA-764: when the URL carries `?mockError=<scenario>`, install the
// permanent-error stub handlers BEFORE the success handlers so every request
// to an affected endpoint fails deterministically — test isolation without
// hand-rolled `page.route()` stubs and without touching the real network.
// No param → no error stubs, pure success-mode offline mocks as before.
const permanentErrorScenario = getPermanentErrorScenario();

export const worker = setupWorker(
	...(permanentErrorScenario
		? createPermanentErrorHandlers(permanentErrorScenario)
		: []),
	...handlers,
);
