# prinfer

## 3.2.0

### Minor Changes

- 04a14ac: Type costs replace type-resolution timing. `include_cost` (library, MCP hover tools, `prinfer/testing`), `--cost` (CLI), and the new `inferredTypeCost` helper report `cost: { instantiations, types }`: the type instantiations and types a fresh TypeScript 6 checker needs to resolve the type and write it out untruncated. A new checker for each count means no earlier lookup has done part of the work, so the numbers are the same on every run, in every process, in any order, and with any display option. A test can budget a type:

  ```ts
  expect(
    inferredTypeCost(import.meta.url, { name: "userSchema" }).instantiations
  ).toBeLessThan(5_000);
  ```

  Costs are TypeScript 6 only, because TypeScript 7 reports no instantiation counts. On the MCP server, a hover with `include_cost` and no `backend` runs on TypeScript 6. An explicit `typescript7` backend, `--cost --backend typescript7`, and `inferredTypeCost`/`include_cost` with `backend: "typescript7"` fail with `INVALID_ARGUMENT`.

  Behavior change: `timing` is no longer reported. Identical runs of the same lookup measured from 13 to 91 ms, too noisy to compare. Code that passes the old options keeps compiling and running, but gets no timing:

  - `include_timing` and the `HoverTiming` type, `HoverResult.timing`, and `hoverTimingSchema` are deprecated and have no effect. `timing` is gone from the contract's hover result schema and from the MCP output schema.
  - `--timing` and `-t` are still accepted and print a deprecation warning on stderr (none with `--json`, which keeps stderr empty).
  - The MCP server no longer reads `PRINFER_INCLUDE_TIMING`.

  To migrate, replace `include_timing`/`--timing` with `include_cost`/`--cost`, and replace assertions on `timing.resolution_ms` with a budget on `cost.instantiations`.

- 35ea165: New `sort_unions` option prints union members in a fixed order, the same on TypeScript 6 and TypeScript 7, which order members differently. A `prinfer/testing` snapshot written with `inferredType(import.meta.url, { name: "x", sort_unions: true })` now holds on both backends. Every union in the type is sorted, at any depth: members by their printed text, with `null` and `undefined` last. Off by default; also available on the library's hover options and as `--sort-unions` on the CLI.
- 421214f: `prinfer/testing` catches two easy mistakes in untyped test files. Options passed as a third argument, such as `inferredType(file, { name }, { backend: "typescript7" })`, used to be ignored without an error. Now they throw, with a message saying to move them into the selector.

  New `strict` selector option for `inferredType`, `inferredTypeInfo`, `inferredTypeCost` and `inferredCompletions`. With `strict: true`, an unknown selector key throws and names the closest valid key (`includeDocs` gets "Did you mean include_docs?"). Without it, unknown keys are ignored as before.

- 6b0097b: `prinfer/testing`: the TypeScript 7 helpers are now synchronous. `inferredType` and `inferredTypeInfo` with `backend: "typescript7"`, and `inferredCompletions`, return a plain value instead of a promise. Before, a missing `await` under `bun test` made `toMatchInlineSnapshot()` record `Promise {}`, and the test passed. Now the snapshot records the type.

  The TypeScript 7 compiler runs in a worker thread, and each call blocks until it answers. The worker and its compiler don't keep the process alive. If `@typescript/native` fails to load, the call throws a `TYPESCRIPT_ERROR` with the loader's reason right away instead of waiting for the timeout. The CLI, the MCP server and the library still use the async client.

  New `timeout` selector option (milliseconds, default 60000). A test runner's own timeout can't interrupt a blocked call. A TypeScript 7 call that gets no answer in time throws a `TYPESCRIPT_ERROR` and stops that compiler. The next call starts a new one, so a hung compiler fails one test instead of the whole run.

  `closeTestingSessions()` still returns a promise, settles on Node and Bun, and is still optional.

  This changes how TypeScript 7 results behave in tests that relied on them being promises:

  - `expect(await inferredType(...))` keeps working, since awaiting a plain value returns it. The `await` is now optional.
  - `.resolves` no longer applies: `await expect(inferredType(file, { name, backend: "typescript7" })).resolves.toBe(...)` fails because the value is not a promise. Write `expect(inferredType(file, { name, backend: "typescript7" })).toBe(...)`.
  - Errors are now thrown synchronously instead of rejecting, so `.rejects` and `.catch()` no longer see them. Use `expect(() => inferredType(...)).toThrow(...)` or `try`/`catch`.
  - The TypeScript types follow: `inferredType` returns `string`, `inferredTypeInfo` returns `HoverResult` and `inferredCompletions` returns `string[]` on both backends.

