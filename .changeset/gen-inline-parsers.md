---
"@thomasfosterau/effect-parse": patch
---

Make parsers cheaper to build, for those written inside a `Parser.gen` body, which are rebuilt on every run. Compiled token sets given as strings (`Token.oneOf("+-")`, `Token.takeWhile(" \t")`, ...) and the descriptions of string literals are now cached by value, so building `Token.oneOf("+-")` takes about 30 ns instead of 4 µs, and `Token.literal(",")` about 30 ns instead of 90 ns. Results and error messages are unchanged. The `Parser.gen` docs now show how to hoist parsers out of the body on hot paths.
