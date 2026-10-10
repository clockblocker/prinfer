import { workerData } from "node:worker_threads";
import type {
	NativeResponse,
	NativeWorkerData,
	SerializedError,
} from "./native-sync.js";

/**
 * Entry of the worker thread behind the synchronous TypeScript 7 helpers.
 *
 * It imports nothing that can fail to load, then loads the real worker
 * (native-worker.ts, which loads the compiler API on first use) dynamically. If
 * that import throws, the thread would otherwise just die: its error event
 * can't reach a calling thread blocked in `Atomics.wait`, so every call
 * would wait out its full timeout. Instead the failure is posted as a
 * startup response and the waiting thread is woken, so the call fails at
 * once with the reason.
 *
 * Only type imports here: anything bundled into this entry runs before the
 * catch below can see it fail.
 */

const { port, signal, entry } = workerData as NativeWorkerData;

import(entry).catch((error: unknown) => {
	const failure: NativeResponse = {
		id: 0,
		ok: false,
		startup: true,
		error: flatten(error),
	};
	port.postMessage(failure);
	const counter = new Int32Array(signal);
	Atomics.add(counter, 0, 1);
	Atomics.notify(counter, 0);
});

/** A minimal serializeError (native-sync.ts can't be loaded from here). */
function flatten(error: unknown): SerializedError {
	if (!(error instanceof Error)) {
		return {
			kind: "Error",
			name: "Error",
			message: String(error),
			props: {},
		};
	}
	const code = (error as { code?: unknown }).code;
	return {
		kind: "Error",
		name: error.name,
		message: error.message,
		stack: error.stack,
		props: typeof code === "string" ? { code } : {},
	};
}