### Patch Changes

- 1cb5b50: `prinfer --version` prints the package version. It used to fail with "Unknown option --version".
- 6ca7ab0: Signatures print the same on every backend in two more places:

  - An optional property of an object type inside an array, tuple, type argument, union, intersection, or index or construct signature drops the `| undefined` its `?` implies on TypeScript 6 and the TypeScript 7 API too: `(rows: { z?: string; }[]): void`, as tsc and the TypeScript 7 language server print it. They used to print `z?: string | undefined` there. The language server backend also writes `Array<T>` and `ReadonlyArray<T>` as `T[]` and `readonly T[]`, and the TypeScript 7 API no longer prints tuples as `[ a, b ]`.
  - The TypeScript 7 language server backend keeps the `const`, `in`, and `out` modifiers of a type alias's, class's, or interface's type parameters: `Holder<const T extends 1 | 2>`. It used to print `Holder<T extends 1 | 2>`.

- 85fb65c: `prinfer/testing`: on Node, a script that ran a TypeScript 7 lookup and then called `await closeTestingSessions()` at top level now exits normally. Before this fix the await never settled and Node exited with code 13 ("unsettled top-level await"). prinfer unrefs the idle compiler process so it can't keep your process alive, and that stayed in effect while `closeTestingSessions()` waited for the compiler to answer, so Node's event loop emptied out before the reply came. The compiler is now held only while it shuts down. Idle sessions still don't keep the process alive, and calling `closeTestingSessions()` is still optional.
- 393b361: `prinfer/testing`: if a TypeScript 7 compiler process exits mid-run, prinfer now starts a new one. `bun test` kills every child process when any test times out, and that includes the shared compiler. Before this fix, every later TypeScript 7 call in the run hung or failed with "snapshot 1 not found", and `closeTestingSessions()` hung in `afterAll`. A call that was in flight when the process exited, or that fails while the process shuts down, now retries once with a fresh compiler. Teardown no longer waits on a dead process.
- e88ef58: TypeScript 7 testing API: a name in a type position (`Holder` in `let h: Holder<1>`, `ns.T`, an imported type, an enum, a type parameter, `interface A extends B<1>`) printed `any`; it now prints the declared type, as on TypeScript 6 (`Holder<T>`). The language-server backend's `unionMembers` for such a name (`let p: Pair`) now matches too.

## 3.1.0

### Minor Changes

- 962f411: Optional parameters and properties read the same on every backend, as `tsc` writes them in declaration emit and quick info: `(value: number, digits?: number): string`, not `digits?: number | undefined`. The TypeScript 7 language server already printed them this way; the TypeScript 6 backend (the library, the CLI, and `prinfer/testing` by default) and the `prinfer/testing` TypeScript 7 API now do too, in `signature`, `returnType`, and `overloads`. Update `prinfer/testing` snapshots that hold the old form.

  - A `| undefined` the source wrote stays: `digits?: number | undefined` is printed as written.
  - A `| undefined` the annotation does not account for stays too: `y?: number | undefined` for `y?: T` in a call with a number, and the properties of `Partial<T>` without `exactOptionalPropertyTypes`.
  - Object types inside a signature follow the same rule: `(options?: { verbose?: boolean; }): void`, `(cb?: (x?: number) => void): void`.
  - With `exactOptionalPropertyTypes`, hovering a property declared `digits?: number` reports `number` on every backend, as quick info does. TypeScript 6 and the TypeScript 7 API used to report `number | undefined`.
  - On the TypeScript 7 language server, `overloads` now match `signature` (they used to keep `| undefined`, so the hovered overload was listed again), and an optional method no longer reports `unionMembers`.

