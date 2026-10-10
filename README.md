<p align="center">
  <img src="typeprobe-logo.webp" alt="typeprobe logo" width="400">
</p>

# typeprobe

typeprobe asks the TypeScript compiler what it infers (types, completions, type errors) so that AI coding agents and tests don't have to guess. It comes as:

- an MCP server for coding agents (Claude Code, Codex, Cursor, VS Code, Gemini CLI, any stdio client),
- `typeprobe/testing`, which returns inferred types as strings for snapshot tests,
- a CLI and a synchronous library API.

typeprobe was called prinfer until 4.0.0. See [Migrating from prinfer](#migrating-from-prinfer).

## Quick start

Give your agent the compiler:

```bash
npx -y typeprobe setup claude    # or codex, cursor, vscode, gemini; see Install
```

The agent can now call `hover_by_name(file: "src/utils.ts", name: "names")` and get `Type: string[]` back, or `diagnostics(file)` after an edit.

Lock the types your API infers in a test (Vitest, Jest, Bun, or any runner with snapshots):

```typescript
import { expect, test } from "vitest"; // or "bun:test"
import { inferredType } from "typeprobe/testing";
import { groupBy, type User } from "../src/users";

const users: User[] = [{ name: "Ada", role: "admin" }];
const byRole = groupBy(users, (user) => user.role);

test("groupBy keys the result by the callback's return type", () => {
  expect(inferredType(import.meta.url, { name: "byRole" }))
    .toMatchInlineSnapshot(`"Record<Role, User[]>"`);
});
```

Write the matcher empty (`toMatchInlineSnapshot()`) and the runner fills it in. A refactor that changes the type fails the test.

## Install

Every command runs through `npx`, so nothing needs installing first. After `npm i -g typeprobe`, drop the `npx -y` prefix: setup then registers the `typeprobe-mcp` binary, which skips npx's package check on each launch.

**Claude Code.** The plugin bundles the MCP server and a skill that tells Claude when to use it:

```text
/plugin marketplace add clockblocker/typeprobe
/plugin install typeprobe@typeprobe
```

**Other clients**, or Claude Code without the plugin:

| Client | Command | Writes |
| :- | :- | :- |
| Claude Code | `npx -y typeprobe setup claude` | `claude mcp add`; `--scope project` for a shared `.mcp.json` |
| Codex | `npx -y typeprobe setup codex` | `codex mcp add` (`~/.codex/config.toml`) |
| Cursor | `npx -y typeprobe setup cursor` | `~/.cursor/mcp.json`; `--scope project`: `.cursor/mcp.json` |
| VS Code | `npx -y typeprobe setup vscode` | `code --add-mcp`; `--scope project`: `.vscode/mcp.json` |
| Gemini CLI | `npx -y typeprobe setup gemini` | `~/.gemini/settings.json`; `--scope project`: `.gemini/settings.json` |

Any other MCP client: typeprobe is a stdio server started with `npx -y typeprobe mcp`.

```json
{
  "mcpServers": {
    "typeprobe": { "command": "npx", "args": ["-y", "typeprobe", "mcp"] }
  }
}
```

It is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.clockblocker/typeprobe) as `io.github.clockblocker/typeprobe` and on [Smithery](https://smithery.ai/servers/clockblocker/typeprobe).

Setup options:

- `--print` shows the command or config change without applying it.
- `--npx` registers `npx -y typeprobe mcp` even when `typeprobe-mcp` is installed. Use it when the client can't find `typeprobe-mcp`; editors started outside a shell often miss nvm, fnm, or volta paths.
- Re-running setup updates the `typeprobe` entry's command and leaves other servers alone. JSON configs keep keys you added to the entry, such as `env`. A JSON config that doesn't parse is left untouched, and setup prints the entry to add by hand.
- A `prinfer` entry from before the rename is replaced rather than kept next to the new one: `claude` and `codex` remove it, and JSON configs swap it for `typeprobe` in place, keeping its other keys (with `PRINFER_*` env names renamed to `TYPEPROBE_*`).
- On Windows the server is registered as `cmd /c npx -y typeprobe mcp` (or `cmd /c typeprobe-mcp`), because clients launch it without a shell and can't run npm's `.cmd` shims.

### Tell the agent when to use it

Tool descriptions only go so far; agents still reach for `tsc` or write annotations by hand. Add a short usage block to your instructions file (the Claude Code plugin ships the same guidance as a skill):

```bash
npx -y typeprobe setup agents-md                  # ./AGENTS.md
npx -y typeprobe setup agents-md --file CLAUDE.md
```

The block sits between `<!-- typeprobe:start -->` and `<!-- typeprobe:end -->`; re-running updates it in place, and replaces a block prinfer wrote (`<!-- prinfer:start -->`).

## MCP tools

| Tool | Use it for |
| :- | :- |
| `hover_by_name` | The type of a named symbol. Start here. |
| `hover` | The type of a token on a line: callback parameters, expressions, repeated names. |
| `batch_hover` | Up to 100 lookups, across files, in one call. |
| `completions` | What TypeScript offers at a cursor, such as string-literal union members. |
| `diagnostics` | Type errors in one file, without checking the whole project. |
| `annotations` | Annotations TypeScript would infer anyway. |

Shared parameters:

- `file` is absolute or relative to the server's working directory. Lines and columns are 1-based.
- `project` is a `tsconfig.json` path; the default is the nearest one above the file.
- `backend` (`typescript7` by default, or `typescript6`) on the hover tools and `diagnostics`. If a call fails or looks wrong on TypeScript 7, retry it with `typescript6`. See [Backends and compilers](#backends-and-compilers).
- Hover tools take `include_docs` (JSDoc), `include_cost` (see [Type cost budgets](#type-cost-budgets)), `full`, and `max_chars`. Type text is capped at 4000 characters per type, and a cut type ends with a line like `… truncated: 187 chars total, union of 4 members. Pass max_chars: N to see more (0 for no limit).` `full: true` turns off TypeScript's own truncation (`{ ...; }`, `... 12 more ...`) and lists every overload. Structured content is never cut.

### hover_by_name

```text
hover_by_name(file: "src/utils.ts", name: "names")
hover_by_name(file: "src/utils.ts", name: "names", line: 11)   # line picks among same-named symbols
```

```text
Type: string[]
Name: names
Kind: const
Position: 11:14
```

When a name is declared more than once, the lookup prefers declarations and says which it picked: `Matched line 8 of 2 declarations (also 12); pass line to choose.` The structured result lists the others as `alternatives: [{ line, column, kind }]`. A `line` that matches none fails with `SYMBOL_NOT_FOUND` and lists the declaration lines in `declaredAt`. A `line` where the name is used rather than declared, such as `box.value` in an `if`, gives the type there, narrowed by the code around it.

Overloaded functions show the first signature, then up to three more (`full: true` lists all; structured `overloads` always has every one):

```text
Type: (value: string): number (+1 overload)
Overloads:
  (value: number): string
Returns: number
Name: parse
Kind: function
Position: 1:17
```

### hover

Pass `text` copied from the line and typeprobe finds the column. Whole identifiers match first: on `users.map((user) => user.name)`, `text: "user"` skips `users` and hits the callback parameter, and `occurrence: 2` picks the next `user`. Only when the line has no whole-identifier match is `text` matched as a substring. `column` works in place of `text`. Generic calls show their instantiated types, as in an editor.

```text
hover(file: "src/utils.ts", line: 11, text: "user")
```

```text
Type: { id: number; name: string; }
Name: user
Kind: parameter
Position: 11:33
Target: "user" at 11:33
```

If the text isn't on the line, the error quotes the line:

```text
Error [SYMBOL_NOT_FOUND]: Text "nope" not found on line 11 of /project/src/utils.ts
Nearby identifiers: name, names, map, user, users
Suggestion: Line 11 reads: "export const names = users.map((user) => user.name);". Copy text exactly from it, or give a column instead.
```

### batch_hover

Each item is `{name, line?}`, `{line, text, occurrence?}`, or `{line, column}`, with an optional `file` that overrides the shared top-level `file`. Failures are per item, including a missing file, so one bad lookup doesn't lose the rest.

```text
batch_hover(file: "src/utils.ts", positions: [
  {name: "users"},
  {line: 11, text: "user"},
  {file: "src/missing.ts", line: 1, column: 1}
])
```

```text
Batch hover results: 2 succeeded, 1 failed

--- src/utils.ts:users:6 ---
Type: { id: number; name: string; }[]
...

--- src/missing.ts:1:1 ---
Error [FILE_NOT_FOUND]: File not found: /project/src/missing.ts
Suggestion: Check the path. Relative paths resolve against the MCP server's working directory (/project); pass an absolute path to be sure.
```

A line or column outside the file is an `INVALID_ARGUMENT` error that gives the valid range.

### Hover results

Every hover returns the same fields on every backend and surface:

- `signature`: the type text alone, on one line, without the declaration keyword or name an editor hover starts with. `string[]` for a variable, `(value: string): number` for a function, the instantiated signature for a call. Type aliases keep their name and type parameters (`type Event = { kind: "open"; ... } | ...`); interfaces and classes are their name (`Box<T>`). Optional members read as `tsc` writes them in declarations: `digits?: number`, with `| undefined` only where the source wrote it or the type isn't the annotation's (an instantiated generic, a `Partial<T>`).
- `display`: the editor's hover text (`const names: string[]`). Only the TypeScript 7 language server reports it.
- `kind`: the editor's label (`function`, `method`, `const`, `parameter`, `property`, `type`, `interface`, `class`, `enum`, ...), plus `call` for the callee of a call.
- `returnType`, `documentation`, `overloads`, `unionMembers`, and `alternatives` when they apply.
- `cost`: `{ instantiations, types }` with `include_cost: true`.
- `compiler`: `{ name, version, source }`, the compiler that answered.

### completions

The cursor sits before the character at `column`; for a string union, put it just inside the opening quote.

```text
completions(file: "src/utils.ts", line: 14, column: 30)
completions(file: "src/utils.ts", line: 20, column: 1, prefix: "use", limit: 20)
```

Entries come in TypeScript's ranking: locals, members, and literal values first, then globals (keywords after other entries of the same rank), then auto-imports. At most `limit` come back (default 50, up to 500); when more match, the text ends with `… 947 more; pass prefix to narrow, or raise limit` and the structured result has `total` and `truncated: true`.

`prefix` keeps names that start with it, ignoring case. Without it, the text typed left of the cursor filters the list as in an editor (after `use` in `useSt`, only `use…` names); `prefix: ""` turns that off. At a key of an object literal that accepts any key (`Record<string, number>`), typeprobe returns no entries and a `note` saying so, instead of every global. `completions` always runs on TypeScript 6.

### diagnostics

Run it on each file you edited; the edit is done when none reports an error.

```text
diagnostics(file: "src/utils.ts")
diagnostics(file: "src/utils.ts", include_suggestions: true)   # also TS6133 unused variables etc.
```

```text
src/utils.ts:16:14 error TS2322: Type 'string' is not assignable to type 'number'.
1 error, 0 warnings.
```

A clean file returns `No type errors.`

### annotations

```text
annotations(file: "src/utils.ts")
```

```text
src/utils.ts:2:55 redundant return type of format: declared string, inferred string (exported)
src/utils.ts:14:19 widening drink: declared Drink, inferred "tea" (exported)
2 redundant, 2 widening (5 annotations checked).
redundant: delete the annotation; the type stays the same.
widening: the annotation is wider than the inferred type; keep it if the wider type is intended.
```

A `redundant` annotation can be deleted without changing the type. A `widening` one is often deliberate (a variable that must accept any `Drink` later, an exported contract), so treat it as a question. Only annotations with an initializer or body to infer from are checked. Each structured finding has the range of the `: Type` text, `declared`, `inferred`, `exported`, and a `suggestion`. `annotations` always runs on TypeScript 6.

### Errors

Every tool returns text plus structured content: `{ version: 1, ok: true, result }` or `{ version: 1, ok: false, error }`. The text of a failure carries the code, message, and recovery hints, because many clients show the model only the text:

```text
Error [SYMBOL_NOT_FOUND]: No symbol named "nmes" at line 11 found in src/utils.ts
Did you mean: names, name?
Suggestion: Check the spelling against candidates, pass line to pick the match on a known line, or call hover with that line and text copied from it.
```

`error` has `code` (`INVALID_ARGUMENT`, `FILE_NOT_FOUND`, `SYMBOL_NOT_FOUND`, `TYPESCRIPT_ERROR`, or `INTERNAL_ERROR`), `message`, `suggestion`, and, where they apply, `file`, `line`, `column`, `project`, `candidates` (close identifiers from the file, or those near the line), and `declaredAt`. Each tool's `outputSchema` covers both outcomes in one envelope and lists the error fields an agent recovers with; the others are still sent. The CLI's `--json` output and the exported zod schemas (`hoverSuccessSchema`, `contractErrorResponseSchema`, ...) use the same contract.

## Type tests

`typeprobe/testing` returns the type as the editor displays it, so the snapshot is never written by hand, unlike `expectTypeOf` or `tsd`, and any change shows up, including a literal union widening to `string`. Update snapshots after an intended change with the runner's update flag (`vitest -u`, `bun test --update-snapshots`). The lookup helpers are synchronous on both backends, so there is no promise to forget to await.

```typescript
import { inferredCompletions, inferredType } from "typeprobe/testing";

// Another module: resolve it against the test file.
expect(inferredType(new URL("../src/users.ts", import.meta.url), { name: "groupBy" }))
  .toMatchInlineSnapshot(`"<T, K extends PropertyKey>(items: readonly T[], key: (item: T) => K): Record<K, T[]>"`);

// Line 7 of this test file reads: const fallback: Role = "member";
expect(inferredCompletions(import.meta.url, { line: 7, text: '"' }))
  .toMatchInlineSnapshot(`
    [
      "admin",
      "member",
    ]
  `);
```

| Helper | Returns |
| :- | :- |
| `inferredType(file, selector)` | The printed type (`signature`). |
| `inferredTypeInfo(file, selector)` | The full hover result: name, kind, return type, docs, cost. |
| `inferredCompletions(file, selector)` | Every completion name at a cursor, on TypeScript 7, with no filter or limit. |
| `inferredTypeCost(file, selector)` | `{ instantiations, types }`; see [Type cost budgets](#type-cost-budgets). |
| `inferredTypeIssues(file, selector)` | Readability issues; see [Readability checks](#readability-checks). |
| `typeReadabilityIssues(text, rules?)` | Readability issues in any printed type text. |
| `expectType(file, selector)` | Checks text, cost, and readability at once; see [expectType](#expecttype). |
| `expectTypes(file, selector)` | `expectType` for several targets, plus a budget for all of them; see [expectTypes](#expecttypes). |
| `closeTestingSessions()` | Stops the TypeScript 7 compilers early; see [TypeScript 7 in tests](#typescript-7-in-tests). |

The file is `import.meta.url` for the test file itself, or a `URL` resolved against it. Plain string paths resolve against `process.cwd()`. The file is read through its nearest `tsconfig.json`, or `project`.

The selector picks the target:

- `{ name, line? }`: a declaration by name; `line` picks among repeats.
- `{ line, text, occurrence? }`: the token where `text` starts on that line, matched like the `hover` tool's `text`. For `inferredCompletions` the cursor goes right after the match, so `text: "user."` lists members and `text: '"'` lists string-literal members; `cursor: "start"` puts it before.
- `{ line, column }`: a 1-based position (for completions, the cursor sits before that column).

Options go in the same object, e.g. `{ name: "byRole", backend: "typescript7" }`. A third argument throws.

| Option | Default | Effect |
| :- | :- | :- |
| `backend` | `"typescript6"` | `"typescript7"` prints TypeScript 7's output. `inferredCompletions` always uses TypeScript 7. |
| `full` | `true` | `false` gives the editor's shortened form (`{ ...; }`). |
| `sort_unions` | `false` | Prints unions in a fixed order; see below. |
| `include_docs` | `false` | Adds `documentation` to `inferredTypeInfo`. |
| `include_cost` | `false` | Adds `cost` to `inferredTypeInfo` (TypeScript 6 only). |
| `project` | nearest `tsconfig.json` | The tsconfig to read the file with. |
| `compiler` | `TYPEPROBE_COMPILER`, else `"bundled"` | Whose TypeScript to use; see [Bundled or project compilers](#bundled-or-project-compilers). |
| `timeout` | `60000` | Milliseconds a TypeScript 7 call may block before it throws. |
| `strict` | `false` | Throws on unknown keys, naming the closest valid one. Test runners don't type-check test files, so without it a camelCase `sortUnions` does nothing. |

Failed lookups throw with the fix in the message: an unknown name lists the closest declarations, missing text quotes the line, and a missing relative path explains how to resolve it against the test file.

`typeprobe/vitest` is a deprecated alias for `typeprobe/testing`.

### Stable union order

TypeScript 6 and TypeScript 7 print union members in different orders (`"idle" | "error"` on one, `"error" | "idle"` on the other), so a snapshot written on one backend fails on the other. `sort_unions: true` prints every union, at any depth, in the same order on both: members sorted by their text (UTF-16 code units, so `1 | 10 | 2`), with `null` and `undefined` last.

```typescript
expect(inferredType(import.meta.url, { name: "status", sort_unions: true }))
  .toMatchInlineSnapshot(`""error" | "idle" | "loading" | null"`);
```

Only union members move. Property order can still differ: `cond ? { ok: true, value: 1 } : { ok: false, error: "e" }` prints `{ ok: false; error: string; value?: undefined; }` on TypeScript 6 and `{ value?: undefined; ok: false; error: string; }` on TypeScript 7, and a mapped type over a union of keys lists its properties in each backend's union order. The library's hover options and the CLI (`--sort-unions`) take the option too.

### Types of values you don't have

To pin what a function infers for an argument you have no value for, declare the argument in a fixture file. A `declare const` in the test file itself has no runtime value, so the test throws a `ReferenceError` when it runs.

```typescript
// test/groupBy.fixture.ts, read for types only, never run
import { groupBy, type User } from "../src/users";
declare const input: User[];
export const byName = groupBy(input, (user) => user.name);

// test/users.test.ts
expect(inferredType(new URL("./groupBy.fixture.ts", import.meta.url), { name: "byName" }))
  .toMatchInlineSnapshot(`"Record<string, User[]>"`);
```

### Readability checks

A type can be right and still print in a form a reader has to work out. `inferredTypeIssues(file, selector)` returns those places in a target's printed type (an empty array means none), and `typeReadabilityIssues(text, rules?)` in any type text. The default rules:

- `utility-type`: an unresolved utility type with type arguments, at any depth: `Omit`, `Pick`, `Partial`, `Required`, `Readonly`, `Exclude`, `Extract`, `NonNullable`, `ReturnType`, `Parameters`, `ConstructorParameters`, `InstanceType`, `Awaited`, `ThisParameterType`, `OmitThisParameter` (exported as `DEFAULT_UTILITY_TYPES`). Only the outermost of nested ones is reported. One over a type parameter of the printed signature (`Omit<T, "id">` in `<T>(value: T) => Omit<T, "id">`) is not, since nothing can resolve it before `T` is known. `Record`, `Promise`, `Array`, and other generic types are not flagged.
- `object-intersection`: an intersection with an object type, such as `User & { id: string; }` or a mapped type. `string & {}`, which keeps literal suggestions, is not flagged.
- `truncation`: `... 3 more ...`, `{ ...; }`, a `...` placeholder, and text cut at the length limit. The helpers print untruncated types unless `full: false`, so this mostly catches `full: false` and text from elsewhere.

The text is read with the TypeScript scanner and parser, so a string literal type like `"Omit<"` or `"..."` is not flagged, nor is a rest parameter or spread tuple. Each issue is `{ rule, text, offset, message }`. Text that doesn't parse even with truncation markers removed (cut at the length limit) gets truncation issues only.

`rules` takes `utilityTypes` (the names to flag, e.g. `[...DEFAULT_UTILITY_TYPES, "DeepPartial"]`, or `false`), `objectIntersections` and `truncation` (`false` turns them off), and `allow`, fragments that are fine as printed:

```typescript
expect(
  inferredTypeIssues(import.meta.url, { name: "userId", rules: { allow: ['string & { readonly __brand: "UserId"; }'] } }),
).toEqual([]);
```

### Type cost budgets

`inferredTypeCost` counts the work TypeScript does for a type, so a test can stop an expensive type from getting more expensive:

```typescript
import { inferredTypeCost } from "typeprobe/testing";

test("userSchema stays cheap to infer", () => {
  expect(inferredTypeCost(import.meta.url, { name: "userSchema" }).instantiations)
    .toBeLessThan(5_000);
});
```

It returns `{ instantiations, types }`: the type instantiations (what `tsc --extendedDiagnostics` reports as `Instantiations`) and types that a fresh TypeScript 6 checker creates while it resolves the target and writes out its untruncated type. Because each count gets a new checker, the numbers are the same on every run, in every process, in any test order, and with any display option; only the code, the compiler options, and the TypeScript version change them. The count runs on typeprobe's bundled TypeScript 6 unless you pass `compiler: "project"`; either way, pin that version in a project that budgets types. The cost's non-enumerable `compiler` says which one counted. typeprobe reports no wall-clock time, since identical runs differ by several times.

The count covers what the target's type takes: for `const x = expr`, checking `expr`; for a function without a return type annotation, inferring the return type. Code the type doesn't depend on isn't counted, such as an initializer under an annotation (`const x: T = expr` takes its type from `T`); target the expression with `{ line, text }` to count it.

To count several targets of one file, pass `names` for a record by name, or `targets` (any selector shape, without options) for an array in order. Only `project`, `compiler`, and `strict` go next to them; with `strict: true`, a batch rejects display options such as `full`.

```typescript
const costs = inferredTypeCost(import.meta.url, { names: ["userSchema", "orderSchema"] });
expect(costs.userSchema.instantiations).toBeLessThan(5_000);

const [first, second] = inferredTypeCost(import.meta.url, {
  targets: [{ name: "userSchema" }, { line: 12, text: "parse(" }],
});
```

A batch counts exactly what single calls do. What it shares is loading: within one process a project's files are parsed once per compiler, so counting in another file of the project takes 30 to 70 ms on top of the counts instead of about 300 ms (on typeprobe's own repository), and an unchanged target is counted only once. The count itself is never shared: a type that takes 80,000 instantiations takes about 250 ms to count. `bun test` runs every test file in one process, so the project loads once; with Vitest's default isolation, each test file loads it again.

TypeScript 7 exposes no instantiation counts, so costs are TypeScript 6 only: with `backend: "typescript7"`, `inferredTypeCost` and `include_cost` throw. Elsewhere, `include_cost` (MCP, library) and `--cost` (CLI) add the same numbers to a hover result.

If you type-check with TypeScript 7, the TypeScript 6 counts are still a close guide. Measured with `--extendedDiagnostics` (TypeScript 7.0.2 with `--checkers 1` against 6.0.3) on ten single-declaration projects, seven counted the same instantiations, two differed by 2% or less, and a recursive dotted-path type counted 17% more on TypeScript 7. Ranked by cost, the declarations came out in nearly the same order. A budget with 20% headroom held for every case measured; leave more for recursive key and path types. Compare against TypeScript 7 with `--checkers 1`: otherwise it adds up the counts of its parallel checkers.

### expectType

`expectType` checks a target's printed type, cost, and readability in one call, and throws one error listing every check that failed:

```typescript
import { expectType } from "typeprobe/testing";

test("user stays readable and cheap", () => {
  expectType(import.meta.url, {
    name: "user",
    printed: "{ id: string; name: string; }",
    maxInstantiations: 500,
    readable: true,
  });
});
```

```text
expectType failed 3 checks for "user" at test/users.test.ts:9:14:
- printed: the type differs at character 1.
    expected: { id: string; name: string; }
    actual:   Omit<User, "email">
              ^
- maxInstantiations: 612 instantiations, over the budget of 500 by 112 (counted and printed on typescript 6.0.3, bundled).
- readable: 1 readability issue:
    utility-type: Omit<User, "email"> is unresolved: TypeScript printed Omit<...> instead of the type it produces.
```

The selector is `inferredType`'s plus at least one check:

- `printed`: the exact text `inferredType` returns for the same selector (`backend`, `compiler`, `sort_unions`, and `full` apply).
- `maxInstantiations`, `maxTypes`: cost budgets. Costs are always counted on TypeScript 6, even with `backend: "typescript7"`, which only picks where the text comes from. With `backend: "typescript7"` and `compiler: "project"`, the count uses the project's TypeScript 6 if it has one, else the bundled one.
- `readable`: `true` for the default readability rules, or a rules object.

`costCompiler` (`"bundled"`, `"project"`, or `"auto"`, default `compiler`'s) picks the TypeScript 6 that counts, so the text and the count can come from different compilers: `{ backend: "typescript7", costCompiler: "project" }` prints on the bundled TypeScript 7 and counts on the project's TypeScript 6. A failed budget names both. `inferredTypeCost` only counts, so there `compiler` is the counting compiler and `costCompiler` throws.

The error is a `TypeExpectationError` with every failure in `failures`; when the text differs it also carries `actual` and `expected`, so Vitest and Jest print their diff. When every check passes, `expectType` returns `{ printed, cost? }`.

### expectTypes

`expectTypes` runs `expectType` on several targets of one file, with a budget for all of them together, and throws one error listing every failed check:

```typescript
expectTypes(import.meta.url, {
  types: [
    { name: "userSchema", maxInstantiations: 3_000 },
    { name: "User", printed: "{ id: string; name: string; }" },
    { name: "orderSchema" },
  ],
  maxInstantiations: 8_000,
  backend: "typescript7",
  costCompiler: "project",
});
```

The group's `maxInstantiations` and `maxTypes` count one fresh TypeScript 6 checker resolving every target, so work the targets share (a schema they all reach) is counted once, as a type check of the module counts it. A checker's count can depend, by a type or so, on the order it meets types in, so the targets are always resolved in source order: the total is the same in any order of `types`. Each entry's own budgets still count it alone; a failed group budget lists each entry's count alone, and those add up to more than the total.

Each entry takes `expectType`'s selector, and needs a check of its own only when the group has no budget. `backend`, `full`, `sort_unions`, `readable`, and `timeout` on the group are defaults for every entry. `project`, `compiler`, and `costCompiler` go on the group only, since the total is counted on one program. Failures carry the entry's `index`, none for the group budget. It returns `{ types, cost? }`: each entry's `expectType` result (with its own cost when the group has a budget) and the group's cost.

### TypeScript 7 in tests

TypeScript 7 runs in a worker thread with one compiler process per project, and each call blocks until the compiler answers. Neither keeps the test process alive, so no teardown is needed.

A test runner's timeout can't interrupt a blocked call, so typeprobe has its own: a call with no answer within `timeout` milliseconds (default 60000) throws and stops that compiler, and the next call starts a new one. A hung compiler fails one test instead of stalling the run. For a project that loads slower, raise it on every call with a shared selector such as `const ts7 = { backend: "typescript7", timeout: 120_000 } as const`. If the compiler process exits, the call in flight retries once.

`closeTestingSessions()` stops the compilers early and is safe to skip. If you call it, call it once per run after the last test, not per test file: the next TypeScript 7 call starts a new compiler and loads the project again (about 190 ms on typeprobe's repository, against 2 ms for a warm call). Under `bun test`, put `afterAll(closeTestingSessions)` in a `--preload` file (`preload` in `bunfig.toml`). Under Vitest, leave it out: `setupFiles` run per test file, and `globalSetup` runs in a process with no sessions. It doesn't affect TypeScript 6, whose programs stay loaded.

## CLI

```bash
# Type by name, optionally with a line hint
typeprobe src/utils.ts:format
typeprobe src/utils.ts:names:11
typeprobe 'src/store.ts:$store'          # any JavaScript identifier

# Type of a token: text copied from the line, or a column
typeprobe src/utils.ts:11:user
typeprobe src/utils.ts:11 --text user --occurrence 2
typeprobe src/utils.ts:11:33

typeprobe src/utils.ts:format --docs
typeprobe src/utils.ts:largeType --full --max-chars 0
typeprobe src/utils.ts:status --sort-unions
typeprobe src/utils.ts:format --cost
typeprobe src/utils.ts:format -p ./tsconfig.json --compiler project

# Completions: the top 50, filtered by the text left of the cursor
typeprobe complete src/utils.ts:14:30
typeprobe complete src/utils.ts:11:user.  # cursor right after the text
typeprobe complete src/utils.ts:20:1 --prefix use --limit 20

typeprobe check src/utils.ts              # type errors in one file
typeprobe annotations src/utils.ts        # annotations TypeScript would infer anyway
```

```text
$ typeprobe src/utils.ts:format --docs
(value: number, digits?: number): string
returns: string
name: format
kind: function
docs: Formats a number with a fixed number of digits.
```

Type lookups and `check` use TypeScript 6 unless you pass `--backend typescript7`; `complete` and `annotations` always use TypeScript 6. Run `typeprobe --help` for every option.

- In `<file>:<line>:<text>`, everything after the line is the text, colons and dots included. All-digit text reads as a column, so pass it with `--text`.
- Value options take `--opt value` or `--opt=value`. An unknown option, or one the command doesn't take, is an error.
- Single-quote any argument with a `$`: shells expand `$store`, and zsh reads `$F:r` in `"$F:root"` as a modifier.
- Failures print the error, `Did you mean: …?` candidates, and a suggestion on stderr, and exit 1. `check` also exits 1 when the file has type errors (warnings don't count); `annotations` exits 0 whatever it finds.
- `--json` prints the versioned contract on stdout, never capped, and nothing on stderr. Check `ok` to tell a failed run from a file with type errors.

```bash
$ typeprobe src/utils.ts:names --json
{"version":1,"ok":true,"result":{"signature":"string[]","line":11,"column":14,"kind":"const","name":"names","compiler":{...}}}
```

`typeprobe mcp` starts the MCP server on stdio, the same as the `typeprobe-mcp` binary. `typeprobe setup` is described under [Install](#install).

## Library API

The library is synchronous, runs on TypeScript 6, and throws on failure, mostly `TypeprobeError`s (exported from `typeprobe` and `typeprobe/testing`) with a `code` and `suggestion`. `contractError(error)` turns a caught error into the contract shape.

```typescript
import { annotations, batchHover, completions, diagnostics, hover } from "typeprobe";

hover("./src/utils.ts", "format");
// => { signature: "(value: number, digits?: number): string", returnType: "string",
//      line: 2, column: 17, kind: "function", name: "format" }
hover("./src/utils.ts", "names", { line: 11 });          // line hint for repeated names
hover("./src/utils.ts", 11, 33);                         // by position
hover("./src/utils.ts", "format", { include_docs: true, include_cost: true });

// Several positions in one file, one program load; bad positions fail per item
batchHover("./src/utils.ts", [{ line: 11, column: 14 }, { line: 11, column: 33 }]);
// => { items: [...], successCount: 2, errorCount: 0 }

// Every entry, ranked, unless you pass prefix or limit
completions("./src/utils.ts", 14, 30).entries.map((entry) => entry.name);
// => ["coffee", "tea"]

diagnostics("./src/utils.ts", { include_suggestions: false });
// => { file, errorCount: 1, warningCount: 0, diagnostics: [{ line: 16, column: 14, code: 2322, ... }] }

annotations("./src/utils.ts").findings.map((finding) => `${finding.kind} ${finding.name}`);
// => ["redundant format", "widening drink", "redundant label", "widening mode"]
```

Options: `project`, `compiler`, and, for hovers, `include_docs`, `include_cost`, `full`, and `sort_unions`.

## Backends and compilers

| Surface | Type lookups | Completions | Type errors | Annotations |
| :- | :- | :- | :- | :- |
| MCP server | TS7; `backend: "typescript6"` | TS6, top 50 | TS7; `backend: "typescript6"` | TS6 |
| CLI | TS6; `--backend typescript7` | TS6, top 50 | TS6; `--backend typescript7` | TS6 |
| Library | TS6 | TS6, all entries | TS6 | TS6 |
| `typeprobe/testing` | TS6; `backend: "typescript7"` | TS7, all names | none | none |

`typescript7` runs the native TypeScript 7 language server, with one warm session per project shared across requests; its output is closest to what your editor shows. (`typeprobe/testing` uses TypeScript 7's compiler API instead.) `typescript6` uses the TypeScript 6 compiler API in-process. Type costs are counted on TypeScript 6 everywhere.

The TypeScript 7 backend is experimental: its programmatic API and hover format may still change. Both backends pick the same symbol for a name, report the position of its name token, and count lines the way TypeScript does (CR, LF, CRLF, U+2028, and U+2029 end a line; a leading BOM is ignored). Known differences:

- Only the language server reports `display`.
- A `project` the language server wouldn't pick itself (it uses the nearest tsconfig.json, or a project that one references), such as an unreferenced `tsconfig.test.json`, is opened in the same session through the TypeScript 7 API, so its hovers have no `display`. That tsconfig must include the file, through `include`, `files`, or an import, or the call fails with `INVALID_ARGUMENT`. TypeScript 6 adds the file to any project.
- Edits to files reached by relative imports are seen immediately. `diagnostics` also rescans the tsconfig's include directories (bounded, skipping `node_modules`, build output, and dot-directories); other unopened edits reach the language server through its file watcher shortly after.

### Bundled or project compilers

By default typeprobe prints and counts with the TypeScript 6 and 7 it depends on (`typescript` 6, and `@typescript/native`, an alias of `typescript` 7), so results are the same on every machine whatever the project installs. To get what your own compiler infers, so snapshots and budgets move when you upgrade it, use the project's compilers:

| Mode | TypeScript 6 backend | TypeScript 7 backend |
| :- | :- | :- |
| `bundled` (default) | typeprobe's `typescript` | typeprobe's `@typescript/native` |
| `project` | the project's `typescript`, 5.0 to 6.x | the project's `typescript` 7, `@typescript/native`, or `@typescript/native-preview` 7.0.0-dev.20260624.1 or later |
| `auto` | the project's when supported, else bundled | the project's when supported, else bundled |

Set it with `compiler` (library options and `typeprobe/testing` selectors), `--compiler` (CLI), or `TYPEPROBE_COMPILER` (every surface, including the MCP server); an explicit option wins. The packages are resolved the way Node resolves an import from the directory of the file's `tsconfig.json` (or of `project`); for TypeScript 7 the nearest of `typescript` 7, `@typescript/native`, and `@typescript/native-preview` wins, in that order when they sit side by side. typeprobe runs that package's own API client and compiler binary. A package manager that hoists typeprobe's own `typescript` and `@typescript/native` puts them where the project resolves them too; such a copy is the project's only if the project's nearest `package.json`, or its workspace root's, declares the package, and then it runs and is reported as the bundled compiler.

`project` throws a `TYPESCRIPT_ERROR` when the project has no compiler for the backend, and names the package, version, and path when it has an unsupported one: `typescript` before 5.0, a `typescript` 7 asked for TypeScript 6 output, or a `@typescript/native-preview` older than 7.0.0-dev.20260624.1. `auto` falls back to the bundled compiler, with one warning on stderr when the project's is unsupported. On TypeScript 5.0 to 5.8 some types and messages print differently from TypeScript 6, so expect snapshot changes when you switch.

Every result names its compiler as `compiler: { name, version, source }`, with `source` `"bundled"` or `"project"`. On library and testing results it is non-enumerable, so snapshots, `toEqual`, and `JSON.stringify` don't change when only the compiler does; read it directly (`inferredTypeInfo(...).compiler`). The CLI's `--json` output and the MCP structured content include it in `result`, and cost lines name it: `cost: 412 instantiations, 96 types (typescript 6.0.3, bundled)`.

One process runs one TypeScript 7 compiler at a time: a call that needs another waits for the calls in flight, closes their sessions, and starts it.

### Environment variables

| Variable | Effect |
| :- | :- |
| `TYPEPROBE_BACKEND=typescript6` | MCP server only: default backend for the hover tools and `diagnostics`. An explicit `backend` argument, or `include_cost`, wins. |
| `TYPEPROBE_COMPILER=project` | `bundled`, `project`, or `auto` on every surface; see above. |

The prinfer-era names `PRINFER_BACKEND` and `PRINFER_COMPILER` are deprecated but still read when the `TYPEPROBE_*` variable is unset.

## Requirements

Node.js 20 or later. typeprobe bundles its own TypeScript 6 and 7, so your project's `typescript` version doesn't matter unless you opt into [project compilers](#bundled-or-project-compilers). The TypeScript 7 package is loaded only when a TypeScript 7 call needs it.

## Migrating from prinfer

prinfer was renamed to typeprobe in 4.0.0. Results, snapshots, and the JSON contract are unchanged, apart from `error.name`, which is now `"TypeprobeError"`. The last prinfer, 3.5.0, depends on typeprobe and forwards to it (its `prinfer` and `prinfer-mcp` commands, and `prinfer`, `prinfer/testing` and `prinfer/vitest` imports), so old setups keep working until you switch. Its CLI prints a one-line notice on stderr; the MCP server prints nothing.

| prinfer 3.x | typeprobe 4 |
| :- | :- |
| `npm i -D prinfer` | `npm rm prinfer && npm i -D typeprobe` |
| `import { inferredType } from "prinfer/testing"` | `import { inferredType } from "typeprobe/testing"` (also `typeprobe`, `typeprobe/vitest`) |
| `prinfer`, `prinfer-mcp`, `npx -y prinfer mcp` | `typeprobe`, `typeprobe-mcp`, `npx -y typeprobe mcp` |
| MCP server `prinfer` | MCP server `typeprobe`: re-run `npx -y typeprobe setup <client>`, which replaces the `prinfer` entry |
| `PRINFER_BACKEND`, `PRINFER_COMPILER` | `TYPEPROBE_BACKEND`, `TYPEPROBE_COMPILER` (the old names are still read when the new ones are unset) |
| error name `PrinferError` | `TypeprobeError`, now exported; `PrinferError` is a deprecated alias of the same class, so `instanceof` works with either |
| Claude Code plugin `prinfer@prinfer` | `/plugin uninstall prinfer@prinfer`, `/plugin marketplace remove prinfer`, then the two commands under [Install](#install) |
| MCP Registry `io.github.clockblocker/prinfer`, Smithery `clockblocker/prinfer` | `io.github.clockblocker/typeprobe`, `clockblocker/typeprobe` |
| `<!-- prinfer:start -->` block in AGENTS.md | `npx -y typeprobe setup agents-md` replaces it |

`setup vscode` at user scope goes through `code --add-mcp`, which can't remove servers: delete the old `prinfer` server from VS Code's MCP list yourself.

## Development

```bash
bun install
bun run ci    # typecheck, build, biome check, tests
```

The repository type-checks with TypeScript 7 (`bun run typecheck`); TypeScript 6 does the declaration bundling.

Add a changeset for user-facing changes (`bun run changeset`). To release, run `bun run version` (it applies the changesets and copies the version into `server.json`, the plugin manifest, and the MCPB manifest), commit, then publish by hand: `bun run release` publishes to npm, and `bun run mcpb` packs the bundle for Smithery.

### Publishing the rename (typeprobe 4.0.0 and prinfer 3.5.0)

`shim/prinfer/` is the final prinfer release: plain JavaScript, no build, not part of typeprobe's package. Publish it only after typeprobe 4.0.0 is on npm, since it depends on `typeprobe@^4.0.0`.

1. Release typeprobe as usual: `bun run version`, commit `chore: release typeprobe 4.0.0`, then `bun run release` (npm), and tag `v4.0.0`. Check with `npx -y typeprobe@4.0.0 --version`.
2. Publish the shim: `bun run shim:pack` (writes `prinfer-3.5.0.tgz`), then `npm publish prinfer-3.5.0.tgz`. Check with `npx -y prinfer@3.5.0 --version`, which prints the notice and 4.0.0.
3. Deprecate every prinfer version, the shim included, so each install points at typeprobe (the shim still works):
   ```bash
   npm deprecate prinfer "prinfer is now typeprobe: npm i -D typeprobe. Migration guide: https://github.com/clockblocker/typeprobe#migrating-from-prinfer"
   ```
4. MCP Registry: `mcp-publisher login github`, `mcp-publisher publish` (registers `io.github.clockblocker/typeprobe`, which the registry checks against `mcpName` in typeprobe's package.json), then deprecate the old name:
   ```bash
   mcp-publisher status --status deprecated --all-versions \
     --message "Renamed to io.github.clockblocker/typeprobe (npm: typeprobe)" \
     io.github.clockblocker/prinfer
   ```
5. Smithery: `bun run mcpb`, then `npx -y smithery@1.2.0 mcp publish ./typeprobe.mcpb -n clockblocker/typeprobe` (needs `SMITHERY_API_KEY`). Point the old `clockblocker/prinfer` listing at the new one, or unpublish it, in Smithery's settings.

## License

MIT
