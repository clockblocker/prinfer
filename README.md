<p align="center">
  <img src="printfer-logo.webp" alt="prinfer logo" width="400">
</p>

# prinfer

prinfer lets AI coding agents ask the TypeScript compiler what it infers (types, completions, type errors) instead of guessing, through an MCP server, a CLI, or a library.

## Type regression tests

`prinfer/testing` returns an inferred type as a string, so a test can pin it with an ordinary snapshot matcher in Vitest, Jest, Bun, or any compatible runner. Use it to lock the types your public API infers: a refactor that changes one fails the test. The example is `test/users.test.ts`, next to a `src/users.ts` that exports `groupBy`, `Role`, and `User`.

```typescript
import { expect, test } from "vitest"; // or "bun:test"
import { inferredCompletions, inferredType } from "prinfer/testing";
import { groupBy, type Role, type User } from "../src/users";

const users: User[] = [{ name: "Ada", role: "admin" }];
const byRole = groupBy(users, (user) => user.role);
const fallback: Role = "member";

test("groupBy keys the result by the callback's return type", () => {
  expect(inferredType(import.meta.url, { name: "byRole" }))
    .toMatchInlineSnapshot(`"Record<Role, User[]>"`);
});

test("groupBy keeps its public signature", () => {
  expect(inferredType(new URL("../src/users.ts", import.meta.url), { name: "groupBy" }))
    .toMatchInlineSnapshot(`"<T, K extends PropertyKey>(items: readonly T[], key: (item: T) => K): Record<K, T[]>"`);
});

test("Role offers its members", () => {
  expect(inferredCompletions(import.meta.url, { line: 7, text: '"' }))
    .toMatchInlineSnapshot(`
    [
      "admin",
      "member",
    ]
  `);
});
```

Write the matcher empty (`toMatchInlineSnapshot()`) and the runner fills it in; after an intended type change, update it with the runner's snapshot update (`vitest -u`, `bun test --update-snapshots`). Unlike `expectTypeOf` or `tsd`, you never write the expected type by hand: the snapshot is the type as the editor displays it, so any change shows up, including a literal union widening to `string`.

The first argument is the file to inspect: `import.meta.url` for the test file itself, or `new URL("../src/users.ts", import.meta.url)` for another module. Plain string paths resolve against `process.cwd()`, not the test file. The source is read through its nearest `tsconfig.json`, or `project` when given.

The second argument picks the target:

- `{ name, line? }`: a declaration by name; `line` picks among repeats.
- `{ line, text, occurrence? }`: the token where `text` starts on that line, matched like the `hover` tool's `text`.
- `{ line, column }`: a 1-based position.

Options (`backend`, `project`, `compiler`, `full`, `include_docs`, `sort_unions`, `include_cost`, `timeout`, `strict`) go in the same object, e.g. `{ name: "byRole", backend: "typescript7" }`. There is no third argument; passing one throws. Keys a helper doesn't know are ignored. Pass `strict: true` to make them throw, with the closest valid key: test runners don't type-check test files, so a camelCase `sortUnions` for `sort_unions` would otherwise do nothing and give no error.

`inferredType` and `inferredTypeInfo` (the full hover result: name, kind, return type, docs) use TypeScript 6 by default. Pass `backend: "typescript7"` for TypeScript 7 output. Every helper is synchronous on both backends, so there is no promise to forget to await. Types are untruncated by default, so a change deep inside an object or union fails the snapshot; pass `full: false` for the editor's shortened form (`{ ...; }`). `include_docs` adds JSDoc to `inferredTypeInfo`.

TypeScript 6 and TypeScript 7 print union members in different orders (`"idle" | "error"` on one, `"error" | "idle"` on the other), so a snapshot written on one backend fails on the other. Pass `sort_unions: true` to print every union, at any depth, in a fixed order that is the same on both: members sorted by their text, with `null` and `undefined` last.

```typescript
expect(
  inferredType(import.meta.url, { name: "status", sort_unions: true }),
).toMatchInlineSnapshot(`""error" | "idle" | "loading" | null"`);
```

The order is by UTF-16 code unit, so numbers compare as text (`1 | 10 | 2`). Only union members move. Property order can still differ: for `cond ? { ok: true, value: 1 } : { ok: false, error: "e" }`, TypeScript 6 prints `{ ok: false; error: string; value?: undefined; }` where TypeScript 7 prints `{ value?: undefined; ok: false; error: string; }`, and a mapped type over a union of keys lists its properties in each backend's union order. The option is off by default; the library's hover options and the CLI (`--sort-unions`) take it too.

To pin what a function infers for an argument you have no value for, declare the argument in a fixture file and point the helper at it. A `declare const` in the test file itself has no runtime value, so the test throws a `ReferenceError` as soon as it runs.

```typescript
// test/groupBy.fixture.ts, read for types only, never run
import { groupBy, type User } from "../src/users";
declare const input: User[];
export const byName = groupBy(input, (user) => user.name);

// test/users.test.ts
expect(inferredType(new URL("./groupBy.fixture.ts", import.meta.url), { name: "byName" }))
  .toMatchInlineSnapshot(`"Record<string, User[]>"`);
```

