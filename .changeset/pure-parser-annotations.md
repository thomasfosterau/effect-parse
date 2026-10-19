---
"@thomasfosterau/effect-parse": patch
---

Mark every parser, predicate and table built at module load `/*#__PURE__*/`, so bundlers drop the ones a program doesn't use. Importing `Ascii.decInt` alone now bundles about 7 KB of effect-parse instead of 24 KB.
