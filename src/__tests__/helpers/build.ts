import { expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

export const packageRoot = path.join(import.meta.dir, "..", "..", "..");
const DIST_ENTRIES = ["cli.js", "mcp.js"].map((name) =>
	path.join(packageRoot, "dist", name),
);
/** Build inputs outside src/ that also change dist (e.g. the injected version). */
const BUILD_INPUTS = ["package.json", "tsup.config.ts"].map((name) =>
	path.join(packageRoot, name),
);

function newestSourceMtime(dir: string): number {
	let newest = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__") {
				newest = Math.max(newest, newestSourceMtime(full));
			}
		} else if (entry.name.endsWith(".ts")) {
			newest = Math.max(newest, fs.statSync(full).mtimeMs);
		}
	}
	return newest;
}

/** True when dist is missing or older than any source or build input. */
export function distIsStale(): boolean {
	if (!DIST_ENTRIES.every((entry) => fs.existsSync(entry))) return true;
	const built = Math.min(
		...DIST_ENTRIES.map((entry) => fs.statSync(entry).mtimeMs),
	);
	const inputs = Math.max(
		newestSourceMtime(path.join(packageRoot, "src")),
		...BUILD_INPUTS.map((file) => fs.statSync(file).mtimeMs),
	);
	return built < inputs;
}

/** Rebuild dist when it is stale, so subprocess tests never run old code. */
export function ensureFreshBuild(): void {
	if (!distIsStale()) return;
	const build = Bun.spawnSync(["bun", "run", "build"], {
		cwd: packageRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(build.exitCode).toBe(0);
}
