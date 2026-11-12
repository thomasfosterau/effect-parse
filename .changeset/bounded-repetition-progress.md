---
"@thomasfosterau/effect-parse": minor
---

Every repetition checks progress, not only an unbounded one (#115). `repeat`, `fold`, `separated`, `repeatTill` (and `Nom.count`, `Nom.manyMN`, `Binary.lengthRepeat`, which are built on them) now fail with an unrecoverable `Assert` failure when an element succeeds without consuming input, whatever the range, in the interpreter and in all three compilers. Before, a bounded repetition of such an element ran to its bound, and in `Binary.lengthRepeat` the bound comes from the input: three bytes made `lengthRepeat(beU24, succeed(0))` build an array of 16.7 M elements, and four bytes made `lengthRepeat(beU32, …)` throw a `RangeError` out of `Parser.parse`. A repetition now never runs more iterations than the input has tokens.

**Breaking:** `Parser.repeat(Parser.opt(x), 3)` and other bounded repetitions of a parser that can match empty are an error where the element matches nothing. Make the element consume (`repeat(x, { max: 3 })`), or write the optional parts out (`seq(opt(x), opt(x), opt(x))`).
