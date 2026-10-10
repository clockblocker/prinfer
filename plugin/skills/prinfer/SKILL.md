---
name: prinfer
description: TypeScript inferred types, completions and type errors from the real compiler. Use when writing, refactoring or debugging TypeScript and you are about to add a type annotation, are unsure what a variable, generic or call infers, need the valid values at a cursor, want to check a file for type errors after editing, are cleaning up redundant annotations, or are writing type tests that lock what an API infers.
---

# prinfer

The compiler knows the type; look it up instead of guessing. When the inferred type is what you would have annotated, leave the annotation out.

## Pick the tool

| You want | Call |
| :- | :- |
| Type of a named symbol | `hover_by_name(file, name)`; add `line` when the name repeats |
| Type of a token without a unique name (callback parameter, expression, call site) | `hover(file, line, text)`; add `occurrence` for the nth match on that line |
| Several types, any files | one `batch_hover` call |
| Valid values at a cursor (union members, keys, methods) | `completions(file, line, column)`; add `prefix` to narrow |
| Type errors after an edit | `diagnostics(file)` |
| Annotations TypeScript would infer anyway | `annotations(file)`: `redundant` ones can go; `widening` ones are often a deliberate contract |

An edit is done when `diagnostics` reports no errors for every file you changed.

All tools accept `project`, a `tsconfig.json` path that defaults to the nearest one above the file. On `typescript7` that tsconfig must include the file; for one that doesn't, also pass `backend: "typescript6"`.

## Positions

Lines and columns are 1-based. For `hover` and `batch_hover` items, pass `text`: the token exactly as it appears on the line, such as `useQuery` or `config`. prinfer finds the column, so you never count characters.

`hover_by_name` with a `line` where the name is used rather than declared, such as `name: "value", line: 185` on `if (box.value) ...`, gives the type at that spot, narrowed by the code around it.

`completions` needs a column: the cursor sits before the character at that column. For a string-literal union, put it just inside the opening quote. The MCP tool returns the top 50 entries (`limit` raises that, up to 500), filtered by the text already typed left of the cursor; `prefix` filters by other text, and `prefix: ""` lists everything. At an object-literal key that takes any key (`Record<string, T>`) it returns no entries and a `note` saying so.

## Reading results

- Type text is cut at 4000 characters, with a trailer giving the full length and union size. Pass `max_chars` (`0` for no cap) to see more; structured content is never cut. `full: true` also turns off TypeScript's own `{ ...; }` truncation.
- `Matched line 8 of 3 declarations (also 12, 20)` means the name is ambiguous; pass `line` to pick another.
- Errors say what to do next: read the `Did you mean:` and `Suggestion:` lines and retry with them.

## Lock inferred types in tests

When inferred types must not drift (public API inference, a refactor that should keep types, a request for type tests), snapshot them with `prinfer/testing` (dev dependency `prinfer`):

```ts
import { expect, test } from "vitest"; // or "bun:test"
import { inferredType } from "prinfer/testing";

test("groupBy keys by the callback's return type", () => {
  expect(inferredType(import.meta.url, { name: "byRole" })).toMatchInlineSnapshot();
});
```

- Leave the matcher empty; the runner writes the type. After an intended change, rerun with the runner's snapshot update (`vitest -u`, `bun test --update-snapshots`).
- Snapshots hold the whole type, untruncated, so any change inside it fails. `full: false` gives the editor's shortened `{ ...; }` form.
- Another module: `new URL("../src/users.ts", import.meta.url)` as the file. Targets: `{ name }`, `{ line, text }`, `{ line, column }`.
- To probe a type you have no value for, put `declare const input: User[]` and the expression in a separate fixture file and pass `new URL("./probe.fixture.ts", import.meta.url)`. In the test file itself, a `declare const` has no runtime value and the test throws a `ReferenceError`.
- `inferredType` is synchronous on both backends: TypeScript 6 by default, TypeScript 7 with `backend: "typescript7"`.
- `expect(inferredCompletions(file, { line, text })).toMatchInlineSnapshot()` pins every completion name (TypeScript 7, no limit, cursor right after `text`).

## Backend

The MCP hover tools and `diagnostics` default to `typescript7`, the native compiler. If a call fails or its type looks wrong, retry that call with `backend: "typescript6"`. MCP `completions` and `annotations` always run on TypeScript 6.

## Without MCP

When the prinfer tools are not connected, run the CLI. It defaults to TypeScript 6 (`--backend typescript7` switches lookups and `check`). Output is a JSON object with `ok` plus `result` or `error`:

```bash
npx prinfer src/file.ts:symbolName --json
npx prinfer src/file.ts:symbolName:75 --json   # line hint; on a line that uses the name, the narrowed type there
npx prinfer src/file.ts:75:user --json         # text copied from line 75
npx prinfer complete src/file.ts:80:user. --json  # cursor after the text, or file:line:column; --prefix, --limit
npx prinfer check src/file.ts --json           # type errors; exits 1 when there are any
npx prinfer annotations src/file.ts --json     # redundant and widening annotations
```

Single-quote any argument containing `$`, as in `'src/store.ts:$store'`. Unquoted, the shell expands `$store`; even in double quotes, zsh rewrites `"$F:root"` as `${F:r}oot`.
