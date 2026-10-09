---
"prinfer": patch
---

`prinfer/testing`: TypeScript 7 sessions no longer depend silently on a private `@typescript/native` field to let the test process exit. If a future release moves the compiler process so prinfer can't unref it, prinfer prints a one-time warning to stderr naming `closeTestingSessions()` as the fix, then closes each session after 1s idle so the process still exits. The next call restarts the compiler.
