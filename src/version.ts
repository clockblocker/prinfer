import { readFileSync } from "node:fs";

declare const __PRINFER_VERSION__: string | undefined;

/**
 * Package version: injected by tsup at build time, read from package.json
 * when running from source (src/ and dist/ both sit next to it).
 */
export const VERSION: string =
	typeof __PRINFER_VERSION__ === "string"
		? __PRINFER_VERSION__
		: readPackageVersion();

function readPackageVersion(): string {
	try {
		const pkg = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "0.0.0-dev";
	} catch {
		return "0.0.0-dev";
	}
}
