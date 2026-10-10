import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	MessageChannel,
	type MessagePort,
	receiveMessageOnPort,
	Worker,
} from "node:worker_threads";
import { NameNotFoundError } from "./core/name-lookup.js";
import { PrinferError, TypeScriptInternalError } from "./errors.js";
import type { CompletionOptions, HoverOptions, HoverResult } from "./types.js";

/**
 * Synchronous TypeScript 7 lookups for `prinfer/testing`.
 *
 * `@typescript/native` only has an async API under Bun (its `unstable/sync`
 * entry reads a stdout file descriptor Bun doesn't expose), so the async
 * sessions in native-api.ts run in a worker thread (native-worker.ts,
 * loaded by native-worker-boot.ts so a failed load is reported) and
 * the calling thread blocks in `Atomics.wait` until the worker answers. The
 * answer itself travels over a MessageChannel and is read with
 * `receiveMessageOnPort`; the shared counter only says one is there.
 *
 * The CLI, MCP server and library keep the async sessions: blocking their
 * event loop would stall every other request.
 */

/** How long one call may wait for the worker, cold project load included. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** How long teardown waits for the compiler to shut down cleanly. */
const CLOSE_TIMEOUT_MS = 10_000;

/** How long a timed-out worker gets to kill its compiler processes. */
const ABORT_TIMEOUT_MS = 1_000;

/** The operations the worker runs, by name, with their arguments. */
export interface NativeOperations {
	completionNames: [
		file: string,
		line: number,
		column: number,
		options: CompletionOptions,
	];
	typeInfo: [
		file: string,
		line: number,
		column: number,
		options: HoverOptions,
	];
	typeInfoByName: [
		file: string,
		name: string,
		options: HoverOptions & { line?: number },
	];
	close: [];
	abort: [];
}

interface NativeResults {
	completionNames: string[];
	typeInfo: HoverResult;
	typeInfoByName: HoverResult;
	close: undefined;
	abort: undefined;
}

export type NativeRequest = {
	[K in keyof NativeOperations]: {
		id: number;
		op: K;
		args: NativeOperations[K];
	};
}[keyof NativeOperations];

export type NativeResponse =
	| { id: number; ok: true; value: unknown }
	| {
			id: number;
			ok: false;
			error: SerializedError;
			/** The worker hit an uncaught exception and must be replaced. */
			fatal?: boolean;
			/**
			 * The worker module failed to load (id 0): native-worker-boot.ts
			 * reports it so the waiting call fails now, not at its timeout.
			 */
			startup?: true;
	  };

/** What the worker receives on startup. */
export interface NativeWorkerData {
	port: MessagePort;
	/** Int32 counter the worker bumps after posting each response. */
	signal: SharedArrayBuffer;
	/** URL of native-worker, which native-worker-boot.ts imports. */
	entry: string;
}

/**
 * An error flattened for postMessage. Structured cloning keeps only
 * `message` (and sometimes `name`), so the class, `code`, `suggestion` and
 * other own properties such as `declaredAt` are carried explicitly.
 */
export interface SerializedError {
	/** The class to rebuild: a key of ERROR_CLASSES, or "Error". */
	kind: string;
	name: string;
	message: string;
	stack?: string;
	props: Record<string, unknown>;
	cause?: SerializedError;
}

/**
 * Error classes rebuilt with their prototype, so `instanceof` holds on the
 * calling thread. Subclasses come before the classes they extend.
 */
const ERROR_CLASSES: Record<string, { prototype: Error }> = {
	NameNotFoundError,
	PrinferError,
	TypeScriptInternalError,
};

export function serializeError(error: unknown, depth = 0): SerializedError {
	if (!(error instanceof Error)) {
		return {
			kind: "Error",
			name: "Error",
			message: String(error),
			props: {},
		};
	}
	const props: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(error)) {
		if (key === "cause") continue;
		try {
			// Keep only what survives a clone; drop functions and the like.
			props[key] = structuredClone(value);
		} catch {
			// Not cloneable: leave it out.
		}
	}
	const kind =
		Object.entries(ERROR_CLASSES).find(
			([, errorClass]) => error instanceof (errorClass as typeof Error),
		)?.[0] ?? "Error";
	return {
		kind,
		name: error.name,
		message: error.message,
		stack: error.stack,
		props,
		cause:
			error.cause !== undefined && depth < 5
				? serializeError(error.cause, depth + 1)
				: undefined,
	};
}

export function deserializeError(serialized: SerializedError): Error {
	const prototype =
		ERROR_CLASSES[serialized.kind]?.prototype ?? Error.prototype;
	const error = Object.create(prototype) as Error;
	const hidden = { configurable: true, writable: true, enumerable: false };
	Object.defineProperty(error, "message", {
		...hidden,
		value: serialized.message,
	});
	Object.defineProperty(error, "stack", {
		...hidden,
		value: serialized.stack ?? `${serialized.name}: ${serialized.message}`,
	});
	Object.assign(error, serialized.props);
	if (error.name !== serialized.name) error.name = serialized.name;
	if (serialized.cause) error.cause = deserializeError(serialized.cause);
	return error;
}

/**
 * Where the worker's modules are: next to this module, so src/*.ts when
 * running from source and dist/*.js or .cjs from the ESM or CJS build
 * (where this module is bundled into testing.js, vitest.js and so on).
 * tsup's shims give the CJS build an `import.meta.url`. Tests replace
 * `locate` to simulate a worker that fails to load.
 */
