---
"@thomasfosterau/effect-parse": patch
---

Compiled `alt`s now dispatch on the first characters of a branch that starts with `not(p)`: the lookahead consumes nothing, so the branch can only start with `p`'s first characters or with those of what follows it, and is skipped on any other input without running the lookahead.
