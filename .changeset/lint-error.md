---
"@thomasfosterau/effect-parse": patch
---

Internal type cleanups from bringing every Effect lint rule to `error`: casts replaced by generics and narrowing, and the remaining type assertions documented. No behaviour changes; the emitted `.d.ts` prints `Nom.lineEnding`'s union in a different order (#68).
