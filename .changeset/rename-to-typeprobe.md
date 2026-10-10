---
"typeprobe": major
---

prinfer is now typeprobe. The package, its commands, the MCP server, and the repository (`clockblocker/typeprobe`) are renamed; types, results, snapshots, and the JSON contract are unchanged. prinfer 3.5.0, the last prinfer release, depends on typeprobe and forwards to it, so existing setups keep working while you migrate:

- **Install**: `npm rm prinfer && npm i -D typeprobe`.
- **Imports**: `prinfer/testing` → `typeprobe/testing`, `prinfer` → `typeprobe`, and the deprecated `prinfer/vitest` → `typeprobe/vitest`.
- **Commands**: `prinfer` → `typeprobe`, `prinfer-mcp` → `typeprobe-mcp`, `npx -y prinfer mcp` → `npx -y typeprobe mcp`. typeprobe has no `prinfer` bins; prinfer 3.5.0 provides them.
- **MCP config**: re-run setup for each client, e.g. `npx -y typeprobe setup claude` (or `codex`, `cursor`, `vscode`, `gemini`, with `--scope` as before). The server is now named `typeprobe`, and setup replaces an old `prinfer` entry instead of adding a second one: `claude mcp remove`/`codex mcp remove` drop it, and JSON configs swap it for `typeprobe` in place, keeping its other keys such as `env` (with `PRINFER_*` names renamed to `TYPEPROBE_*`). `code --add-mcp` can't remove servers, so delete VS Code's user-scope `prinfer` server by hand. Configs written by hand: rename the `prinfer` key and use `"args": ["-y", "typeprobe", "mcp"]`. `npx -y typeprobe setup agents-md` replaces the old `<!-- prinfer:start -->` block.
- **Claude Code plugin**: `/plugin uninstall prinfer@prinfer`, `/plugin marketplace remove prinfer`, then `/plugin marketplace add clockblocker/typeprobe` and `/plugin install typeprobe@typeprobe`.
- **Environment variables**: `PRINFER_BACKEND` → `TYPEPROBE_BACKEND`, `PRINFER_COMPILER` → `TYPEPROBE_COMPILER`. The old names are deprecated but still read when the new ones are unset.
- **Errors**: the error class is now `TypeprobeError` (`error.name === "TypeprobeError"`), exported from `typeprobe` and `typeprobe/testing` for the first time. `PrinferError` is exported too, as a deprecated alias of the same class, so `instanceof PrinferError` keeps matching. `instanceof` holds whichever entry point (`typeprobe` or `typeprobe/testing`, ESM or CommonJS) threw the error and whichever one the class came from, though each bundles its own copy.
- **Listings**: MCP Registry `io.github.clockblocker/typeprobe` (was `io.github.clockblocker/prinfer`), Smithery `clockblocker/typeprobe`, homepage https://clockblocker.github.io/typeprobe/.
