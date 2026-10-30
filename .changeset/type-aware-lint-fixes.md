---
"@thomasfosterau/effect-parse": patch
---

Fixes from type-aware linting. `Parser` now declares the `toString()` it already had (`Parser(<name>)`), and `tryMapUnknown` spells its error type `unknown` rather than the equivalent `E | unknown`. An unexpected token that `JSON.stringify` cannot render (a cycle, a `BigInt`) is now shown as its elements joined (arrays) or its object tag such as `[object Map]`, without calling a user `toString`.
