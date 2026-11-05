---
"@thomasfosterau/effect-parse": patch
---

`Parser.parsePartial` returns a compiled parser's `Incomplete` without re-running the parser interpreted: compiled code now records the interpreter's `Incomplete` failure (`needed` included) where it reports it itself, at `eof` and at the end of an `escaped` text. Results are unchanged; a whole document parsed as partial input (ending in whitespace, say) no longer parses twice: 5× faster on a 2.4 MB JSON document.

`ParserStream.parseMany` likewise no longer parses a value cut short by its chunk a second time, interpreted; only a value that fails is.