`inferredCompletions` uses TypeScript 7 and returns every completion name, with no prefix filter or limit, so a snapshot catches any added or removed entry. A `text` target puts the cursor right after the match, so `text: "user."` lists members and `text: '"'` lists string-literal union members; pass `cursor: "start"` to put it before the match instead.

TypeScript 7 runs in a worker thread, with one compiler process per project; each call blocks until the compiler answers. Neither keeps the test process alive, so no teardown is needed. `closeTestingSessions()` shuts them down early; it is safe to skip. If you call it, call it once per run, after the last test, not once per test file: the next TypeScript 7 call after it starts a new worker thread and compiler and loads the project again, which took about 190 ms on prinfer's own repository against 2 ms for a warm call, and takes longer on a larger project. It does not touch TypeScript 6, whose programs stay loaded. Under `bun test`, put `afterAll(closeTestingSessions)` in a file passed to `--preload` (`preload` in `bunfig.toml`): hooks there run once for the whole run. Under Vitest, leave it out: `setupFiles` run per test file, and `globalSetup` runs in a process that has no sessions. A test runner's own timeout cannot interrupt a blocked call, so prinfer has its own: a call that gets no answer within `timeout` milliseconds (default 60000, enough for a cold load of a large project) throws, and the next call starts a new compiler. A hung compiler fails one test instead of stalling the run. For a project that takes longer to load, raise it on the first call, or on all of them with a shared selector such as `const ts7 = { backend: "typescript7", timeout: 120_000 } as const`. If the compiler process exits, the call in flight retries once and later calls start a new one.

Failed lookups throw with the fix in the message: an unknown name lists the closest declarations in the file, missing text quotes the line, and a missing relative path explains how to resolve it against the test file.

`prinfer/vitest` remains as a deprecated alias for `prinfer/testing`.

### One call: text, cost, and readability

`expectType` checks a target's printed type, its cost, and its readability in one call, and throws one error that lists every check that failed:

```typescript
import { expectType } from "prinfer/testing";

test("toUser stays readable and cheap", () => {
  expectType(import.meta.url, {
    name: "user",
    printed: "{ id: string; name: string; }",
    maxInstantiations: 500,
    readable: true,
  });
});
```

```
expectType failed 3 checks for "user" at test/users.test.ts:9:14:
- printed: the type differs at character 1.
    expected: { id: string; name: string; }
    actual:   Omit<User, "email">
              ^
- maxInstantiations: 612 instantiations, over the budget of 500 by 112 (counted on TypeScript 6).
- readable: 1 readability issue:
    utility-type: Omit<User, "email"> is unresolved: TypeScript printed Omit<...> instead of the type it produces.
```

The selector is `inferredType`'s plus the checks, of which at least one is required:

