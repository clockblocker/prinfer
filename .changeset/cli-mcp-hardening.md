---
"prinfer": minor
---

- A directory passed as `file` is now a clean `FILE_NOT_FOUND` error on every MCP tool and CLI command. In `batch_hover` it fails only that item instead of the whole call.
- `candidates` on `SYMBOL_NOT_FOUND` lists real identifiers close to the requested name, ranked by edit distance; keywords and words in comments or strings are no longer suggested.
- Error suggestions are specific to the MCP tool or CLI command that failed, and CLI errors no longer give MCP-only advice.
- The CLI accepts `--backend typescript6|typescript7` for type lookups and `prinfer check` (default `typescript6`).
- Re-running `prinfer setup` on a JSON config keeps `env` and other keys you added to the `prinfer` entry.
- On Windows, `prinfer setup` registers the server through `cmd /c` and runs `claude`, `codex`, and `code` `.cmd` shims through `cmd.exe`.
