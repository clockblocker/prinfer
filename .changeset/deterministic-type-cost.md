---
"prinfer": minor
---

Type costs replace type-resolution timing. `include_cost` (library, MCP hover tools, `prinfer/testing`), `--cost` (CLI), and the new `inferredTypeCost` helper report `cost: { instantiations, types }`: the type instantiations and types a fresh TypeScript 6 checker needs to resolve the type and write it out untruncated. A new checker for each count means no earlier lookup has done part of the work, so the numbers are the same on every run, in every process, in any order, and with any display option. A test can budget a type:

```ts
expect(inferredTypeCost(import.meta.url, { name: "userSchema" }).instantiations).toBeLessThan(5_000);
```

Costs are TypeScript 6 only, because TypeScript 7 reports no instantiation counts. On the MCP server, a hover with `include_cost` and no `backend` runs on TypeScript 6. An explicit `typescript7` backend, `--cost --backend typescript7`, and `inferredTypeCost`/`include_cost` with `backend: "typescript7"` fail with `INVALID_ARGUMENT`.

Behavior change: `timing` is no longer reported. Identical runs of the same lookup measured from 13 to 91 ms, too noisy to compare. Code that passes the old options keeps compiling and running, but gets no timing:

- `include_timing` and the `HoverTiming` type, `HoverResult.timing`, and `hoverTimingSchema` are deprecated and have no effect. `timing` is gone from the contract's hover result schema and from the MCP output schema.
- `--timing` and `-t` are still accepted and print a deprecation warning on stderr (none with `--json`, which keeps stderr empty).
- The MCP server no longer reads `PRINFER_INCLUDE_TIMING`.

To migrate, replace `include_timing`/`--timing` with `include_cost`/`--cost`, and replace assertions on `timing.resolution_ms` with a budget on `cost.instantiations`.
