---
"@thomasfosterau/effect-parse": minor
---

Add `Parser.failAt(offset, error)`, a parser that fails with a user error reported at a chosen offset. A check that can only run once a construct has parsed (`tryMap`, `filterOrFail`) can only fail where the construct started; returned from a `flatMap` continuation, `failAt` points the error at the part at fault instead, such as a mismatched end tag. Interpreted and compiled parsers report the same position (#73).
