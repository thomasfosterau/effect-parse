---
"@thomasfosterau/effect-parse": patch
---

Streaming parses with a JIT-compiled parser run escapes (`escaped`, `takeEscaped`) as generated code that keeps checkpoints, instead of calling the closure compiler's: about 13% faster on a JSON document, within 5% of an ordinary compiled parse.
