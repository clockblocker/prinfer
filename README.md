<p align="center">
  <img src="printfer-logo.webp" alt="prinfer logo" width="400">
</p>

# prinfer

prinfer lets AI coding agents ask the TypeScript compiler what it infers (types, completions, type errors) instead of guessing, through an MCP server, a CLI, or a library.

## Install

Pick your client. Every setup command below runs through `npx`, so nothing has to be installed first. If you install globally (`npm i -g prinfer`), drop the `npx -y` prefix and setup registers the `prinfer-mcp` binary, which skips npx's package check on every launch.

### Claude Code

Install the plugin. It bundles the MCP server and a skill that tells Claude when to use it:

```text
/plugin marketplace add clockblocker/prinfer
/plugin install prinfer@prinfer
```

Or register only the MCP server:

```bash
npx -y prinfer setup claude                   # user scope
npx -y prinfer setup claude --scope project   # shared .mcp.json for the repo
```

### Codex

```bash
npx -y prinfer setup codex
```

This runs `codex mcp add prinfer -- npx -y prinfer mcp`. The equivalent `~/.codex/config.toml` entry:

```toml
[mcp_servers.prinfer]
command = "npx"
args = ["-y", "prinfer", "mcp"]
```

### Cursor

```bash
npx -y prinfer setup cursor                   # ~/.cursor/mcp.json
npx -y prinfer setup cursor --scope project   # .cursor/mcp.json
```

### VS Code

```bash
npx -y prinfer setup vscode                   # runs code --add-mcp
npx -y prinfer setup vscode --scope project   # .vscode/mcp.json
```

### Gemini CLI

```bash
npx -y prinfer setup gemini                   # ~/.gemini/settings.json
npx -y prinfer setup gemini --scope project   # .gemini/settings.json
```

### Any other MCP client

prinfer is a stdio server. Point your client at `npx -y prinfer mcp`:

```json
{
  "mcpServers": {
    "prinfer": {
      "command": "npx",
      "args": ["-y", "prinfer", "mcp"]
    }
  }
}
```

### Setup options

- `--print` shows the command or config change without applying it.
- `--npx` registers `npx -y prinfer mcp` even when `prinfer-mcp` is installed. Use it when the client can't find `prinfer-mcp`; editors started outside a shell often miss nvm, fnm, or volta paths.
- Re-running setup replaces the existing `prinfer` entry and leaves other servers alone. JSON configs that don't parse are left untouched, and setup prints the entry for you to add by hand.

## Tell the agent when to use it

MCP tool descriptions only go so far. Agents still reach for `tsc` or write annotations by hand. Add a short block to your instructions file:

```bash
npx -y prinfer setup agents-md                  # ./AGENTS.md
npx -y prinfer setup agents-md --file CLAUDE.md
```

The block sits between `<!-- prinfer:start -->` and `<!-- prinfer:end -->` markers. Re-running updates it in place. The Claude Code plugin ships the same guidance as a skill, so plugin users can skip this.

## Tools

Lines and columns are 1-based everywhere. `file` is absolute or relative to the server's working directory, and `project` (a `tsconfig.json` path) defaults to the nearest one above the file.

### hover_by_name

Start here when you know the symbol's name.

```text
hover_by_name(file: "src/utils.ts", name: "names")
hover_by_name(file: "src/utils.ts", name: "names", line: 11)   # line picks among same-named symbols
hover_by_name(file: "src/utils.ts", name: "format", include_docs: true)
```

```text
Type: const names: string[]
Name: names
Kind: const
Position: 11:14
```

### hover

Hover a token on a known line. Pass `text` copied from the line and prinfer finds the column, so the agent doesn't have to count characters. `text` is a plain substring match: on `users.map((user) => user.name)`, `text: "user"` first matches inside `users`, so pass `occurrence: 2` for the callback parameter. A `column` still works in place of `text`.

```text
hover(file: "src/utils.ts", line: 11, text: "user", occurrence: 2)
hover(file: "src/utils.ts", line: 11, column: 33)
```

