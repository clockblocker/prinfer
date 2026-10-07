---
"prinfer": major
---

prinfer 3.0 makes the MCP server easier for agents to find, install, and call correctly, and adds single-file type checking.

### Breaking changes

- The deprecated `hoverByName` MCP tool is removed. Use `hover_by_name`.
- MCP tools no longer accept `include_timing`. Set `PRINFER_INCLUDE_TIMING=1` on the server process to add timing to every hover result. The library option and the CLI `--timing` flag are unchanged.
- `batch_hover` reports a missing, unreadable, or directory `file` as a per-item `FILE_NOT_FOUND` error instead of failing the whole call, because items can now come from different files. `file` is optional when every item names its own.
- Lookups by name report the position of the name token on both backends. On TypeScript 6 this used to be the start of the declaration (for example `export`).
- Name lookups prefer declarations (functions, variables, types, calls, then parameters, members, and other declarations) and never match comments or strings. Both backends pick the same node, which can differ from what earlier versions returned for a repeated name.
- The `completions` MCP tool and `prinfer complete` return at most 50 entries by default, and filter by the text already typed left of the cursor (an identifier's start, or a string literal's contents), as an editor does. Pass `prefix` (`--prefix`) to filter by other text or `""` to turn filtering off, and `limit` (`--limit`, up to 500 on MCP) for more entries. The text output ends with `… N more; pass prefix to narrow, or raise limit` when entries were cut.
- Completion entries are ranked by TypeScript's sortText with keywords after other entries of the same rank, in the library `completions()` too.
- TypeScript 6 hover kinds match the editor and the TypeScript 7 backend more closely: variables are `const`, `let`, or `var` instead of `variable`, and a bare reference reports the kind of what it refers to (`parameter`, `property`, `method`, `const`, ...) instead of `identifier`. This affects the library, the CLI, `prinfer/testing`'s `inferredTypeInfo`, and the `typescript6` MCP backend.
- A hover line or column outside the file is an `INVALID_ARGUMENT` error that gives the valid range, on both backends and in the CLI, instead of `SYMBOL_NOT_FOUND`.
- Error text starts with the code (`Error [SYMBOL_NOT_FOUND]: …`) and adds `Did you mean: …?` (or `Nearby identifiers: …`) and `Suggestion: …` lines, on MCP tools, `batch_hover` items, and CLI stderr. Many MCP clients show the model only text content, so the recovery hints used to be invisible there.
- MCP `outputSchema`s are one compact envelope per tool (`version`, `ok`, and `result` or `error`) instead of a union, and list only the error fields an agent recovers with. Structured content is unchanged. Together with dropping zod's safe-integer bounds and `$schema` from input schemas, `tools/list` is about a fifth smaller.
- On the TypeScript 7 backend, a `project` its language server would not use for the file (anything other than the nearest `tsconfig.json` or a project it references) fails with `INVALID_ARGUMENT` instead of silently using another tsconfig. Use the `typescript6` backend for such projects.

### Features

- `hover` and `batch_hover` items can target a token with `text` copied from the line (plus `occurrence` for the nth match) instead of a column. Whole-identifier matches count first, so `"user"` skips `users`. A miss quotes the line back so the agent can retry.
- The completion result adds `total` (matches before the limit), `truncated`, and `prefix` (the filter applied); the library `completions()` accepts `prefix` and `limit` options. `inferredCompletions` in `prinfer/testing` still returns every name, unfiltered, so snapshots stay exhaustive.
- CLI name targets accept any JavaScript identifier, such as `prinfer 'src/store.ts:$store'` or non-ASCII names.
- CLI `--json` errors include `project`, like the MCP server's.
- `batch_hover` accepts up to 100 items across any number of files, mixing `{name, line?}`, `{line, text, occurrence?}`, and `{line, column}` targets.
- New `diagnostics` MCP tool, `diagnostics(file, options)` library function, and `prinfer check <file> [--json] [--suggestions]` command report one file's type errors without checking the whole project. `prinfer check` exits 1 when the file has errors.
- The CLI accepts `--backend typescript6|typescript7` for type lookups and `prinfer check`. It still defaults to `typescript6`, and `prinfer complete` stays TypeScript 6 only.
- Tool descriptions and server instructions say when to call each tool.
- `prinfer mcp` starts the server, so `npx -y prinfer mcp` works without a global install.
- `prinfer setup` supports `claude`, `codex`, `cursor`, `vscode`, and `gemini`, with `--scope`, `--npx`, and `--print`. It registers `prinfer-mcp` when prinfer is installed globally and `npx -y prinfer mcp` otherwise, never an absolute path. Re-running it on a JSON config keeps `env` and other keys you added to the `prinfer` entry. On Windows it registers the server through `cmd /c`.
- `prinfer setup agents-md [--file CLAUDE.md]` adds a short block to your instructions file telling agents when to use prinfer.
- Claude Code plugin: `/plugin marketplace add clockblocker/prinfer`, then `/plugin install prinfer@prinfer`. It bundles the server and a skill.
- Published to the MCP Registry as `io.github.clockblocker/prinfer`.
- `prinfer/testing`:
  - `inferredType`, `inferredTypeInfo`, and `inferredCompletions` accept `{ line, text, occurrence? }` targets. For completions the cursor goes right after the matched text; pass `cursor: "start"` to put it before.
  - `inferredCompletions` uses TypeScript 7 without `backend: "typescript7"` (still accepted).
  - Teardown is optional: idle TypeScript 7 sessions no longer keep the test process alive. `closeTestingSessions` still shuts them down early.
  - Lookup failures throw `PrinferError` with the fix in the message: the closest declaration names for an unknown name, the line text for missing text, the valid backends and target shapes, and how to resolve a relative path against the test file.
- Errors are easier to recover from. `SYMBOL_NOT_FOUND` `candidates` are real identifiers close to the requested name (no keywords, or words from comments and strings). Suggestions are specific to the MCP tool or CLI command that failed. Out-of-range `completions` and hover positions are `INVALID_ARGUMENT` errors that give the valid range.

### Fixes

- The MCP server exits when its client disconnects (stdin closes) or on SIGINT/SIGTERM, shutting down warm TypeScript 7 language servers. Previously each session left a server process running.
- The TypeScript 7 backend no longer returns stale types or errors after another file in the project (such as an imported module) is edited, created, or deleted on disk.
- The TypeScript 7 backend keeps JSDoc out of `signature` and `returnType`, and `include_docs` returns it as `documentation`. Multi-line generic signatures get the right `returnType`.
- Lines and columns follow TypeScript on both backends: CR, LF, CRLF, U+2028, and U+2029 end a line, and a leading BOM is ignored.
- A directory passed as `file` is a clean `FILE_NOT_FOUND` error on every MCP tool and CLI command.
- Diagnostic message chains are indented like `tsc`.
- `prinfer-mcp` and `prinfer mcp` no longer crash at startup when launched through a global install's bin symlink.
- `npx -y prinfer setup <client>` registers `npx -y prinfer mcp` instead of a `prinfer-mcp` command that only existed in npx's temporary cache.
- The MCP server reports its real package version instead of a hard-coded `1.0.0`.
