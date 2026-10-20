---
"@thomasfosterau/effect-parse": minor
---

Deeply nested input no longer makes the runners throw `RangeError: Maximum call stack size exceeded`. When a recursive grammar (`Parser.suspend`) exhausts the call stack, interpreted or compiled, `parse`, `parsePeek`, `parsePartial`, `parseEffect`, `parseRecoverable`, `ParserStream.parseMany`, `ParserStream.parseAll` and `Syntax.parse` now fail with an unrecoverable `ParseError` of the new kind `"TooDeep"` at the offset reached, so untrusted input can't crash the caller. `Parser.tryMapUnknown` no longer catches the overflow as a user error (#14).
