---
"prinfer": major
---

Reshape the MCP tool surface for agents. `hover` and `batch_hover` can target a token by `text` (plus `occurrence`) instead of a column, and `batch_hover` items may each name their own `file` and mix `{line, column}`, `{line, text}`, and `{name, line?}` targets. Tool descriptions and server instructions now say when to call each tool, and the server reports the real package version.

Breaking MCP changes: the deprecated `hoverByName` alias tool is removed (use `hover_by_name`), and `include_timing` is no longer an MCP tool argument; set `PRINFER_INCLUDE_TIMING=1` on the server process instead. The programmatic API and CLI `--timing` are unchanged.
