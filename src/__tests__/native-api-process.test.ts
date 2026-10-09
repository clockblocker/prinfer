import { expect, test } from "bun:test";
import path from "node:path";
import { version } from "@typescript/native";
import { API } from "@typescript/native/unstable/async";
import {
	type CompilerProcessLookup,
	locateCompilerProcess,
} from "../native-api.js";

const fixtureRoot = path.join(import.meta.dir, "fixtures", "testing");

function describeLookup(lookup: CompilerProcessLookup): string {
	return lookup.status === "missing"
		? `missing (${lookup.reason})`
		: lookup.status;
}

function canaryFailure(when: string, lookup: CompilerProcessLookup): Error {
	return new Error(
		[
			`@typescript/native ${version} no longer keeps its compiler child process at the private API.client.process field: ${when} the lookup was ${describeLookup(lookup)}.`,
			"Without it prinfer/testing cannot unref idle TypeScript 7 sessions; they fall back to closing after IDLE_CLOSE_MS and print a warning telling users to call closeTestingSessions().",
			"Update locateCompilerProcess in src/native-api.ts to wherever this release keeps the process (or to a public handle if it now has one).",
		].join("\n"),
	);
}

/**
 * Canary for the private field NativeApiSession reads to unref idle
 * compiler processes. It fails when a @typescript/native release moves it.
 */
test("canary: @typescript/native keeps its compiler process at API.client.process", async () => {
	const api = new API({ cwd: fixtureRoot });
	try {
		const before = locateCompilerProcess(api);
		if (before.status !== "not-spawned") {
			throw canaryFailure("before the first request", before);
		}
		await api.parseConfigFile(path.join(fixtureRoot, "tsconfig.json"));
		const after = locateCompilerProcess(api);
		if (after.status !== "found") {
			throw canaryFailure("after a request", after);
		}
		expect(after.child.pid).toBeNumber();
		expect(after.child.stdin).not.toBeNull();
		expect(after.child.stdout).not.toBeNull();
	} finally {
		await api.close();
	}
}, 30_000);