- 02ade0b: An explicit `project` now works on the TypeScript 7 backend for any tsconfig that includes the file, not only the one the language server picks itself (the nearest `tsconfig.json`, or a project it references). An unreferenced `tsconfig.test.json` or `tsconfig.app.json` used to fail with `INVALID_ARGUMENT`; it is now opened through the TypeScript 7 API in the same warm session, so hovers, `hover_by_name`, `batch_hover` and `diagnostics` (MCP, `prinfer check --backend typescript7`) answer with that tsconfig's options. Hovers in such a project come from the checker, as in `prinfer/testing`, and have no `display`. Requests without `project`, or with the tsconfig the language server picks, are unchanged.

  A tsconfig that doesn't include the file still fails with `INVALID_ARGUMENT`; the message now says so and suggests the `typescript6` backend, which adds the file to any project.

### Patch Changes

- f23c25a: `prinfer/testing`: TypeScript 7 sessions no longer depend silently on a private `@typescript/native` field to let the test process exit. If a future release moves the compiler process so prinfer can't unref it, prinfer prints a one-time warning to stderr naming `closeTestingSessions()` as the fix, then closes each session after 1s idle so the process still exits. The next call restarts the compiler.
- 0bc9959: Add an MCPB manifest (`mcpb/manifest.json`) for listing the MCP server on Smithery. `bun run mcpb` packs it into `prinfer.mcpb`, a bundle that launches `npx -y prinfer@<version> mcp`. `bun run version` keeps the bundle's version and pinned package in sync. The npm package itself is unchanged.

## 3.0.0

### Major Changes

