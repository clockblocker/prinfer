---
"prinfer": major
---

prinfer 3.0 makes the MCP server easier for agents to find, install, and call correctly.

### Breaking changes

- The deprecated `hoverByName` MCP tool is removed. Use `hover_by_name`.
- MCP tools no longer accept `include_timing`. Set `PRINFER_INCLUDE_TIMING=1` on the server process to add timing to every hover result. The library option and the CLI `--timing` flag are unchanged.
- `batch_hover` reports a missing or unreadable file as a per-item `FILE_NOT_FOUND` error instead of failing the whole call, because items can now come from different files. `file` is optional when every item names its own.

### Features

- `hover` and `batch_hover` items can target a token with `text` copied from the line (plus `occurrence` for the nth match) instead of a column. A miss quotes the line back so the agent can retry.
- `batch_hover` accepts up to 100 items across any number of files, mixing `{name, line?}`, `{line, text, occurrence?}`, and `{line, column}` targets.
- New `diagnostics` MCP tool, `diagnostics(file, options)` library function, and `prinfer check <file> [--json] [--suggestions]` command report one file's type errors without checking the whole project. `prinfer check` exits 1 when the file has errors.
- Tool descriptions and server instructions now say when to call each tool.
- `prinfer mcp` starts the server, so `npx -y prinfer mcp` works without a global install.
- `prinfer setup` now supports `claude`, `codex`, `cursor`, `vscode`, and `gemini`, with `--scope`, `--npx`, and `--print`. It registers `prinfer-mcp` when prinfer is installed globally and `npx -y prinfer mcp` otherwise, never an absolute path.
- `prinfer setup agents-md [--file CLAUDE.md]` adds a short block to your instructions file telling agents when to use prinfer.
- Claude Code plugin: `/plugin marketplace add clockblocker/prinfer`, then `/plugin install prinfer@prinfer`. It bundles the server and a skill.
- Published to the MCP Registry as `io.github.clockblocker/prinfer`.

### Fixes

- The TypeScript 7 backend no longer returns stale types or errors after another file in the project (such as an imported module) is edited, created, or deleted on disk.
- The TypeScript 7 backend keeps JSDoc out of `signature` and `returnType`, and `include_docs` now returns it as `documentation`.
- `prinfer-mcp` and `prinfer mcp` no longer crash at startup when launched through a global install's bin symlink.
- `npx -y prinfer setup <client>` registers `npx -y prinfer mcp` instead of a `prinfer-mcp` command that only existed in npx's temporary cache.
- The MCP server reports its real package version instead of a hard-coded `1.0.0`.
