import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER_NAME = "typeprobe";
/**
 * The server name setup wrote before the package was renamed from prinfer.
 * Setup replaces such an entry instead of adding a second server.
 */
const LEGACY_SERVER_NAME = "prinfer";
const NPX_COMMAND = ["npx", "-y", "typeprobe", "mcp"];

export const SETUP_HELP = `
typeprobe setup - configure an agent to use the typeprobe MCP server

Usage:
  typeprobe setup <client> [--scope <scope>] [--npx] [--print]
  typeprobe setup agents-md [--file <path>] [--print]

Clients:
  codex       Codex: runs codex mcp add
  claude      Claude Code: runs claude mcp add (--scope local|project|user)
  cursor      Cursor: ~/.cursor/mcp.json (project: .cursor/mcp.json)
  vscode      VS Code: runs code --add-mcp (project: .vscode/mcp.json)
  gemini      Gemini CLI: ~/.gemini/settings.json (project: .gemini/settings.json)
  agents-md   Adds typeprobe usage instructions to ./AGENTS.md

Options:
  --scope <scope>  user (default) or project; claude also accepts local
  --npx            Launch the server with 'npx -y typeprobe mcp'
  --file <path>    Instructions file for agents-md, e.g. CLAUDE.md
  --print          Show the command or file change without applying it

The server command is 'typeprobe-mcp' when typeprobe is installed globally,
otherwise 'npx -y typeprobe mcp'. Use --npx if the client cannot find
typeprobe-mcp (editors started outside a shell may miss nvm, fnm, or volta
paths).
Re-running setup updates the typeprobe entry's command; JSON configs keep any
other keys you added to it, such as env. A 'prinfer' entry left from before
the rename is replaced by the typeprobe one (JSON configs carry its other
keys over, with PRINFER_* env names renamed to TYPEPROBE_*).
On Windows the server is launched through 'cmd /c' so npx and npm's .cmd
shims resolve.
`.trim();

type Scope = "local" | "project" | "user";

interface SetupOptions {
	print: boolean;
	npx: boolean;
	scope?: Scope;
	file?: string;
}

interface CliClient {
	kind: "cli";
	label: string;
	scopes: Scope[];
	restart: string;
	binary: string;
	commands(
		server: string[],
		scope: Scope,
	): { remove?: string[][]; add: string[] };
}

interface JsonClient {
	kind: "json";
	label: string;
	scopes: Scope[];
	restart: string;
	file(scope: Scope): string;
	key: string;
	entry(server: string[]): Record<string, unknown>;
}

type Client = CliClient | JsonClient;

const CLIENTS: Record<string, Client> = {
	codex: {
		kind: "cli",
		label: "Codex",
		scopes: ["user"],
		restart: "Restart Codex to load the MCP server.",
		binary: "codex",
		commands: (server) => ({
			remove: [LEGACY_SERVER_NAME, SERVER_NAME].map((name) => [
				"codex",
				"mcp",
				"remove",
				name,
			]),
			add: ["codex", "mcp", "add", SERVER_NAME, "--", ...server],
		}),
	},
	claude: {
		kind: "cli",
		label: "Claude Code",
		scopes: ["user", "project", "local"],
		restart:
			"Restart Claude Code (or run /mcp in a session) to load the MCP server.",
		binary: "claude",
		commands: (server, scope) => ({
			remove: [LEGACY_SERVER_NAME, SERVER_NAME].map((name) => [
				"claude",
				"mcp",
				"remove",
				"--scope",
				scope,
				name,
			]),
			add: [
				"claude",
				"mcp",
				"add",
				"--scope",
				scope,
				SERVER_NAME,
				"--",
				...server,
			],
		}),
	},
	cursor: {
		kind: "json",
		label: "Cursor",
		scopes: ["user", "project"],
		restart: "Restart Cursor to load the MCP server.",
		file: (scope) =>
			scope === "project"
				? path.resolve(".cursor", "mcp.json")
				: path.join(os.homedir(), ".cursor", "mcp.json"),
		key: "mcpServers",
		entry: ([command, ...args]) => ({ type: "stdio", command, args }),
	},
	gemini: {
		kind: "json",
		label: "Gemini CLI",
		scopes: ["user", "project"],
		restart: "Restart Gemini CLI to load the MCP server.",
		file: (scope) =>
			scope === "project"
				? path.resolve(".gemini", "settings.json")
				: path.join(os.homedir(), ".gemini", "settings.json"),
		key: "mcpServers",
		entry: ([command, ...args]) => ({ command, args }),
	},
};