- 62d47d8: prinfer 3.0 makes the MCP server easier for agents to find, install, and call correctly, gives every backend the same hover result, and adds single-file type checking and an annotations check.

  ### Breaking changes

  - `prinfer/testing`: `inferredType` and `inferredTypeInfo` return untruncated types by default, on both backends. A snapshot that held `{ ...; }` or `... 12 more ...` now holds the whole type, so changes deep inside a type fail the test. Update the snapshots, or pass `full: false` to keep the editor's shortened form.
  - `signature` is the type text alone, on one line, on every backend (TypeScript 6, the TypeScript 7 language server, and the `prinfer/testing` TypeScript 7 API). On the TypeScript 7 language server (the MCP default, and the CLI's `--backend typescript7`) it used to be the editor's hover text, such as `const names: string[]` with object types over several lines; that text is now the new `display` field. Two TypeScript 6 and `prinfer/testing` signatures change too: a variable initialized with a function reports its type, `(x: number) => string`, with `kind: "const"` instead of `(x: number): string` and `kind: "function"`; and type aliases keep their type parameters, `type Box<T extends string = "a"> = { value: T; }` instead of `type Box = { value: T; }`.
  - Hover text from the MCP hover tools and CLI type lookups is capped at 4000 characters per type, ending with a line that gives the total length and the union member count. Pass `max_chars` (MCP) or `--max-chars` (CLI) to raise the cap, `0` for none. Structured content and `--json` output are never cut.
  - The CLI rejects unknown options, and options a command doesn't take (such as `--prefix` on a type lookup), with exit code 1. Type lookups used to ignore them. Malformed targets print a short error with the accepted forms instead of the whole help text.
  - The deprecated `hoverByName` MCP tool is removed. Use `hover_by_name`.
  - MCP tools no longer accept `include_timing`. Set `PRINFER_INCLUDE_TIMING=1` on the server process to add timing to every hover result. The library option and the CLI `--timing` flag are unchanged.
  - `batch_hover` reports a missing, unreadable, or directory `file` as a per-item `FILE_NOT_FOUND` error instead of failing the whole call, because items can now come from different files. `file` is optional when every item names its own.
  - Lookups by name report the position of the name token on both backends. On TypeScript 6 this used to be the start of the declaration (for example `export`).
  - Name lookups prefer declarations (functions, variables, types, calls, then parameters, members, and other declarations) and never match comments or strings. Both backends pick the same node, which can differ from what earlier versions returned for a repeated name.
  - The `completions` MCP tool and `prinfer complete` return at most 50 entries by default, and filter by the text already typed left of the cursor (an identifier's start, or a string literal's contents), as an editor does. Pass `prefix` (`--prefix`) to filter by other text or `""` to turn filtering off, and `limit` (`--limit`, up to 500 on MCP) for more entries. The text output ends with `… N more; pass prefix to narrow, or raise limit` when entries were cut.
  - Completion entries are ranked by TypeScript's sortText with keywords after other entries of the same rank, in the library `completions()` too.
  - Hover `kind` uses the editor's labels on every backend. On TypeScript 6, variables are `const`, `let`, or `var` instead of `variable`, a variable initialized with a function is `const` (or `let`, `var`) rather than `function`, and a bare reference reports the kind of what it refers to (`parameter`, `property`, `method`, `const`, ...) instead of `identifier`. This affects the library, the CLI, `prinfer/testing`'s `inferredTypeInfo`, and both MCP backends.
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
  - CLI text targets: `prinfer src/a.ts:75:user` hovers where `user` starts on line 75, matching whole identifiers first like the `hover` tool's `text`. `prinfer src/a.ts:75 --text user --occurrence 2` does the same for text that is all digits or needs the nth match. `prinfer complete` takes the same targets and puts the cursor right after the text, so `src/a.ts:75:user.` lists the members of `user`.
  - CLI value options accept `--opt=value`. Arguments the shell probably rewrote (an expanded `$name`, or a zsh `:r` modifier in `"$F:root"`) get a quoting hint.
  - Hover results add `overloads` (every call signature of an overloaded function), `unionMembers` (the size of a union type), and, for name lookups that matched one of several declarations, `alternatives` with the others' positions and kinds. The text shows `(+1 overload)` with the overloads listed, and `Matched line 8 of 2 declarations (also 12); pass line to choose.`
  - A name lookup whose `line` misses says where the name is declared, in the suggestion and in a new `declaredAt` error field.
  - The MCP hover tools take `full` and `max_chars`.
  - At an object-literal key that accepts any key, such as a `Record<string, number>`, completions return no entries and a `note` explaining why, instead of every global name.
  - New `annotations` MCP tool, `annotations(file, options)` library function, and `prinfer annotations <file> [--json] [--project]` command list the explicit type annotations in one file that TypeScript would infer anyway (`redundant`), or that are wider than the inferred type (`widening`, often a deliberate contract). They run on TypeScript 6. The command exits 0 whatever it finds.
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
  - `full: true` turns off truncation on the TypeScript 7 language server backend too.
  - The TypeScript 7 backend keeps JSDoc out of `signature` and `returnType`, and `include_docs` returns it as `documentation`. Multi-line generic signatures get the right `returnType`.
  - Lines and columns follow TypeScript on both backends: CR, LF, CRLF, U+2028, and U+2029 end a line, and a leading BOM is ignored.
  - A directory passed as `file` is a clean `FILE_NOT_FOUND` error on every MCP tool and CLI command.
  - Diagnostic message chains are indented like `tsc`.
  - `prinfer-mcp` and `prinfer mcp` no longer crash at startup when launched through a global install's bin symlink.
  - `npx -y prinfer setup <client>` registers `npx -y prinfer mcp` instead of a `prinfer-mcp` command that only existed in npx's temporary cache.
  - The MCP server reports its real package version instead of a hard-coded `1.0.0`.

## 2.3.0

### Minor Changes

- Move TypeScript 7 testing helpers to reusable standalone compiler sessions, including exact project selection, type-resolution timing, and async teardown.
- Make `full: true` produce compact, untruncated, alias-expanded type snapshots so structural guards retain indexed-access and literal-union details.

## 2.2.2

### Patch Changes

- Route explicit TypeScript 7 inferred-type snapshots through a shared native language server and add `closeTestingSessions` for test-runner teardown.

## 2.2.1

### Patch Changes

- Add asynchronous TypeScript 7 completion snapshots through `inferredCompletions` in `prinfer/testing`.

## 2.2.0

### Minor Changes

- af0e0a6: Add CLI, MCP, and programmatic APIs for inspecting TypeScript autocomplete entries at a cursor position.

## 2.1.2

### Patch Changes

- 4582a54: Depend directly on TypeScript 6 so Bun cannot hoist the compatibility wrapper into its own internal dependency and initialize an empty compiler host.

## 2.1.1

### Patch Changes

- Fix TypeScript host initialization under Bun 1.3 by using runtime-compatible namespace imports for the TypeScript 6 compatibility package.

## 2.1.0

### Minor Changes

- Collapse long hover types by default and add `--full` and the programmatic `full` option for untruncated output.

  Add optional per-symbol type-resolution timing to the MCP, CLI, and programmatic interfaces without including startup, project-loading, or lookup time.

## 2.0.0

### Major Changes

- c85e4bc: Make the MCP interface easier for agents to consume with structured errors,
  structured batch-item failures, validated 1-based positions, a bounded batch
  size, and a canonical `hover_by_name` tool. Retain `hoverByName` as a deprecated
  compatibility alias and clarify the intentionally default TypeScript 7 backend.

  The batch item `error` field now contains a structured error object instead of
  a string.

### Minor Changes

- bab9441: Add runner-neutral inferred-type snapshot helpers under `prinfer/testing`.
  Retain `prinfer/vitest` as a deprecated compatibility alias.

## 1.0.0

### Major Changes

- 42376a6: Remove `inferType` and `inferTypeFromOptions` from public API. Use `hover()` instead for type lookups.

## 0.6.0

### Minor Changes

- 9f5cec0: Replace name-based lookup with position-based hover API

  BREAKING CHANGE: The API has changed from name-based to position-based lookup.

  - New `hover(file, line, column, options?)` function replacing name-based lookup
  - CLI syntax changed to `prinfer file:line:column [--docs] [--project path]`
  - MCP tool changed to `hover` with file, line, column parameters
  - Returns instantiated generic types at call sites
  - JSDoc/TSDoc extraction with `include_docs` option
  - Returns symbol kind and name in results

### Patch Changes

- 0397e29: Rename `/check-type` skill command to `/hover` for consistency with the API naming

## 0.5.3

### Patch Changes

- fix: use `claude mcp add` instead of manual config file writing

## 0.5.2

### Patch Changes

- 3b9dd90: Fix: use settings.json for Claude Code MCP configuration instead of claude_desktop_config.json

## 0.5.1

### Patch Changes

- 7aeb91f: Fix postinstall script to skip when dist folder is not built yet

## 0.5.0

### Minor Changes

- b30545c: Add `prinfer setup` command and improve help

  - Run `prinfer setup` to manually configure MCP server and skill
  - `prinfer-mcp --help` now shows setup instructions
  - Better error messages when auto-install fails

## 0.4.2

### Patch Changes

- ab0ae9e: Add logo to README and rename skill file to prefer-infer.md

## 0.4.1

### Patch Changes

- 0ddb3e8: Update README with "typehints for your AI agent" positioning.

## 0.4.0

### Minor Changes

- 39a73e8: Add auto-installed Claude skill on global install. Includes coding guideline for type inference and `/check-type` slash command.

## 0.3.0

### Minor Changes

- 66a3c64: Add MCP server support. Run `prinfer-mcp` to start the MCP server for use with Claude Code or Claude Desktop.

## 0.2.1

### Patch Changes

- 278e9d4: Add line-based type inference support. You can now specify a line number to find variables at specific locations using `file.ts:75 varName` syntax.

## 0.2.0

### Minor Changes

- a10dc10: Initial release of prinfer - TypeScript type inference inspection tool.

  Features:

  - CLI command (`prinfer <file> <name>`) to inspect inferred types
  - Programmatic API (`inferType()`) for library consumers
  - Dual ESM/CJS builds with TypeScript type declarations
  - Automatic tsconfig.json detection