- `printed`: the exact text `inferredType` returns for the same selector, so `backend`, `sort_unions`, and `full` apply.
- `maxInstantiations`, `maxTypes`: budgets for the [cost](#type-cost-budgets). The cost is always counted on TypeScript 6, also with `backend: "typescript7"`, which only picks where the text comes from; the error says so.
- `readable`: `true` for the default [readability rules](#readability-checks), or a rules object.

The error is a `TypeExpectationError` with every failure in `failures`. When the text differs it also carries `actual` and `expected`, so Vitest and Jest print their own diff. `expectType` only throws, so it works in any runner, and when every check passes it returns `{ printed, cost? }`. Like the other helpers it is synchronous on both backends, takes `strict`, and throws on a third argument.

### Readability checks

A type can be right and still print in a form a reader has to work out. `typeReadabilityIssues(text, rules?)` returns those places in printed type text, `inferredTypeIssues(file, selector)` in a target's printed type (an empty array means none), and `expectType`'s `readable` fails on them. The default rules:

- `utility-type`: an unresolved utility type with type arguments, anywhere in the type: `Omit`, `Pick`, `Partial`, `Required`, `Readonly`, `Exclude`, `Extract`, `NonNullable`, `ReturnType`, `Parameters`, `ConstructorParameters`, `InstanceType`, `Awaited`, `ThisParameterType`, `OmitThisParameter` (exported as `DEFAULT_UTILITY_TYPES`). The outermost one is reported for nested ones. One over a type parameter of the printed signature, such as `Omit<T, "id">` in `<T>(value: T) => Omit<T, "id">`, is not: nothing can resolve it before `T` is known. `Record`, `Promise`, `Array`, and other generic types are not flagged.
- `object-intersection`: an intersection with an object type, `User & { id: string; }` or a mapped type. `string & {}`, which keeps literal suggestions, is not flagged.
- `truncation`: `... 3 more ...`, `{ ...; }`, a `...` placeholder, and text cut at the length limit. The helpers print untruncated types unless `full: false`, so this mostly catches `full: false` and text from elsewhere.

The text is read with the TypeScript scanner and parser rather than matched as characters, so a string literal type like `"Omit<"` or `"..."` is not flagged, and neither is a rest parameter or a spread tuple. Each issue is `{ rule, text, offset, message }`, where `text` is the offending part as printed. Text that does not parse even with truncation markers taken out, such as text cut at the length limit, gets its truncation issues only.

Rules take `utilityTypes` (the names to flag, e.g. `[...DEFAULT_UTILITY_TYPES, "DeepPartial"]` for your own aliases, or `false`), `objectIntersections` and `truncation` (`false` turns them off), and `allow`, fragments that are fine as printed: an issue whose `text` is in it is not reported, for example a branded `string & { readonly __brand: "UserId"; }`.

```typescript
expect(
  inferredTypeIssues(import.meta.url, { name: "userId", rules: { allow: ['string & { readonly __brand: "UserId"; }'] } }),
).toEqual([]);
```

### Type cost budgets

`inferredTypeCost` counts the work TypeScript does for a type, so a test can stop an expensive type from getting more expensive:

```typescript
import { inferredTypeCost } from "prinfer/testing";

test("userSchema stays cheap to infer", () => {
  expect(inferredTypeCost(import.meta.url, { name: "userSchema" }).instantiations)
    .toBeLessThan(5_000);
});
```

It takes the same selector as `inferredType`, `strict` included, and like it throws on a third argument. It returns `{ instantiations, types }`: the type instantiations (what `tsc --extendedDiagnostics` reports as `Instantiations`) and the types that a fresh TypeScript 6 checker creates while it resolves the target and writes out its untruncated type. Each count gets a new checker, so no earlier lookup has done part of the work. The numbers are the same on every run, in every process, in any test order, and with any display option. Only the code, the compiler options, and the TypeScript version change them. They are counted by prinfer's bundled TypeScript 6 unless you pass `compiler: "project"` to count with your own `typescript` (see [Bundled or project compilers](#bundled-or-project-compilers)); pin that version in a project that budgets types. The returned object's non-enumerable `compiler` says which one counted. prinfer reports no wall-clock time: identical runs of the same lookup differ by several times.

The count covers what the target's type takes: for `const x = expr`, checking `expr`; for a function without a return type annotation, inferring the return type from its `return` statements. Code the type doesn't depend on is not counted, such as an initializer under an annotation (`const x: T = expr` takes its type from `T`). Target that expression with `{ line, text }` to count it.

To count several targets of one file, pass `names` for a record of costs by name, or `targets` (any selector shape, without options) for an array in order:

```typescript
const costs = inferredTypeCost(import.meta.url, { names: ["userSchema", "orderSchema"] });
expect(costs.userSchema.instantiations).toBeLessThan(5_000);

const [first, second] = inferredTypeCost(import.meta.url, {
  targets: [{ name: "userSchema" }, { line: 12, text: "parse(" }],
});
```

A batch counts exactly what single calls do: every count still gets a new checker. What is shared is the loading. In one process, a project's files are parsed once, and the programs for its other files reuse them, so counting in another file of the project costs little more than the counts themselves: 30 to 70 ms per further file instead of about 300 ms, on prinfer's own repository. A count is also kept while no file changes, so asking for the same target again is free. The count itself is the checker's work for that target and is never shared: a type that takes 80,000 instantiations takes about 250 ms to count. `bun test` runs every test file in one process, so the project loads once per run; with Vitest's default isolation, each test file loads it again.

TypeScript 7 exposes no instantiation counts, so costs are TypeScript 6 only: with `backend: "typescript7"`, `inferredTypeCost` and `include_cost` throw, and `expectType` counts on TypeScript 6 regardless. The other surfaces take `include_cost` (MCP, library) or `--cost` (CLI) and add the same numbers to the hover result as `cost`.

If you type-check with TypeScript 7, the TypeScript 6 counts are still a close guide. Measured with `--extendedDiagnostics` (TypeScript 7.0.2 with `--checkers 1`, TypeScript 6.0.3) on ten projects of one declaration each (recursive tuples, `DeepPartial`, a generic `pipe`, mapped and template literal types, a zod schema, `Object.fromEntries` chains), seven counted the same instantiations on both, two differed by 2% or less, and a recursive dotted-path type `Paths<T>` counted 17% more on TypeScript 7. Over prinfer's own source, TypeScript 7 counted 4% fewer instantiations and 4% more types. Ranked by cost, the declarations came out in the same order on both, except two within 15% of each other that swapped places. So a budget with 20% headroom over the TypeScript 6 count held for every case measured; expect a few percent of difference, more for recursive key and path types. Without `--checkers 1`, TypeScript 7 adds up the counts of its parallel checkers (1.7 times as many on prinfer's source), which can't be compared.

## Install

Pick your client. Every setup command below runs through `npx`, so nothing has to be installed first. If you install globally (`npm i -g prinfer`), drop the `npx -y` prefix and setup registers the `prinfer-mcp` binary, which skips npx's package check on every launch.

### Claude Code

Install the plugin. It bundles the MCP server and a skill that tells Claude when to use it:

```text
/plugin marketplace add clockblocker/prinfer
/plugin install prinfer@prinfer
```

Or register only the MCP server:

```bash
npx -y prinfer setup claude                   # user scope
npx -y prinfer setup claude --scope project   # shared .mcp.json for the repo
```

### Codex

```bash
npx -y prinfer setup codex
```

This runs `codex mcp add prinfer -- npx -y prinfer mcp`. The equivalent `~/.codex/config.toml` entry:

```toml
[mcp_servers.prinfer]
command = "npx"
args = ["-y", "prinfer", "mcp"]
```

### Cursor

```bash
npx -y prinfer setup cursor                   # ~/.cursor/mcp.json
npx -y prinfer setup cursor --scope project   # .cursor/mcp.json
```

### VS Code

```bash
npx -y prinfer setup vscode                   # runs code --add-mcp
npx -y prinfer setup vscode --scope project   # .vscode/mcp.json
```

### Gemini CLI

```bash
npx -y prinfer setup gemini                   # ~/.gemini/settings.json
npx -y prinfer setup gemini --scope project   # .gemini/settings.json
```

### Any other MCP client

prinfer is a stdio server. Point your client at `npx -y prinfer mcp`:

```json
{
  "mcpServers": {
    "prinfer": {
      "command": "npx",
      "args": ["-y", "prinfer", "mcp"]
    }
  }
}
```

prinfer is also listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.clockblocker/prinfer) as `io.github.clockblocker/prinfer`, and on [Smithery](https://smithery.ai/servers/clockblocker/prinfer) for clients that install from there.

### Setup options

- `--print` shows the command or config change without applying it.
- `--npx` registers `npx -y prinfer mcp` even when `prinfer-mcp` is installed. Use it when the client can't find `prinfer-mcp`; editors started outside a shell often miss nvm, fnm, or volta paths.
- Re-running setup updates the `prinfer` entry's command and leaves other servers alone. In JSON configs it keeps keys you added to the entry, such as `env`. JSON configs that don't parse are left untouched, and setup prints the entry for you to add by hand.
- On Windows, setup registers the server as `cmd /c npx -y prinfer mcp` (or `cmd /c prinfer-mcp`), because MCP clients launch it without a shell and can't run npm's `.cmd` shims directly.

## Tell the agent when to use it

MCP tool descriptions only go so far. Agents still reach for `tsc` or write annotations by hand. Add a short block to your instructions file:

```bash
npx -y prinfer setup agents-md                  # ./AGENTS.md
npx -y prinfer setup agents-md --file CLAUDE.md
```

The block sits between `<!-- prinfer:start -->` and `<!-- prinfer:end -->` markers. Re-running updates it in place. The Claude Code plugin ships the same guidance as a skill, so plugin users can skip this.

## Tools

Lines and columns are 1-based everywhere. `file` is absolute or relative to the server's working directory, and `project` (a `tsconfig.json` path) defaults to the nearest one above the file. Which TypeScript version answers depends on the tool and the surface; see [Backends at a glance](#backends-at-a-glance).

Hover text is capped at 4000 characters per type. A cut type ends with a line such as `… truncated: 187 chars total, union of 4 members. Pass max_chars: N to see more (0 for no limit).` `max_chars` raises the cap or, at `0`, removes it. `full: true` turns off TypeScript's own truncation (`{ ...; }`, `... 12 more ...`) and lists every overload. Structured content is never cut.

### hover_by_name

Start here when you know the symbol's name.

```text
hover_by_name(file: "src/utils.ts", name: "names")
hover_by_name(file: "src/utils.ts", name: "names", line: 11)   # line picks among same-named symbols
hover_by_name(file: "src/utils.ts", name: "format", include_docs: true)
```

```text
Type: string[]
Name: names
Kind: const
Position: 11:14
```

When the name is declared more than once, the lookup prefers declarations and says which one it picked:

```text
hover_by_name(file: "src/extras.ts", name: "item")
```

```text
Type: string
Name: item
Kind: const
Position: 8:9
Matched line 8 of 2 declarations (also 12); pass line to choose.
```

The structured result lists the others as `alternatives: [{ line, column, kind }]`. A `line` that matches none of them fails with `SYMBOL_NOT_FOUND`, a suggestion naming the declaration lines, and `declaredAt` holding their positions. Overloaded functions show the first signature, then the rest (up to three in the text; `full: true` lists all, and `overloads` in structured content always has every one):

```text
hover_by_name(file: "src/extras.ts", name: "parse")
```

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

Hover a token on a known line, for things `hover_by_name` can't name: callback parameters, expressions, repeated names. Pass `text` copied from the line and prinfer finds the column, so the agent doesn't have to count characters. `text` matches whole identifiers first: on `users.map((user) => user.name)`, `text: "user"` skips `users` and hits the callback parameter, and `occurrence: 2` picks the next `user`. Only when the line has no whole-identifier match is `text` matched as a plain substring. A `column` still works in place of `text`.

```text
hover(file: "src/utils.ts", line: 11, text: "user")
hover(file: "src/utils.ts", line: 11, column: 33)
```

```text
Type: { id: number; name: string; }
Name: user
Kind: parameter
Position: 11:33
Target: "user" at 11:33
```

Generic calls show their instantiated types, the same as an editor hover. If the text isn't on the line, the error quotes the line so the agent can correct itself:

```text
Error [SYMBOL_NOT_FOUND]: Text "nope" not found on line 11 of /project/src/utils.ts
Nearby identifiers: name, names, map, user, users
Suggestion: Line 11 reads: "export const names = users.map((user) => user.name);". Copy text exactly from it, or give a column instead.
```

### batch_hover

Up to 100 lookups in one call, across any number of files. Each item is `{name, line?}`, `{line, text, occurrence?}`, or `{line, column}`, with an optional `file` that overrides the shared top-level `file`. Each program or document loads once per file.

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
Name: users
Kind: const
Position: 6:14

--- src/utils.ts:11:33 text "user" ---
Type: { id: number; name: string; }
Name: user
Kind: parameter
Position: 11:33

--- src/missing.ts:1:1 ---
Error [FILE_NOT_FOUND]: File not found: /project/src/missing.ts
Suggestion: Check the path. Relative paths resolve against the MCP server's working directory (/project); pass an absolute path to be sure.
```

Failures stay per item, including a missing file, so one bad lookup doesn't throw away the rest. A line or column outside the file is an `INVALID_ARGUMENT` error that gives the valid range, for `hover` and `batch_hover` items alike.

### Hover results

Every hover returns the same fields on every backend and surface:

- `signature` is the type text alone, on one line, without the declaration keyword or name an editor hover starts with: `string[]` for a variable, `(value: string): number` for a function, the instantiated signature for a call. Type aliases keep their name and type parameters (`type Event = { kind: "open"; ... } | ...`), and interfaces and classes are their name (`Box<T>`). Optional parameters and properties read as `tsc` writes them in declarations: `digits?: number`, with `| undefined` only where the source wrote it or the type is not the annotation's (an instantiated generic, a `Partial<T>`).
- `display` is the editor's hover text (`const names: string[]`, object types over several lines). Only the TypeScript 7 language server reports it.
- `kind` is the editor's label: `function`, `method`, `const`, `let`, `var`, `parameter`, `property`, `type`, `interface`, `class`, `enum`, and so on, plus `call` for the callee of a call.
- `overloads`, `unionMembers` (members of a union type), and `alternatives` appear when they apply.
- `cost` is `{ instantiations, types }` when the call passes `include_cost: true`: the checker work the type takes, the same on every run (see [Type cost budgets](#type-cost-budgets)). It is counted on TypeScript 6, so a hover with `include_cost` and no `backend` runs there, and one with `backend: "typescript7"` fails with `INVALID_ARGUMENT`. The text adds `Cost: 195 instantiations, 212 types`.

### completions

The entries TypeScript offers at a cursor, including string-literal union members. The cursor sits before the character at `column`. For a string union, put it just inside the opening quote.

```text
completions(file: "src/utils.ts", line: 14, column: 30)
completions(file: "src/utils.ts", line: 20, column: 1, prefix: "use", limit: 20)
```

```text
coffee
tea
```

Entries come in TypeScript's ranking: locals, members, and literal values first, then globals, with keywords after other entries of the same rank, then auto-imports. At most `limit` entries are returned (default 50, up to 500). When more match, the text ends with a line such as `… 947 more; pass prefix to narrow, or raise limit`, and the structured result has `total` (all matches) and `truncated: true`.

`prefix` keeps names that start with it, ignoring case. Without `prefix`, the text already typed left of the cursor filters the list, as in an editor: with the cursor after `use` in `useSt`, only names starting with `use` come back, and inside `"co"` only literals starting with `co`. Pass `prefix: ""` to turn that off.

At a key of an object literal that accepts any key, such as a `Record<string, number>`, TypeScript would offer every global name. prinfer returns no entries and a `note` instead:

```text
No completion entries. Any key is accepted here; TypeScript knows no specific keys for this object literal.
```

`completions` always runs on TypeScript 6 and takes no `backend` argument.

### diagnostics

Type errors for one file, without type-checking the whole project. Run it on each file you edited; the edit is done when none reports an error.

```text
diagnostics(file: "src/utils.ts")
diagnostics(file: "src/utils.ts", include_suggestions: true)   # also unused variables etc.
```

```text
src/utils.ts:16:14 error TS2322: Type 'string' is not assignable to type 'number'.
1 error, 0 warnings.
```

A clean file returns `No type errors.`. Errors and warnings are reported by default. `include_suggestions` adds suggestion diagnostics such as TS6133 (declared but never read).

### annotations

Explicit type annotations in one file that TypeScript would infer anyway. Use it when cleaning up types, or to check a file before review.

```text
annotations(file: "src/utils.ts")
```

```text
src/utils.ts:2:55 redundant return type of format: declared string, inferred string (exported)
src/utils.ts:14:19 widening drink: declared Drink, inferred "tea" (exported)
src/utils.ts:21:19 redundant label: declared string, inferred string (exported)
src/utils.ts:22:18 widening mode: declared string, inferred "dark" (exported)
2 redundant, 2 widening (5 annotations checked).
redundant: delete the annotation; the type stays the same.
widening: the annotation is wider than the inferred type; keep it if the wider type is intended.
```

A `redundant` annotation can be deleted without changing the type. A `widening` one is wider than what TypeScript infers, which is often deliberate (a variable that must accept any `Drink` later, or an exported API contract), so treat it as a question rather than a fix. Only annotations with an initializer or body to infer from are checked. Each structured finding has the range of the `: Type` text to delete, `declared`, `inferred`, `exported`, and a one-line `suggestion`. `annotations` always runs on TypeScript 6.

## Backends and environment

### Backends at a glance

| Surface | Type lookups | Completions | Type errors | Annotations |
| :- | :- | :- | :- | :- |
| MCP server | TS7; `backend: "typescript6"` | TS6, top 50 | TS7; `backend: "typescript6"` | TS6 |
| CLI | TS6; `--backend typescript7` | TS6, top 50 | TS6; `--backend typescript7` | TS6 |
| Library (`prinfer`) | TS6 | TS6, all entries | TS6 | TS6 |
| `prinfer/testing` | TS6; `backend: "typescript7"`; both sync | TS7, every name, sync | none | none |

- `typescript7` runs the native TypeScript 7 language server (the testing helpers use its standalone compiler API). One warm session per project is shared across requests, and its output is closest to what your editor shows.
- `typescript6` uses the TypeScript 6 compiler API in-process. If a lookup fails or looks wrong on TypeScript 7, retry that call with `typescript6`.
- [Type costs](#type-cost-budgets) (`include_cost`, `--cost`, `inferredTypeCost`) are counted on TypeScript 6 on every surface.

### Bundled or project compilers

By default prinfer prints and counts with the TypeScript 6 and TypeScript 7 it depends on (`typescript` 6, and `@typescript/native`, an alias of `typescript` 7), so results are the same on every machine whatever the project installs. To get exactly what your own compiler infers (for snapshots and cost budgets that should move when you upgrade it, and only then), use the project's compilers instead:

| Mode | TypeScript 6 backend | TypeScript 7 backend |
| :- | :- | :- |
| `bundled` (default) | prinfer's `typescript` | prinfer's `@typescript/native` |
| `project` | the project's `typescript`, 5.0 to 6.x | the project's `typescript` 7 or `@typescript/native-preview` (7.0.0-dev.20260624.1 or later) |
| `auto` | the project's when supported, else bundled | the project's when supported, else bundled |

Set it with `compiler` in the library options and the `prinfer/testing` selectors (`{ name: "user", compiler: "project" }`), `--compiler` on the CLI, or `PRINFER_COMPILER` for every surface, including the MCP server. An explicit option wins over the variable. The project's packages are resolved the way Node resolves an import from the directory of the file's `tsconfig.json` (or of `project`); for TypeScript 7 the nearest of `typescript` 7 and `@typescript/native-preview` wins. prinfer then uses that package's own API client and compiler binary, so the two always speak the same protocol.

`project` throws a `TYPESCRIPT_ERROR` naming the package, version, and path when the project has none or an unsupported one: `typescript` before 5.0, a `typescript` 7 asked for TypeScript 6 output, or a `@typescript/native-preview` before 7.0.0-dev.20260624.1 (builds before 7.0.0-dev.20260515.1 ship no API client, and later ones up to 7.0.0-dev.20260623.1 open no project for a file). `auto` uses the bundled compiler instead, with one warning on stderr when the project's is unsupported. On TypeScript 5.0 to 5.8 some types and messages print differently from TypeScript 6; that is the point of the mode, but expect snapshot differences when you switch.

Every result says which compiler produced it, as `compiler: { name, version, source }` with `source` `"bundled"` or `"project"`. On library and testing results it is a non-enumerable property, so snapshots, `toEqual`, and `JSON.stringify` stay the same when only the compiler changes; read it directly (`inferredTypeInfo(...).compiler`, `inferredTypeCost(...).compiler`). The CLI's `--json` output and the MCP tools' structured content include it in `result`, and cost lines name it: `cost: 412 instantiations, 96 types (typescript 6.0.3, bundled)`.

One process runs one TypeScript 7 compiler at a time: a call that needs another one waits for the calls in flight, closes their sessions, and starts the other compiler.

The TypeScript 7 backend is experimental: TypeScript 7.0's programmatic API and hover format may still change. Both backends pick the same symbol for `hover_by_name`, report the position of its name token, and count lines the way TypeScript does (CR, LF, CRLF, U+2028, and U+2029 end a line; a leading BOM is ignored). Known differences:

- `signature` has the same shape on both (see [Hover results](#hover-results)). Only the language server reports `display`.
- On TypeScript 7, a `project` the language server wouldn't pick itself (it uses the tsconfig.json nearest the file, or a project that one references), such as an unreferenced `tsconfig.test.json`, is opened next to its own projects in the same session. Hovers and type errors in it come from the TypeScript 7 checker API, the way the testing helpers read types, so they carry no `display`. That tsconfig must include the file, through `include`, `files`, or an import; otherwise the call fails with `INVALID_ARGUMENT`. TypeScript 6 adds the file to any project, so use `typescript6` for it.
- On TypeScript 7, edits to files reached by relative imports are seen immediately. `diagnostics` also rescans the tsconfig's include directories (bounded, skipping `node_modules`, build output, and dot-directories); any other unopened edit reaches the language server through its file watcher shortly after.

Environment variables on the server process:

| Variable | Effect |
| :- | :- |
| `PRINFER_BACKEND=typescript6` | Default backend for `hover_by_name`, `hover`, `batch_hover`, and `diagnostics`. An explicit `backend` argument, or `include_cost`, still wins. |
| `PRINFER_COMPILER=project` | Use the project's own compilers instead of the bundled ones (`auto`: the project's when supported); see [Bundled or project compilers](#bundled-or-project-compilers). Also read by the CLI, the library, and `prinfer/testing`. |

`PRINFER_INCLUDE_TIMING` is no longer read; pass `include_cost` for [type costs](#type-cost-budgets) instead.

## Error contract

Every tool returns readable text plus versioned structured content. Successes are `{ version: 1, ok: true, result }`. A failure's text gives the code, the message, and the recovery hints, because many MCP clients show the model only the text:

```text
Error [SYMBOL_NOT_FOUND]: No symbol named "nmes" at line 11 found in src/utils.ts
Did you mean: names, name?
Suggestion: Check the spelling against candidates, pass line to pick the match on a known line, or call hover with that line and text copied from it.
```

Its structured content looks like this:

```json
{
  "version": 1,
  "ok": false,
  "error": {
    "code": "SYMBOL_NOT_FOUND",
    "message": "No symbol named \"nmes\" at line 11 found in src/utils.ts",
    "file": "/project/src/utils.ts",
    "line": 11,
    "project": "/project/tsconfig.json",
    "candidates": ["names", "name"],
    "suggestion": "Check the spelling against candidates, pass line to pick the match on a known line, or call hover with that line and text copied from it."
  }
}
```

The error codes are `INVALID_ARGUMENT`, `FILE_NOT_FOUND`, `SYMBOL_NOT_FOUND`, `TYPESCRIPT_ERROR`, and `INTERNAL_ERROR`. For `SYMBOL_NOT_FOUND`, `candidates` lists identifiers from the file that are close to the requested name (keywords and words in comments or strings are skipped), or the identifiers near the requested line; the text shows them as `Did you mean: …?` for a name lookup and `Nearby identifiers: …` otherwise. When a name lookup's `line` misses, `declaredAt` lists where the name is declared. `suggestion` is specific to the tool or CLI command that failed. The CLI's `--json` output and the exported zod schemas (`hoverSuccessSchema`, `diagnosticsSuccessSchema`, `contractErrorResponseSchema`, and the rest) use the same contract.

Each tool's `outputSchema` describes both outcomes in one envelope (`version`, `ok`, and `result` or `error`), because MCP clients may validate error results against it too. It lists the error fields an agent recovers with (`code`, `message`, `candidates`, `suggestion`); the others are still sent.

## CLI

The CLI uses TypeScript 6 by default. Pass `--backend typescript7` to look up types or run `check` on the TypeScript 7 language server instead; `complete` and `annotations` always use TypeScript 6.

```bash
# Type by name, optionally with a line hint for repeated names
prinfer src/utils.ts:format
prinfer src/utils.ts:names:11
prinfer 'src/store.ts:$store'          # any JavaScript identifier, including $ and non-ASCII names

# Type of a token on a line: text copied from the line, or a column
prinfer src/utils.ts:11:user
prinfer src/utils.ts:11 --text user --occurrence 2
prinfer src/utils.ts:11:33

prinfer src/utils.ts:format --docs      # include JSDoc
prinfer src/utils.ts:largeType --full   # turn off TypeScript's own truncation
prinfer src/utils.ts:status --sort-unions  # union members in a fixed order, the same on both backends
prinfer src/utils.ts:largeType --max-chars 0   # print the whole type (default cap: 4000 chars)
prinfer src/utils.ts:format --cost      # type instantiations, the same every run (TS6)
prinfer src/utils.ts:format -p ./tsconfig.json
prinfer src/utils.ts:format --compiler project  # the project's own typescript, not prinfer's

# Completions at a cursor: the top 50, filtered by the text typed left of the cursor
prinfer complete src/utils.ts:14:30
prinfer complete src/utils.ts:11:user.  # cursor right after the text: members of user
prinfer complete src/utils.ts:20:1 --prefix use --limit 20

# Type errors in one file
prinfer check src/utils.ts
prinfer check src/utils.ts --suggestions

# Annotations TypeScript would infer anyway
prinfer annotations src/utils.ts
```

```text
$ prinfer src/utils.ts:format --docs
(value: number, digits?: number): string
returns: string
name: format
kind: function
docs: Formats a number with a fixed number of digits.

$ prinfer src/utils.ts:11:user
{ id: number; name: string; }
name: user
kind: parameter
target: "user" at 11:33

$ prinfer check src/utils.ts
src/utils.ts:16:14 error TS2322: Type 'string' is not assignable to type 'number'.
1 error, 0 warnings.
```

In `<file>:<line>:<text>`, everything after the line is the text, colons and dots included; whole identifiers match first, as in the `hover` tool. All-digit text reads as a column, so pass it with `--text`. A name with a line hint on a line that uses the name, such as `prinfer src/box.ts:value:4` where line 4 reads `box.value.toUpperCase()`, gives the type there, narrowed by the code around it.

Value options take `--opt value` or `--opt=value`. An unknown option, or one the command doesn't take, is an error. Single-quote any argument with a `$`: shells expand `$store`, and zsh reads `$F:r` in `"$F:root"` as a modifier.

Failures print the error, `Did you mean: …?` candidates, and a suggestion on stderr, and exit 1.

`prinfer annotations` exits 0 whatever it finds, and 1 only when the check itself fails.

`prinfer check` exits 0 when the file has no type errors (warnings and suggestions don't count) and 1 when it has errors, so scripts and agents can branch on the exit code alone.

### JSON output

`--json` prints the versioned contract on stdout and nothing on stderr. Type lookups, `complete`, `check`, and `annotations` all support it, and it is never capped:

```bash
$ prinfer src/utils.ts:names --json
{"version":1,"ok":true,"result":{"signature":"string[]","line":11,"column":14,"kind":"const","name":"names"}}

$ prinfer check src/utils.ts --json
{"version":1,"ok":true,"result":{"file":"/project/src/utils.ts","diagnostics":[{"line":16,"column":14,"endLine":16,"endColumn":19,"code":2322,"category":"error","message":"Type 'string' is not assignable to type 'number'.","source":"ts"}],"errorCount":1,"warningCount":0}}
```

Failures print `{"version":1,"ok":false,"error":{...}}`, with the same `project` and `candidates` fields as the MCP server, and exit 1. `check` also exits 1 when it succeeds but finds errors; check `ok` to tell a failed run from a file with type errors.

### Other commands

- `prinfer mcp` starts the MCP server on stdio, the same as the `prinfer-mcp` binary. `npx -y prinfer mcp` works without a global install.
- `prinfer setup <codex|claude|cursor|vscode|gemini> [--scope <scope>] [--npx] [--print]` registers the server with a client (see [Install](#install)).
- `prinfer setup agents-md [--file <path>] [--print]` adds the usage block to an instructions file.

Run `prinfer --help` or `prinfer setup --help` for the full option list.

## Programmatic API

The library API is synchronous and uses the TypeScript 6 backend.

```typescript
import { annotations, batchHover, completions, diagnostics, hover } from "prinfer";

// By symbol name
hover("./src/utils.ts", "format");
// => { signature: "(value: number, digits?: number): string", returnType: "string",
//      line: 2, column: 17, kind: "function", name: "format" }

// By name with a line hint, for repeated names
hover("./src/utils.ts", "names", { line: 11 });

// By position (line, column)
hover("./src/utils.ts", 11, 33);
// => { signature: "{ id: number; name: string; }", line: 11, column: 33, kind: "parameter", name: "user", ... }

// Options: include_docs, full (no truncation), sort_unions, include_cost, project
hover("./src/utils.ts", "format", { include_docs: true }).documentation;
// => "Formats a number with a fixed number of digits."
hover("./src/utils.ts", "names", { include_cost: true }).cost;
// => { instantiations, types }, the same on every run; see Type cost budgets

// Several positions in one file, one program load
const batch = batchHover("./src/utils.ts", [
  { line: 11, column: 14 },
  { line: 11, column: 33 },
]);
// => { items: [...], successCount: 2, errorCount: 0 }

// Completions at a cursor, ranked; every entry unless you pass limit, unfiltered unless you pass prefix
completions("./src/utils.ts", 14, 30).entries.map((entry) => entry.name);
// => ["coffee", "tea"]
completions("./src/utils.ts", 20, 1, { prefix: "use", limit: 20 });
// => { entries: [{ name: "useConfig", ... }, ...], total: 4, truncated: false, prefix: "use", ... }

// Type errors for one file
const result = diagnostics("./src/utils.ts", { include_suggestions: false });
// => { file: "/project/src/utils.ts", errorCount: 1, warningCount: 0,
//      diagnostics: [{ line: 16, column: 14, endLine: 16, endColumn: 19, code: 2322,
//                      category: "error", message: "Type 'string' is not assignable to type 'number'.", source: "ts" }] }

// Redundant and widening annotations in one file
annotations("./src/utils.ts").findings.map((finding) => `${finding.kind} ${finding.name}`);
// => ["redundant format", "widening drink", "redundant label", "widening mode"]
```

Unlike the MCP server, the library throws on failure (`batchHover` reports bad positions per item and throws only when the file can't be loaded). Pass a caught error to `contractError(error)` to get the contract shape.

## Requirements

- Node.js >= 20.0.0

prinfer bundles its own TypeScript 6 and TypeScript 7 as internal dependencies, so your project's `typescript` version doesn't matter and doesn't need aliasing or downgrading. To use your project's compilers instead, see [Bundled or project compilers](#bundled-or-project-compilers). The TypeScript 7 package is loaded only when a TypeScript 7 call needs it.

## Development

```bash
bun install
bun run ci    # typecheck, build, biome check, tests
```

The repository type-checks with TypeScript 7 (`bun run typecheck`). The TypeScript 6 package also does declaration bundling. [Backends at a glance](#backends-at-a-glance) lists which surface uses which compiler.

Releases go through changesets (`bun run changeset`). `bun run version` also copies the version into `server.json` and the Claude Code plugin manifest.

## License

MIT
