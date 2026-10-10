import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Runs one of typeprobe's bin scripts (dist/cli.js or dist/mcp.js) in this
 * process. typeprobe's exports don't expose dist/, so the script is found
 * next to its main entry. argv[1] is pointed at the script because
 * `typeprobe mcp` looks for dist/mcp.js next to it.
 */
export async function forward(script) {
	const main = createRequire(import.meta.url).resolve("typeprobe");
	const entry = path.join(path.dirname(main), script);
	process.argv[1] = entry;
	await import(pathToFileURL(entry).href);
}
