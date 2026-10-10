---
"prinfer": patch
---

A file rewritten with the same size within one timestamp tick of being read is no longer served from a stale cached program. Timestamps are coarse on some systems (a clock tick on Linux without multigrain timestamps, a second on HFS+), so a test that wrote a fixture, looked up a type, and rewrote the fixture milliseconds later could get the old type. Files changed in the last 3 seconds are now also compared by content.
