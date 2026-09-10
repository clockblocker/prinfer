---
"prinfer": major
---

Make the MCP interface easier for agents to consume with structured errors,
structured batch-item failures, validated 1-based positions, a bounded batch
size, and a canonical `hover_by_name` tool. Retain `hoverByName` as a deprecated
compatibility alias and clarify the intentionally default TypeScript 7 backend.

The batch item `error` field now contains a structured error object instead of
a string.
