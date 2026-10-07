---
name: prinfer
description: TypeScript inferred types, completions and type errors from the real compiler. Use when writing, refactoring or debugging TypeScript and you are about to add a type annotation, are unsure what a variable, generic or call infers, need the valid values at a cursor, want to check a file for type errors after editing, or are writing type tests that lock what an API infers.
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

An edit is done when `diagnostics` reports no errors for every file you changed.

All tools accept `project`, a `tsconfig.json` path that defaults to the nearest one above the file. On `typescript7` only that tsconfig or a project it references works; for any other, also pass `backend: "typescript6"`.

## Positions

Lines and columns are 1-based. For `hover` and `batch_hover` items, pass `text`: the token exactly as it appears on the line, such as `useQuery` or `config`. prinfer finds the column, so you never count characters.

`completions` needs a column: the cursor sits before the character at that column. For a string-literal union, put it just inside the opening quote. It returns the top 50 entries (`limit` raises that, up to 500), filtered by the text already typed left of the cursor; `prefix` filters by other text, and `prefix: ""` lists everything.

Errors say what to do next: read the `Did you mean:` and `Suggestion:` lines and retry with them.

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
- Unlike `expectTypeOf` or `tsd`, there is no hand-written expected type: the snapshot is the type as the editor displays it, so any change fails.
- Another module: `new URL("../src/users.ts", import.meta.url)` as the file. Targets: `{ name }`, `{ line, text }`, `{ line, column }`.
- `inferredType` is synchronous on TypeScript 6; `backend: "typescript7"` returns a promise.
- `await expect(inferredCompletions(file, { line, text })).resolves.toMatchInlineSnapshot()` pins completion names (TypeScript 7, cursor right after `text`).

## Backend

The MCP tools default to `typescript7`, the native compiler. If a call fails or its type looks wrong, retry that call with `backend: "typescript6"`. `completions` always runs on TypeScript 6.

## Without MCP

When the prinfer tools are not connected, run the CLI. It defaults to TypeScript 6 (`--backend typescript7` switches lookups and `check`). Output is a JSON object with `ok` plus `result` or `error`:

```bash
npx prinfer src/file.ts:symbolName --json
npx prinfer src/file.ts:symbolName:75 --json   # line hint for repeated names
npx prinfer complete src/file.ts:80:24 --json  # file:line:column; --prefix, --limit
npx prinfer check src/file.ts --json           # type errors; exits 1 when there are any
```
