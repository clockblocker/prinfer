import fs from "node:fs";
import path from "node:path";

/**
 * Parsing of the CLI's `<file>:<target>` argument and options, shared by
 * every command and kept free of side effects (failures go through the
 * caller's `fail`) so it can be unit tested.
 */

/** A target as written on the command line, before any flag is applied. */
export type ParsedTarget =
	| { kind: "position"; file: string; line: number; column: number }
	| { kind: "text"; file: string; line: number; text: string }
	| { kind: "line"; file: string; line: number }
	| { kind: "name"; file: string; name: string; line?: number };

/** A JavaScript identifier: Unicode ID_Start/ID_Continue, `$`, and `_`. */
const IDENTIFIER = "[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200C\\u200D]*";

/** `.ts:`, `.tsx:`, `.mjs:`, ...: a source file name followed by more target. */
const SOURCE_EXTENSION_COLON = /\.[cm]?[jt]sx?:/i;
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/i;

type Shape = (arg: string) => ParsedTarget | undefined;

/**
 * The accepted shapes, in precedence order. The segments after the file
 * decide the form:
 *
 * 1. `<file>:<digits>:<digits>`       line and column
 * 2. `<file>:<identifier>:<digits>`   name with a line hint
 * 3. `<file>:<digits>:<anything>`     line and text (text may hold colons)
 * 4. `<file>:<identifier>`            name
 * 5. `<file>:<digits>`                line only; needs --text
 *
 * Identifiers never start with a digit, so 1 and 2 cannot collide, and
 * all-digit text is always a column (1 before 3).
 */
const SHAPES: Shape[] = [
	(arg) => {
		const match = /^(.+):(\d+):(\d+)$/.exec(arg);
		return match
			? {
					kind: "position",
					file: match[1] as string,
					line: Number(match[2]),
					column: Number(match[3]),
				}
			: undefined;
	},
	(arg) => {
		const match = new RegExp(`^(.+):(${IDENTIFIER}):(\\d+)$`, "u").exec(
			arg,
		);
		return match
			? {
					kind: "name",
					file: match[1] as string,
					name: match[2] as string,
					line: Number(match[3]),
				}
			: undefined;
	},
	(arg) => {
		// Lazy file: the text is everything after the first `:<line>:`.
		const match = /^(.+?):(\d+):(.+)$/s.exec(arg);
		return match
			? {
					kind: "text",
					file: match[1] as string,
					line: Number(match[2]),
					text: match[3] as string,
				}
			: undefined;
	},
	(arg) => {
		const match = new RegExp(`^(.+):(${IDENTIFIER})$`, "u").exec(arg);
		return match
			? {
					kind: "name",
					file: match[1] as string,
					name: match[2] as string,
				}
			: undefined;
	},
	(arg) => {
		const match = /^(.+):(\d+)$/.exec(arg);
		return match
			? { kind: "line", file: match[1] as string, line: Number(match[2]) }
			: undefined;
	},
];

/**
 * Parse `<file>:<target>`. A shape whose file part still holds a source
 * file name followed by a colon (`a.ts:foo` from `a.ts:foo:bar`) is skipped
 * unless that path exists, so a malformed target is reported as such rather
 * than as a missing file. Returns null when no shape fits.
 */
export function parseTargetArg(
	arg: string,
	cwd: string = process.cwd(),
): ParsedTarget | null {
	for (const shape of SHAPES) {
		const parsed = shape(arg);
		if (parsed && plausibleFile(parsed.file, cwd)) return parsed;
	}
	return null;
}

function plausibleFile(file: string, cwd: string): boolean {
	return (
		!SOURCE_EXTENSION_COLON.test(file) ||
		fs.existsSync(path.resolve(cwd, file))
	);
}

/**
 * A hint for arguments the shell probably rewrote before prinfer saw them:
 * an expanded or leftover `$` (`src/store.ts:$store` unquoted loses
 * `$store`), or a zsh modifier applied to a variable (`$F:root` becomes
 * `${F:r}oot`, a path without its extension).
 */
export function shellHint(arg: string): string | undefined {
	if (arg.includes("$") || /:$|::/.test(arg)) {
		return "If the target has a $ (as in $name identifiers), single-quote the whole argument so the shell keeps it: 'src/store.ts:$store'.";
	}
	if (!SOURCE_EXTENSION.test(arg) && !SOURCE_EXTENSION_COLON.test(arg)) {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
		return 'If you built it from a shell variable: zsh reads $F:r, :t, :h, ... as modifiers ("$F:root" becomes "${F:r}oot"). Write "${F}:root" or single-quote the argument.';
	}
	return undefined;
}

/** Option name, the key it sets, and whether it takes a value. */
export const FLAGS: Record<string, { key: string; value?: true }> = {
	"--docs": { key: "docs" },
	"-d": { key: "docs" },
	"--cost": { key: "cost" },
	// Deprecated: accepted with a warning, no longer reported.
	"--timing": { key: "timing" },
	"-t": { key: "timing" },
	"--full": { key: "full" },
	"-f": { key: "full" },
	"--sort-unions": { key: "sortUnions" },
	"--json": { key: "json" },
	"--suggestions": { key: "suggestions" },
	"--text": { key: "text", value: true },
	"--occurrence": { key: "occurrence", value: true },
	"--max-chars": { key: "maxChars", value: true },
	"--project": { key: "project", value: true },
	"-p": { key: "project", value: true },
	"--backend": { key: "backend", value: true },
	"--prefix": { key: "prefix", value: true },
	"--limit": { key: "limit", value: true },
};

/**
 * Split args into positionals and option values. Value options accept
 * `--opt value` and `--opt=value`; unknown options are errors.
 */
export function parseFlags(
	args: string[],
	allowed: Set<string>,
	commandName: string,
	fail: (message: string) => never,
): { positionals: string[]; values: Map<string, string | true> } {
	const positionals: string[] = [];
	const values = new Map<string, string | true>();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (!arg.startsWith("-") || arg === "-") {
			positionals.push(arg);
			continue;
		}
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = eq >= 0 ? arg.slice(0, eq) : arg;
		const flag = FLAGS[name];
		if (!flag) return fail(`Unknown option ${name}.`);
		if (!allowed.has(flag.key)) {
			fail(`${name} is not an option of ${commandName}.`);
		}
		if (!flag.value) {
			if (eq >= 0) fail(`${name} takes no value.`);
			values.set(flag.key, true);
			continue;
		}
		const value = eq >= 0 ? arg.slice(eq + 1) : args[++index];
		// Only --prefix accepts an empty value ("" lists every entry).
		if (value === undefined || (value === "" && name !== "--prefix")) {
			fail(
				name === "--prefix"
					? '--prefix requires text (pass "" to list every entry).'
					: name === "--project" || name === "-p"
						? `${name} requires a path argument.`
						: `${name} requires a value.`,
			);
		}
		values.set(flag.key, value);
	}
	return { positionals, values };
}