export const nativeWorkerLocator = {
	locate(): { boot: string; entry: string } {
		const self = fileURLToPath(import.meta.url);
		const file = (name: string) =>
			path.join(path.dirname(self), `${name}${path.extname(self)}`);
		return {
			boot: file("native-worker-boot"),
			entry: file("native-worker"),
		};
	},
};

class NativeWorker {
	private readonly worker: Worker;
	private readonly port: MessagePort;
	private readonly signal: Int32Array;
	private nextId = 1;
	/** The thread is gone or can't be trusted; start a new one. */
	broken = false;

	constructor() {
		const { boot, entry } = nativeWorkerLocator.locate();
		// A missing entry would only surface as an error event, which this
		// thread can't see while it waits.
		for (const file of [boot, entry]) {
			if (!fs.existsSync(file)) {
				throw new PrinferError(
					"INTERNAL_ERROR",
					`Cannot find the prinfer TypeScript 7 worker at ${file}.`,
					"prinfer/testing loads it from next to its own module, so import prinfer/testing from the installed package rather than a bundle. Omit backend to use TypeScript 6 meanwhile.",
				);
			}
		}
		const { port1, port2 } = new MessageChannel();
		const signal = new SharedArrayBuffer(4);
		const workerData: NativeWorkerData = {
			port: port2,
			signal,
			entry: pathToFileURL(entry).href,
		};
		this.worker = new Worker(boot, {
			workerData,
			transferList: [port2],
		});
		this.port = port1;
		this.signal = new Int32Array(signal);
		// An idle worker, and the compiler processes it owns, must not keep
		// the test process alive. Nothing listens on port1, so it holds no
		// reference either; responses are only ever read synchronously.
		this.worker.unref();
		this.port.unref();
		// Without listeners, a worker crash would be rethrown on this thread.
		this.worker.on("error", () => {
			this.broken = true;
		});
		this.worker.on("exit", () => {
			this.broken = true;
		});
	}

	/**
	 * Post a request and block until its response arrives, or return
	 * undefined after `timeoutMs`.
	 */
	request<K extends keyof NativeOperations>(
		op: K,
		args: NativeOperations[K],
		timeoutMs: number,
	): NativeResponse | undefined {
		const id = this.nextId++;
		this.port.postMessage({ id, op, args } as NativeRequest);
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			// Read the counter before the queue: a response posted after
			// the read below changes it, so the wait returns at once.
			const seen = Atomics.load(this.signal, 0);
			const received = receiveMessageOnPort(this.port);
			if (received) {
				const response = received.message as NativeResponse;
				// The worker never started: no request will be answered.
				if (!response.ok && response.startup) {
					this.broken = true;
					return response;
				}
				// Older ids answer requests that already timed out.
				if (response.id === id) return response;
				continue;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) return undefined;
			Atomics.wait(this.signal, 0, seen, remaining);
		}
	}

	terminate(): Promise<void> {
		this.broken = true;
		return this.worker.terminate().then(
			() => undefined,
			() => undefined,
		);
	}
}

let current: NativeWorker | undefined;

function worker(): NativeWorker {
	if (!current || current.broken) current = new NativeWorker();
	return current;
}

/**
 * Run a TypeScript 7 operation in the worker and return its result
 * synchronously. Errors thrown in the worker are rethrown here with their
 * class, code and suggestion.
 */
export function callNative<K extends Exclude<keyof NativeOperations, "close">>(
	op: K,
	args: NativeOperations[K],
	timeoutMs = DEFAULT_TIMEOUT_MS,
): NativeResults[K] {
	const target = worker();
	const response = target.request(op, args, timeoutMs);
	if (!response) {
		recycle(target);
		throw new PrinferError(
			"TYPESCRIPT_ERROR",
			`TypeScript 7 did not answer within ${timeoutMs}ms; prinfer stopped its compiler, and the next call starts a new one.`,
			`A cold load of a large project can take that long: raise the limit with timeout (in ms) in the selector, e.g. { timeout: ${timeoutMs * 2} }. If every call times out, check the tsconfig.json that includes the file, or omit backend to use TypeScript 6.`,
		);
	}
	if (response.ok) return response.value as NativeResults[K];
	if (response.startup) {
		void target.terminate();
		throw startupError(deserializeError(response.error));
	}
	if (response.fatal) recycle(target);
	throw deserializeError(response.error);
}

/** The worker module, and so `@typescript/native`, failed to load. */
function startupError(cause: Error): PrinferError {
	const error = new PrinferError(
		"TYPESCRIPT_ERROR",
		`prinfer could not start its TypeScript 7 worker: loading the TypeScript 7 compiler API failed (${cause.message}).`,
		"Check that @typescript/native is installed next to prinfer (it is a dependency) and supports this platform; reinstalling dependencies usually fixes a partial install. Omit backend to use TypeScript 6 meanwhile.",
	);
	error.cause = cause;
	return error;
}

/** Replace a worker that timed out: kill its compilers, then the thread. */
function recycle(target: NativeWorker): void {
	if (current === target) current = undefined;
	if (!target.broken) target.request("abort", [], ABORT_TIMEOUT_MS);
	void target.terminate();
}

/**
 * Shut down the worker and its compiler processes. The compilers are
 * closed before this returns; the promise settles once the thread stops.
 */
export function closeNative(): Promise<void> {
	const target = current;
	current = undefined;
	if (!target) return Promise.resolve();
	if (!target.broken) target.request("close", [], CLOSE_TIMEOUT_MS);
	return target.terminate();
}