const VSCODE_RESTART =
	"Reload VS Code (Developer: Reload Window) to load the MCP server.";

const VSCODE_USER: CliClient = {
	kind: "cli",
	label: "VS Code",
	scopes: ["user"],
	restart: VSCODE_RESTART,
	binary: "code",
	commands: ([command, ...args]) => ({
		add: [
			"code",
			"--add-mcp",
			JSON.stringify({ name: SERVER_NAME, type: "stdio", command, args }),
		],
	}),
};

const VSCODE_PROJECT: JsonClient = {
	kind: "json",
	label: "VS Code",
	scopes: ["project"],
	restart: VSCODE_RESTART,
	file: () => path.resolve(".vscode", "mcp.json"),
	key: "servers",
	entry: ([command, ...args]) => ({ type: "stdio", command, args }),
};

const CLIENT_NAMES = [...Object.keys(CLIENTS), "vscode", "agents-md"];

const AGENTS_START = "<!-- typeprobe:start -->";
const AGENTS_END = "<!-- typeprobe:end -->";
const LEGACY_AGENTS_START = `<!-- ${LEGACY_SERVER_NAME}:start -->`;
const LEGACY_AGENTS_END = `<!-- ${LEGACY_SERVER_NAME}:end -->`;

export const AGENTS_BLOCK = `${AGENTS_START}
## TypeScript types (typeprobe)

The typeprobe MCP server reports what the TypeScript compiler infers. Reach for it when:
- Adding a type annotation, or unsure what a variable, generic or call infers: \`hover_by_name(file, name)\`; for a token without a unique name, \`hover(file, line, text)\` with text copied from the line. Several lookups go in one \`batch_hover\`. Annotate only when inference is wrong or too wide; \`annotations(file)\` lists annotations TypeScript would infer anyway.
- Choosing a value for a typed slot (union member, option key, overload): \`completions(file, line, column, prefix?)\` lists what TypeScript accepts there.
- Finishing an edit to .ts/.tsx files: run \`diagnostics(file)\` on each; the edit is done when none reports an error.
- Writing type regression tests: \`typeprobe/testing\` (dev dependency \`typeprobe\`) snapshots an inferred type: \`expect(inferredType(import.meta.url, { name })).toMatchInlineSnapshot()\`.
- Working without MCP: \`npx typeprobe file.ts:name --json\` (type), \`npx typeprobe complete file.ts:line:col --json\` (completions), \`npx typeprobe check file.ts --json\` (type errors).
${AGENTS_END}`;

class SetupError extends Error {}

/**
 * Runs `typeprobe setup ...` (args exclude "setup") and returns an exit code.
 * platform is injectable so Windows behaviour can be tested anywhere.
 */
export function runSetup(
	args: string[],
	platform: NodeJS.Platform = process.platform,
): number {
	try {
		const [target, options] = parseSetupArgs(args);
		if (target === undefined) {
			console.log(SETUP_HELP);
			return 0;
		}
		if (target === "agents-md") {
			setupAgentsMd(options);
			return 0;
		}
		setupClient(target, options, platform);
		return 0;
	} catch (error) {
		if (!(error instanceof SetupError)) throw error;
		console.error(`[error] ${error.message}`);
		return 1;
	}
}

