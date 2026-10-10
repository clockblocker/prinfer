import { createRequire } from "node:module";
import type { TypeScript } from "../../core/ts-runtime.js";

const require = createRequire(import.meta.url);

/**
 * A second, separately evaluated copy of the bundled `typescript`: the
 * same version, but none of its objects are the bundled instance's, as
 * with a project's own compiler.
 */
export function freshTypeScript(): TypeScript {
	const resolved = require.resolve("typescript");
	const cached = require.cache[resolved];
	delete require.cache[resolved];
	try {
		return require(resolved) as TypeScript;
	} finally {
		if (cached) require.cache[resolved] = cached;
	}
}
