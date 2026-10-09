---
"prinfer": patch
---

Add an MCPB manifest (`mcpb/manifest.json`) for listing the MCP server on Smithery. `bun run mcpb` packs it into `prinfer.mcpb`, a bundle that launches `npx -y prinfer@<version> mcp`. `bun run version` keeps the bundle's version and pinned package in sync. The npm package itself is unchanged.
