---
"@thomasfosterau/effect-parse": minor
---

A `ParseError` no longer serialises the input it was parsing, and its message is bounded (#117).

- `error.input` and `error.encoding` are still readable (and `position`, `message` and `ParseError.lineColumn` work as before), but they are now accessors over private fields rather than own properties, and `toJSON` leaves them out. `JSON.stringify(error)`, object spread, `Object.keys`, Node's `inspect`, Effect's `Cause` rendering and loggers that walk an error's own properties therefore no longer write out everything that was being parsed (a failed parse of a 1 MB `Uint8Array` used to serialise as 12.9 MB of JSON). **Breaking** for code that read `input` from a serialised or spread error (read `error.input` from the error itself); `input` is also no longer among the properties that `Equal.equals` and `Hash.hash` walk (they still compare an error's other own properties, its stack trace included). `toJSON` now returns a `ParseError.ParseErrorJson`: `_tag`, `offset`, `position`, `kind`, `mode`, `expected`, `context`, `cause`, `description` and `message`.
- `message` shows at most 60 characters on each side of the failure, marking what it leaves out with `…`, instead of the whole line: a failure at the end of a 5 MB line with no newline produced a 10 MB message, rebuilt on every access. Lines shorter than the window render exactly as before. Encoded byte input (`Text.utf8`, …) is bounded the same way, and a surrogate pair is never split at the window's edge.
