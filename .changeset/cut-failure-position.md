---
"@thomasfosterau/effect-parse": patch
---

Report a committed (`cut`) failure where it happened. The furthest-failure heuristic no longer replaces it with a deeper failure from a branch or lookahead tried before the commit; failures inside the `cut` parser itself still count. Failures inside a lookahead that succeeded (`peek`, or the parser given to `not`) are no longer reported as the furthest failure either. Ordinary backtracking (`alt`, `opt`, `separated`, ...) reports the same errors as before.
