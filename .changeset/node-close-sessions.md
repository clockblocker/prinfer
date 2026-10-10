---
"prinfer": patch
---

`prinfer/testing`: on Node, a script that ran a TypeScript 7 lookup and then called `await closeTestingSessions()` at top level now exits normally. Before this fix the await never settled and Node exited with code 13 ("unsettled top-level await"). prinfer unrefs the idle compiler process so it can't keep your process alive, and that stayed in effect while `closeTestingSessions()` waited for the compiler to answer, so Node's event loop emptied out before the reply came. The compiler is now held only while it shuts down. Idle sessions still don't keep the process alive, and calling `closeTestingSessions()` is still optional.