```text
Type: (parameter) user: {
    id: number;
    name: string;
}
Kind: parameter
Position: 11:33
Target: "user" at 11:33
```

Generic calls show their instantiated types, the same as an editor hover. If the text isn't on the line, the error quotes the line so the agent can correct itself:

```text
Error: Text "nope" not found on line 11 of /project/src/utils.ts
Suggestion: Line 11 reads: "export const names = users.map((user) => user.name);". Copy text exactly from it, or pass column instead.
```

### batch_hover

Up to 100 lookups in one call, across any number of files. Each item is `{name, line?}`, `{line, text, occurrence?}`, or `{line, column}`, with an optional `file` that overrides the shared top-level `file`. Each program or document loads once per file.

```text
batch_hover(file: "src/utils.ts", positions: [
  {name: "users"},
  {line: 11, text: "user", occurrence: 2},
  {file: "src/missing.ts", line: 1, column: 1}
])
```

```text
Batch hover results: 2 succeeded, 1 failed

--- src/utils.ts:users:6 ---
Type: const users: {
    id: number;
    name: string;
}[]
Name: users
Kind: const
Position: 6:14

--- src/utils.ts:11:33 text "user" #2 ---
Type: (parameter) user: {
    id: number;
    name: string;
}
Kind: parameter
Position: 11:33

--- src/missing.ts:1:1 ---
Error [FILE_NOT_FOUND]: File not found: /project/src/missing.ts
Suggestion: Check the resolved file path and the MCP server working directory.
```

Failures stay per item, including a missing file, so one bad lookup doesn't throw away the rest.

### completions

The entries TypeScript offers at a cursor, including string-literal union members. The cursor sits before the character at `column`. For a string union, put it just inside the opening quote.

```text
completions(file: "src/utils.ts", line: 14, column: 30)
```

```text
coffee
tea
```

`completions` always runs on the TypeScript 6 backend and takes no `backend` argument.

### diagnostics

Type errors for one file, without type-checking the whole project. Meant for the end of an edit.

```text
diagnostics(file: "src/utils.ts")
diagnostics(file: "src/utils.ts", include_suggestions: true)   # also unused variables etc.
```

```text
src/utils.ts:16:14 error TS2322: Type 'string' is not assignable to type 'number'.
1 error, 0 warnings.
```

A clean file returns `No type errors.`. Errors and warnings are reported by default. `include_suggestions` adds suggestion diagnostics such as TS6133 (declared but never read).

## Backends and environment

`hover_by_name`, `hover`, `batch_hover`, and `diagnostics` take `backend: "typescript7" | "typescript6"`.

- `typescript7` (default) runs the native TypeScript 7 language server. One warm session per project is shared across requests, and its output is closest to what your editor shows.
- `typescript6` uses the TypeScript 6 compiler API in-process. If a lookup fails or looks wrong on TypeScript 7, retry that call with `typescript6`.

The TypeScript 7 backend is experimental: TypeScript 7.0's programmatic API and hover format may still change. The two backends also format signatures differently. TypeScript 7 returns `const names: string[]`, TypeScript 6 returns `string[]`.

Environment variables on the server process:

| Variable | Effect |
| :- | :- |
| `PRINFER_BACKEND=typescript6` | Default backend for the four tools above. An explicit `backend` argument still wins. |
| `PRINFER_INCLUDE_TIMING=1` | Add type-resolution timing to every hover result (`1` or `true`). |

Timing appears as `Type resolution: 82.06 ms` in text and `timing: { resolution_ms }` in structured content. It covers only the type lookup itself: the in-process checker call on TypeScript 6, the language-server hover exchange on TypeScript 7. Startup, project loading, file reads, and name or text resolution are excluded. In `batch_hover` each successful item gets its own timing.

## Error contract

Every tool returns readable text plus versioned structured content. Successes are `{ version: 1, ok: true, result }`. Failures look like this:

