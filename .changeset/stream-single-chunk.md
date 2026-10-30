---
"@thomasfosterau/effect-parse": patch
---

`ParserStream.parseAll` (and `parseReadable` / `parseResponse`) parse an input that arrives in a single chunk, such as most small response bodies, once instead of twice: the first partial attempt waits for a second chunk, and a stream that ends first is parsed as an ordinary compiled parse. On a 2 MB JSON document in one chunk this takes 60 ms instead of 147 ms.
