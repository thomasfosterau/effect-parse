---
"@thomasfosterau/effect-parse": patch
---

Mark every parser, predicate and table built at module load `/*#__PURE__*/`, so bundlers drop the ones a program doesn't use. Importing only `decInt` from `@thomasfosterau/effect-parse/Ascii` now bundles about 7 KB of effect-parse instead of 24 KB.