```json
{
  "version": 1,
  "ok": false,
  "error": {
    "code": "SYMBOL_NOT_FOUND",
    "message": "No symbol named \"nmes\" at line 11 found in src/utils.ts",
    "file": "/project/src/utils.ts",
    "line": 11,
    "project": "/project/tsconfig.json",
    "candidates": ["names", "name", "users", "map", "user"],
    "suggestion": "Try hover_by_name with the symbol name, or hover with text copied from the line instead of a column."
  }
}
```

The error codes are `INVALID_ARGUMENT`, `FILE_NOT_FOUND`, `SYMBOL_NOT_FOUND`, `TYPESCRIPT_ERROR`, and `INTERNAL_ERROR`. `candidates` lists nearby identifiers when prinfer can find any. The CLI's `--json` output and the exported zod schemas (`hoverSuccessSchema`, `diagnosticsSuccessSchema`, `contractErrorResponseSchema`, and the rest) use the same contract.

## CLI

The CLI uses the TypeScript 6 backend.

```bash
# Type by name, optionally with a line hint for repeated names
prinfer src/utils.ts:format
prinfer src/utils.ts:names:11

# Type at a position
prinfer src/utils.ts:11:33

prinfer src/utils.ts:format --docs      # include JSDoc
prinfer src/utils.ts:largeType --full   # turn off editor-style truncation
prinfer src/utils.ts:format --timing    # type-resolution timing
prinfer src/utils.ts:format -p ./tsconfig.json

# Completions at a cursor
prinfer complete src/utils.ts:14:30

# Type errors in one file
prinfer check src/utils.ts
prinfer check src/utils.ts --suggestions
```

```text
$ prinfer src/utils.ts:format --docs
(value: number, digits?: number): string
returns: string
name: format
kind: function
docs: Formats a number with a fixed number of digits.

$ prinfer check src/utils.ts
src/utils.ts:16:14 error TS2322: Type 'string' is not assignable to type 'number'.
1 error, 0 warnings.
```

