---
"prinfer": patch
---

A file rewritten within one timestamp tick of being read, with the same size, is no longer served from a stale cached program. Timestamps are coarse on some systems (a clock tick on Linux kernels without multigrain timestamps, a second on HFS+), so a test that wrote a fixture, looked a type up, and rewrote it a few milliseconds later could still get the old type. A file changed within the last 3 seconds is now also compared by content until that window has passed; older files are still checked by their stat alone.
