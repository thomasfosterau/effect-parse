---
"@thomasfosterau/effect-parse": patch
---

Interpreted parses merge expected-token lists through a small cache of recent merges instead of allocating a new list each time a hint meets a failure: 2–13% faster on the JSON benchmarks.