function parseSetupArgs(
	args: string[],
): [target: string | undefined, options: SetupOptions] {
	const options: SetupOptions = { print: false, npx: false };
	let target: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case "--print":
				options.print = true;
				break;
			case "--npx":
				options.npx = true;
				break;
			case "--help":
			case "-h":
				return [undefined, options];
			case "--scope":
			case "--file": {
				const value = args[++index];
				if (!value || value.startsWith("--")) {
					throw new SetupError(`${arg} requires a value.`);
				}
				if (arg === "--file") {
					options.file = value;
				} else if (
					value === "user" ||
					value === "project" ||
					value === "local"
				) {
					options.scope = value;
				} else {
					throw new SetupError(
						`Unknown scope "${value}". Use local, project, or user.`,
					);
				}
				break;
			}
			default:
				if (arg.startsWith("-")) {
					throw new SetupError(`Unknown setup option ${arg}.`);
				}
				if (target !== undefined) {
					throw new SetupError(`Unexpected argument "${arg}".`);
				}
				target = arg;
		}
	}
	if (target !== undefined && !CLIENT_NAMES.includes(target)) {
		throw new SetupError(
			`Unknown setup client "${target}". Supported clients: ${CLIENT_NAMES.join(", ")}.\nRun 'typeprobe setup --help' for details.`,
		);
	}
	if (options.file !== undefined && target !== "agents-md") {
		throw new SetupError(
			"--file only applies to 'typeprobe setup agents-md'.",
		);
	}
	return [target, options];
}

function resolveClient(name: string, scope: Scope | undefined): Client {
	if (name === "vscode") {
		const resolved = scope ?? "user";
		if (resolved === "local") {
			throw new SetupError(
				"VS Code supports --scope user or --scope project.",
			);
		}
		return resolved === "project" ? VSCODE_PROJECT : VSCODE_USER;
	}
	const client = CLIENTS[name];
	if (scope && !client.scopes.includes(scope)) {
		throw new SetupError(
			client.scopes.length === 1
				? `${client.label} does not support --scope.`
				: `${client.label} supports --scope ${client.scopes.join(", ")}.`,
		);
	}
	return client;
}

/**
 * The command an MCP client should launch, without absolute paths. A
 * typeprobe-mcp found only in a node_modules/.bin directory (the npx or bunx
 * cache, or a project-local install) is not on the client's PATH, so it falls
 * back to npx.
 */
export function serverCommand(
	forceNpx: boolean,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const server =
		!forceNpx &&
		findOnPath("typeprobe-mcp", { skipPackageBins: true, platform })
			? ["typeprobe-mcp"]
			: [...NPX_COMMAND];
	// MCP clients spawn the command without a shell, which on Windows cannot
	// run npx.cmd or npm's typeprobe-mcp.cmd shim; cmd /c resolves them.
	return platform === "win32" ? ["cmd", "/c", ...server] : server;
}

function isPackageBin(dir: string): boolean {
	const parts = path.resolve(dir).split(path.sep);
	return parts.at(-1) === ".bin" && parts.at(-2) === "node_modules";
}

function findOnPath(
	name: string,
	{
		skipPackageBins = false,
		platform = process.platform,
	}: { skipPackageBins?: boolean; platform?: NodeJS.Platform } = {},
): string | undefined {
	const extensions =
		platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
			: [""];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir || (skipPackageBins && isPackageBin(dir))) continue;
		for (const extension of extensions) {
			const candidate = path.join(dir, name + extension);
			try {
				if (!fs.statSync(candidate).isFile()) continue;
				fs.accessSync(candidate, fs.constants.X_OK);
				return candidate;
			} catch {
				// Not present or not executable in this directory.
			}
		}
	}
	return undefined;
}

function setupClient(
	name: string,
	options: SetupOptions,
	platform: NodeJS.Platform,
): void {
	const scope = options.scope ?? "user";
	const client = resolveClient(name, options.scope);
	const server = serverCommand(options.npx, platform);
	if (client.kind === "cli") {
		runCliClient(client, server, scope, options.print, platform);
	} else {
		writeJsonClient(client, server, scope, options.print);
	}
}

