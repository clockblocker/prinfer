---
"prinfer": patch
---

`prinfer/testing`: if a TypeScript 7 compiler process exits mid-run, prinfer now starts a new one. `bun test` kills every child process when any test times out, and that includes the shared compiler. Before this fix, every later TypeScript 7 call in the run hung or failed with "snapshot 1 not found", and `closeTestingSessions()` hung in `afterAll`. A call that was in flight when the process exited, or that fails while the process shuts down, now retries once with a fresh compiler. Teardown no longer waits on a dead process.
