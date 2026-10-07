import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER_NAME = "prinfer";
const NPX_COMMAND = ["npx", "-y", "prinfer", "mcp"];

export const SETUP_HELP = `
prinfer setup - configure an agent to use the prinfer MCP server

Usage:
  prinfer setup <client> [--scope <scope>] [--npx] [--print]
  prinfer setup agents-md [--file <path>] [--print]

Clients:
  codex       Codex: runs codex mcp add
  claude      Claude Code: runs claude mcp add (--scope local|project|user)
  cursor      Cursor: ~/.cursor/mcp.json (project: .cursor/mcp.json)
  vscode      VS Code: runs code --add-mcp (project: .vscode/mcp.json)
  gemini      Gemini CLI: ~/.gemini/settings.json (project: .gemini/settings.json)
  agents-md   Adds prinfer usage instructions to ./AGENTS.md

Options:
  --scope <scope>  user (default) or project; claude also accepts local
  --npx            Launch the server with 'npx -y prinfer mcp'
  --file <path>    Instructions file for agents-md, e.g. CLAUDE.md
  --print          Show the command or file change without applying it

The server command is 'prinfer-mcp' when it is on PATH, otherwise
'npx -y prinfer mcp'. Use --npx if the client cannot find prinfer-mcp
(editors started outside a shell may miss nvm, fnm, or volta paths).
Re-running setup replaces the existing prinfer entry.
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
	): { remove?: string[]; add: string[] };
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
			remove: ["codex", "mcp", "remove", SERVER_NAME],
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
			remove: ["claude", "mcp", "remove", "--scope", scope, SERVER_NAME],
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

const AGENTS_START = "<!-- prinfer:start -->";
const AGENTS_END = "<!-- prinfer:end -->";

export const AGENTS_BLOCK = `${AGENTS_START}
## TypeScript types (prinfer)

The prinfer MCP server reports what the TypeScript compiler infers. Reach for it when:
- Adding a type annotation: check the inferred type first with \`hover_by_name(file, name)\` or \`hover(file, line, text)\` (pass the token text instead of counting columns); annotate only when inference is wrong or too wide.
- Choosing a value for a typed slot (union member, option key, overload): \`completions(file, line, column)\` lists what TypeScript accepts there.
- Finishing an edit to a .ts/.tsx file: \`diagnostics(file)\` lists its type errors.
- Working without MCP: run \`npx prinfer path/to/file.ts:symbolName --json\`.
${AGENTS_END}`;

class SetupError extends Error {}

/** Runs `prinfer setup ...` (args exclude "setup") and returns an exit code. */
export function runSetup(args: string[]): number {
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
		setupClient(target, options);
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
			`Unknown setup client "${target}". Supported clients: ${CLIENT_NAMES.join(", ")}.\nRun 'prinfer setup --help' for details.`,
		);
	}
	if (options.file !== undefined && target !== "agents-md") {
		throw new SetupError(
			"--file only applies to 'prinfer setup agents-md'.",
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

/** The command an MCP client should launch, without absolute paths. */
export function serverCommand(forceNpx: boolean): string[] {
	if (!forceNpx && findOnPath("prinfer-mcp")) return ["prinfer-mcp"];
	return [...NPX_COMMAND];
}

function findOnPath(name: string): string | undefined {
	const extensions =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
			: [""];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
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

function setupClient(name: string, options: SetupOptions): void {
	const scope = options.scope ?? "user";
	const client = resolveClient(name, options.scope);
	const server = serverCommand(options.npx);
	if (client.kind === "cli") {
		runCliClient(client, server, scope, options.print);
	} else {
		writeJsonClient(client, server, scope, options.print);
	}
}

function runCliClient(
	client: CliClient,
	server: string[],
	scope: Scope,
	print: boolean,
): void {
	const { remove, add } = client.commands(server, scope);
	const manual = add.map(quoteShellArgument).join(" ");
	if (print) {
		console.log(manual);
		return;
	}

	if (!findOnPath(client.binary)) {
		throw new SetupError(
			`'${client.binary}' was not found on PATH. Install ${client.label}'s command-line tool, or run manually:\n  ${manual}`,
		);
	}

	if (remove) {
		try {
			execFileSync(remove[0], remove.slice(1), { stdio: "ignore" });
		} catch {
			// The server was not previously configured.
		}
	}

	try {
		execFileSync(add[0], add.slice(1), { stdio: "inherit" });
	} catch (error) {
		throw new SetupError(
			`${client.label} setup failed: ${(error as Error).message}\nRun manually:\n  ${manual}`,
		);
	}
	console.log(
		`[ok] Configured prinfer for ${client.label}: ${server.join(" ")}`,
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

	mergeJsonConfig(file, client.key, entry);
	console.log(`[ok] Configured prinfer for ${client.label} in ${file}`);
	console.log(`Server command: ${server.join(" ")}`);
	console.log(client.restart);
}

function mergeJsonConfig(
	file: string,
	key: string,
	entry: Record<string, unknown>,
): void {
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
	config[key] = { ...servers, [SERVER_NAME]: entry };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${JSON.stringify(config, null, detectIndent(text))}\n`,
	);
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
	const start = existing.indexOf(AGENTS_START);
	const end = existing.indexOf(AGENTS_END);
	let next: string;
	if (start === -1 && end === -1) {
		const separator =
			existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
		next = `${existing}${separator}${AGENTS_BLOCK}\n`;
	} else if (start !== -1 && end > start) {
		next =
			existing.slice(0, start) +
			AGENTS_BLOCK +
			existing.slice(end + AGENTS_END.length);
	} else {
		throw new SetupError(
			`${file} has an unmatched ${start === -1 ? AGENTS_END : AGENTS_START} marker. It was left unchanged; fix the markers or remove them and re-run.`,
		);
	}

	if (next === existing) {
		console.log(`[ok] ${file} already has the current prinfer block.`);
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, next);
	console.log(
		`[ok] ${start === -1 ? "Added" : "Updated"} the prinfer block in ${file}`,
	);
}

export function quoteShellArgument(argument: string): string {
	if (/^[a-zA-Z0-9_./:@=-]+$/.test(argument)) return argument;
	return `'${argument.replaceAll("'", `'"'"'`)}'`;
}