function runCliClient(
	client: CliClient,
	server: string[],
	scope: Scope,
	print: boolean,
	platform: NodeJS.Platform,
): void {
	const { remove, add } = client.commands(server, scope);
	const quote =
		platform === "win32" ? quoteWindowsArgument : quoteShellArgument;
	const manual = add.map(quote).join(" ");
	if (print) {
		console.log(manual);
		return;
	}

	const executable = findOnPath(client.binary, { platform });
	if (!executable) {
		throw new SetupError(
			`'${client.binary}' was not found on PATH. Install ${client.label}'s command-line tool, or run manually:\n  ${manual}`,
		);
	}

	const run = (argv: string[], stdio: "ignore" | "inherit") => {
		const spec = spawnSpec(argv, executable, platform);
		execFileSync(spec.file, spec.args, { ...spec.options, stdio });
	};

	// Drop the prinfer-era entry and the current one before adding; either
	// may be missing, which these clients report as a failure.
	for (const argv of remove ?? []) {
		try {
			run(argv, "ignore");
		} catch {
			// The server was not previously configured.
		}
	}

	try {
		run(add, "inherit");
	} catch (error) {
		throw new SetupError(
			`${client.label} setup failed: ${(error as Error).message}\nRun manually:\n  ${manual}`,
		);
	}
	console.log(
		`[ok] Configured typeprobe for ${client.label}: ${server.join(" ")}`,
	);
	console.log(client.restart);
}

function writeJsonClient(
	client: JsonClient,
	server: string[],
	scope: Scope,
	print: boolean,
): void {
	const file = client.file(scope);
	const entry = client.entry(server);
	if (print) {
		console.log(`Would update ${file}:`);
		console.log(
			JSON.stringify({ [client.key]: { [SERVER_NAME]: entry } }, null, 2),
		);
		return;
	}

	const migrated = mergeJsonConfig(file, client.key, entry);
	console.log(`[ok] Configured typeprobe for ${client.label} in ${file}`);
	if (migrated) {
		console.log(
			`Replaced the "${LEGACY_SERVER_NAME}" entry from before the rename.`,
		);
	}
	console.log(`Server command: ${server.join(" ")}`);
	console.log(client.restart);
}

