---
"@thomasfosterau/effect-parse": minor
---

Add an `offset` option to every `Parser` runner (`parse`, `parseSync`, `parsePeek`, `parsePartial`, `parseEffect`, `parseRecoverable`), so an incremental driver such as a lexer can parse one token at a time from a buffer without slicing it. The result is that of parsing `input.slice(offset)`, with offsets (`Done`'s `offset`, spans, `ParseError` offsets, lines and columns) counted in the whole input. `parsePartial` now runs compiled parsers compiled, re-running the interpreter only to report `Incomplete` or an error, so a lexer loop over `parsePartial` runs compiled code from any offset (#19).
