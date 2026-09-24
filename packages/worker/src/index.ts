import { handle, type Env } from './worker.ts';

/**
 * The entrypoint, and nothing else.
 *
 * The runtime reads every named export of the main module as an entrypoint
 * and refuses to start on one that is not a handler, so a constant like
 * EMBEDDING_DIMS exported from here stops the worker from booting at all
 * ("Incorrect type for map entry"). The logic and everything the tests and the
 * ingest import live in worker.ts; this file exports only the handler.
 */
export default { fetch: handle } satisfies { fetch: (r: Request, e: Env) => Promise<Response> };