function mergeJsonConfig(
	file: string,
	key: string,
	entry: Record<string, unknown>,
): boolean {
	const manual = JSON.stringify({ [key]: { [SERVER_NAME]: entry } }, null, 2);
	const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	let config: unknown = {};
	if (text.trim()) {
		try {
			config = JSON.parse(text);
		} catch (error) {
			throw new SetupError(
				`${file} is not valid JSON (${(error as Error).message}). It was left unchanged; add this entry manually:\n${manual}`,
			);
		}
	}
	if (!isPlainObject(config)) {
		throw new SetupError(
			`${file} does not contain a JSON object. It was left unchanged; add this entry manually:\n${manual}`,
		);
	}
	const servers = config[key] ?? {};
	if (!isPlainObject(servers)) {
		throw new SetupError(
			`"${key}" in ${file} is not an object. It was left unchanged; add this entry manually:\n${manual}`,
		);
	}
	// Update what setup owns (command, args, type) and keep keys the user
	// added to the entry, such as env or cwd. A prinfer-era entry is
	// replaced in place: its keys carry over unless a typeprobe entry
	// already exists.
	const existing = servers[SERVER_NAME];
	const legacy = servers[LEGACY_SERVER_NAME];
	const migrated = LEGACY_SERVER_NAME in servers;
	const base = isPlainObject(existing)
		? existing
		: isPlainObject(legacy)
			? renameLegacyEnv(legacy)
			: {};
	const next: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(servers)) {
		if (name === LEGACY_SERVER_NAME) {
			if (!(SERVER_NAME in servers)) next[SERVER_NAME] = undefined;
		} else {
			next[name] = value;
		}
	}
	next[SERVER_NAME] = { ...base, ...entry };
	config[key] = next;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${JSON.stringify(config, null, detectIndent(text))}\n`,
	);
	return migrated;
}

/** A prinfer-era entry with its PRINFER_* env names renamed. */
function renameLegacyEnv(
	entry: Record<string, unknown>,
): Record<string, unknown> {
	if (!isPlainObject(entry.env)) return entry;
	const env: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(entry.env)) {
		const renamed = name.startsWith("PRINFER_")
			? `TYPEPROBE_${name.slice("PRINFER_".length)}`
			: name;
		if (!(renamed in env)) env[renamed] = value;
	}
	return { ...entry, env };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detectIndent(text: string): string | number {
	const match = text.match(/^[{[][^\n]*\n([ \t]+)\S/);
	if (!match) return 2;
	return match[1].startsWith("\t") ? "\t" : match[1].length;
}

function setupAgentsMd(options: SetupOptions): void {
	if (options.scope) {
		throw new SetupError("agents-md does not support --scope.");
	}
	if (options.npx) {
		throw new SetupError("agents-md does not support --npx.");
	}
	const file = path.resolve(options.file ?? "AGENTS.md");
	if (options.print) {
		console.log(`Would update ${file}:`);
		console.log(AGENTS_BLOCK);
		return;
	}

	const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	// A block written before the rename has prinfer markers; replace it
	// unless the file already has a typeprobe block.
	const hasCurrent =
		existing.includes(AGENTS_START) || existing.includes(AGENTS_END);
	const legacy =
		!hasCurrent &&
		(existing.includes(LEGACY_AGENTS_START) ||
			existing.includes(LEGACY_AGENTS_END));
	const [startMarker, endMarker] = legacy
		? [LEGACY_AGENTS_START, LEGACY_AGENTS_END]
		: [AGENTS_START, AGENTS_END];
	const start = existing.indexOf(startMarker);
	const end = existing.indexOf(endMarker);
	let next: string;
	if (start === -1 && end === -1) {
		const separator =
			existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
		next = `${existing}${separator}${AGENTS_BLOCK}\n`;
	} else if (start !== -1 && end > start) {
		next =
			existing.slice(0, start) +
			AGENTS_BLOCK +
			existing.slice(end + endMarker.length);
	} else {
		throw new SetupError(
			`${file} has an unmatched ${start === -1 ? endMarker : startMarker} marker. It was left unchanged; fix the markers or remove them and re-run.`,
		);
	}

	if (next === existing) {
		console.log(`[ok] ${file} already has the current typeprobe block.`);
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, next);
	console.log(
		legacy
			? `[ok] Replaced the prinfer block with the typeprobe block in ${file}`
			: `[ok] ${start === -1 ? "Added" : "Updated"} the typeprobe block in ${file}`,
	);
}

export function quoteShellArgument(argument: string): string {
	if (/^[a-zA-Z0-9_./:@=-]+$/.test(argument)) return argument;
	return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

/** Quote an argument for display in a Windows command prompt. */
export function quoteWindowsArgument(argument: string): string {
	if (/^[a-zA-Z0-9_./:@=\\-]+$/.test(argument)) return argument;
	return `"${argument.replaceAll('"', '\\"')}"`;
}

export interface SpawnSpec {
	file: string;
	args: string[];
	options: { windowsVerbatimArguments?: boolean };
}

/**
 * How to execFileSync argv without a shell. On Windows, client CLIs installed
 * through npm (claude, codex) and VS Code's code are .cmd shims, which Node
 * refuses to spawn directly; run them through cmd.exe with every argument
 * escaped for both cmd.exe and the program's argv parser.
 */
export function spawnSpec(
	argv: string[],
	executable: string | undefined,
	platform: NodeJS.Platform = process.platform,
): SpawnSpec {
	const [command, ...args] = argv;
	if (platform !== "win32") return { file: command, args, options: {} };
	if (!executable || !/\.(?:cmd|bat)$/i.test(executable)) {
		return { file: executable ?? command, args, options: {} };
	}
	// npm's node_modules/.bin shims re-parse their arguments once more.
	const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(
		executable,
	);
	const line = [
		escapeCmdMetaChars(executable),
		...args.map((arg) => escapeCmdArgument(arg, doubleEscape)),
	].join(" ");
	return {
		file: process.env.comspec || "cmd.exe",
		args: ["/d", "/s", "/c", `"${line}"`],
		options: { windowsVerbatimArguments: true },
	};
}

const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdMetaChars(text: string): string {
	return text.replace(CMD_META_CHARS, "^$1");
}

/** Quote for CommandLineToArgvW, then caret-escape for cmd.exe. */
function escapeCmdArgument(argument: string, doubleEscape: boolean): string {
	const quoted = argument
		// Backslashes before a quote are doubled and the quote escaped.
		.replace(/(\\*)"/g, '$1$1\\"')
		// Trailing backslashes are doubled before the closing quote.
		.replace(/(\\*)$/, "$1$1");
	const escaped = escapeCmdMetaChars(`"${quoted}"`);
	return doubleEscape ? escapeCmdMetaChars(escaped) : escaped;
}
