import { workerData } from "node:worker_threads";
import {
	closeNativeApiSessions,
	killNativeApiSessions,
	nativeApiCompletionNames,
	nativeApiTypeInfo,
	nativeApiTypeInfoByName,
} from "./native-api.js";
import {
	type NativeRequest,
	type NativeResponse,
	type NativeWorkerData,
	serializeError,
} from "./native-sync.js";

/**
 * Worker thread behind the synchronous TypeScript 7 helpers in
 * native-sync.ts: runs the async native-api sessions, compiler-exit
 * recovery included, and answers each request on the port.
 */

const { port, signal } = workerData as NativeWorkerData;
const counter = new Int32Array(signal);
const pending = new Set<number>();
/** Set by an uncaught exception: the thread's state can't be trusted. */
let crashed: unknown;

port.on("message", (request: NativeRequest) => {
	pending.add(request.id);
	if (crashed !== undefined) {
		respond(fatal(request.id, crashed));
		return;
	}
	run(request).then(
		(value) => respond({ id: request.id, ok: true, value }),
		(error: unknown) =>
			respond({
				id: request.id,
				ok: false,
				error: serializeError(error),
			}),
	);
});

async function run(request: NativeRequest): Promise<unknown> {
	switch (request.op) {
		case "completionNames":
			return nativeApiCompletionNames(...request.args);
		case "typeInfo":
			return nativeApiTypeInfo(...request.args);
		case "typeInfoByName":
			return nativeApiTypeInfoByName(...request.args);
		case "close":
			return closeNativeApiSessions();
		case "abort":
			return killNativeApiSessions();
	}
}

function respond(response: NativeResponse): void {
	if (!pending.delete(response.id)) return;
	try {
		port.postMessage(response);
	} catch (error) {
		// A value that can't be cloned must still answer the request.
		port.postMessage({
			id: response.id,
			ok: false,
			error: serializeError(error),
		} satisfies NativeResponse);
	}
	// Post first, then bump: the waiting thread reads the counter before
	// the port, so it never sleeps through a response already queued.
	Atomics.add(counter, 0, 1);
	Atomics.notify(counter, 0);
}

// Writing to a compiler process that is exiting can reject inside
// vscode-jsonrpc with nobody listening. The session that made the request
// races the exit and retries, so the request still settles; without this
// handler Node would end the thread and the caller would wait for its
// timeout.
process.on("unhandledRejection", () => undefined);

// Anything else is a bug: fail what is in flight right away, and have the
// caller start a fresh worker.
process.on("uncaughtException", (error) => {
	crashed = error;
	for (const id of [...pending]) respond(fatal(id, error));
});

function fatal(id: number, error: unknown): NativeResponse {
	return { id, ok: false, error: serializeError(error), fatal: true };
}