`prinfer check` exits 0 when the file has no type errors (warnings and suggestions don't count) and 1 when it has errors, so scripts and agents can branch on the exit code alone.

### JSON output

`--json` prints the versioned contract on stdout and nothing on stderr. `hover`, `complete`, and `check` all support it:

```bash
$ prinfer src/utils.ts:names --json
{"version":1,"ok":true,"result":{"signature":"string[]","line":11,"column":14,"kind":"variable","name":"names"}}

$ prinfer check src/utils.ts --json
{"version":1,"ok":true,"result":{"file":"/project/src/utils.ts","diagnostics":[{"line":16,"column":14,"endLine":16,"endColumn":19,"code":2322,"category":"error","message":"Type 'string' is not assignable to type 'number'.","source":"ts"}],"errorCount":1,"warningCount":0}}
```

Failures print `{"version":1,"ok":false,"error":{...}}` and exit 1. `check` also exits 1 when it succeeds but finds errors; check `ok` to tell a failed run from a file with type errors.

### Other commands

- `prinfer mcp` starts the MCP server on stdio, the same as the `prinfer-mcp` binary. `npx -y prinfer mcp` works without a global install.
- `prinfer setup <codex|claude|cursor|vscode|gemini> [--scope <scope>] [--npx] [--print]` registers the server with a client (see [Install](#install)).
- `prinfer setup agents-md [--file <path>] [--print]` adds the usage block to an instructions file.

Run `prinfer --help` or `prinfer setup --help` for the full option list.

## Programmatic API

The library API is synchronous and uses the TypeScript 6 backend.

```typescript
import { batchHover, completions, diagnostics, hover } from "prinfer";

// By symbol name
hover("./src/utils.ts", "format");
// => { signature: "(value: number, digits?: number): string", returnType: "string",
//      line: 2, column: 1, kind: "function", name: "format", documentation: undefined }

// By name with a line hint, for repeated names
hover("./src/utils.ts", "names", { line: 11 });

// By position (line, column)
hover("./src/utils.ts", 11, 33);
// => { signature: "{ id: number; name: string; }", line: 11, column: 33, kind: "identifier", name: "user", ... }

// Options: include_docs, full (no truncation), include_timing, project
hover("./src/utils.ts", "format", { include_docs: true }).documentation;
// => "Formats a number with a fixed number of digits."

// Several positions in one file, one program load
const batch = batchHover("./src/utils.ts", [
  { line: 11, column: 14 },
  { line: 11, column: 33 },
]);
// => { items: [...], successCount: 2, errorCount: 0 }

// Completions at a cursor
completions("./src/utils.ts", 14, 30).entries.map((entry) => entry.name);
// => ["coffee", "tea"]

// Type errors for one file
const result = diagnostics("./src/utils.ts", { include_suggestions: false });
// => { file: "/project/src/utils.ts", errorCount: 1, warningCount: 0,
//      diagnostics: [{ line: 16, column: 14, endLine: 16, endColumn: 19, code: 2322,
//                      category: "error", message: "Type 'string' is not assignable to type 'number'.", source: "ts" }] }
```

Unlike the MCP server, the library throws on failure (`batchHover` reports bad positions per item and throws only when the file can't be loaded). Pass a caught error to `contractError(error)` to get the contract shape.

## Inferred type snapshots

Use the runner-neutral `prinfer/testing` entry point with ordinary snapshot
matchers in Vitest, Bun, Jest, and compatible test runners. Passing
`import.meta.url` keeps the lookup stable
when the test file moves; selecting a uniquely named declaration avoids brittle
line and column literals.

```typescript
import { afterAll, expect, test } from "vitest";
import {
  closeTestingSessions,
  inferredCompletions,
  inferredType,
} from "prinfer/testing";

afterAll(closeTestingSessions);

const result = createRouter({ users: usersRoute });
type Drink = "coffee" | "tea";
const selected: Drink = "coffee";

test("preserves the public inferred type", () => {
  expect(inferredType(import.meta.url, { name: "result" }))
    .toMatchInlineSnapshot(`"Router<{ users: UserRoute; }>"`);
});

test("checks the public inferred type with TypeScript 7", async () => {
  await expect(inferredType(import.meta.url, {
    name: "result",
    backend: "typescript7",
  })).resolves.toMatchInlineSnapshot(`"Router<{ users: UserRoute; }>"`);
});

test("preserves contextual completions", async () => {
  await expect(inferredCompletions(import.meta.url, {
    line: 12,
    column: 26,
    backend: "typescript7",
  })).resolves.toMatchInlineSnapshot(`
    [
      "coffee",
      "tea",
    ]
  `);
});
```

Update snapshots with the test runner's normal update command. TypeScript types
are erased at runtime, so the helper inspects the test source through the
nearest `tsconfig.json` rather than inspecting the runtime value. Completion
snapshots explicitly opt into the asynchronous TypeScript 7 native compiler
API and return only the suggested names. Passing `backend: "typescript7"` does
the same for inferred-type snapshots; those calls return promises. `full: true`
disables truncation and expands type aliases and indexed accesses when
capturing named type aliases. Native requests share one compiler session per
project, so call the async `closeTestingSessions` function from the runner's
teardown hook. Calls without a backend remain synchronous and use the
TypeScript 6 compatibility implementation.
The former `prinfer/vitest` entry point remains as a deprecated compatibility
alias.

## Requirements

- Node.js >= 20.0.0

prinfer bundles its own TypeScript 6 and TypeScript 7 as internal dependencies, so your project's `typescript` version doesn't matter and doesn't need aliasing or downgrading.

## Development

```bash
bun install
bun run ci    # typecheck, build, biome check, tests
```

The repository type-checks with TypeScript 7 (`bun run typecheck`). The MCP server's default backend uses the TypeScript 7 native language server, and the testing helpers use its unstable standalone async compiler API. The TypeScript 6 package backs the synchronous library API, the CLI, the `typescript6` MCP backend, and declaration bundling.

Releases go through changesets (`bun run changeset`). `bun run version` also copies the version into `server.json` and the Claude Code plugin manifest.

## License

MIT
