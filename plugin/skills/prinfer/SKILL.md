---
name: prinfer
description: TypeScript inferred types, completions and type errors from the real compiler. Use when writing, refactoring or debugging TypeScript and you are about to add a type annotation, are unsure what a variable, generic or call infers, need the valid values at a cursor, or want to check a file for type errors after editing.
---

# prinfer

The compiler knows the type; look it up instead of guessing. When the inferred type is what you would have annotated, leave the annotation out.

## Pick the tool

| You want | Call |
| :- | :- |
| Type of a named symbol | `hover_by_name(file, name)`; add `line` when the name repeats |
| Type of an expression or call site | `hover(file, line, text)`; add `occurrence` for the nth match on that line |
| Several types, any files | one `batch_hover` call |
| Valid values at a cursor (union members, keys, methods) | `completions(file, line, column)` |
| Type errors after an edit | `diagnostics(file)` |

An edit is done when `diagnostics` reports no errors for every file you changed.

All tools accept `project` (path to a `tsconfig.json`) for files outside the nearest project.

## Positions

Lines and columns are 1-based. For `hover`, pass `text`: the token exactly as it appears on the line, such as `useQuery` or `config`. Prinfer finds the column, so you never count characters.

`completions` needs a column: the cursor sits before the character at that column. For a string-literal union, put it just inside the opening quote.

## Backend

The default backend is `typescript7`, the native compiler. If a call fails or its type looks wrong, retry that call with `backend: "typescript6"`.

## Without MCP

When the prinfer tools are not connected, run the CLI. Output is a JSON object with `ok` plus `result` or `error`:

```bash
npx prinfer src/file.ts:symbolName --json
npx prinfer src/file.ts:symbolName:75 --json   # line hint for repeated names
npx prinfer complete src/file.ts:80:24 --json  # file:line:column
npx prinfer check src/file.ts --json           # type errors; exits 1 when there are any
```
