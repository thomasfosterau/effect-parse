---
"@thomasfosterau/effect-parse": patch
---

Compiled streaming parses (`Parser.parsePartial`, `ParserStream.parseAll` and `parseMany`) build `Parser.fromEntries` objects directly, as ordinary compiled parses do, rather than building the array of pairs first: about 1.5× faster on a JSON document with the JIT.
