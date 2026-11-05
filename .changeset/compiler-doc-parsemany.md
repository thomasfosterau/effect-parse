---
"@thomasfosterau/effect-parse": patch
---

The `Compiler` module's doc comment no longer says that `ParserStream.parseMany` is always interpreted: it runs a compiled parser's resumable build, and parses a value again, interpreted, only when it fails or needs more input (#76).
