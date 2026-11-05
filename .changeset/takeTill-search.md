---
"@thomasfosterau/effect-parse": patch
---

Compiled `Token.takeTill` of one to three characters, on string input, finds the end of its run with `indexOf` once the run is longer than a few characters, with a per-state cache of where each stop character next occurs. On CSV-shaped input, runs of 64 characters parse about 3× as fast and runs of 256 characters up to 9× (JIT) and 14× (closure compiler); short runs are unchanged or faster. Results are unchanged (#75).
