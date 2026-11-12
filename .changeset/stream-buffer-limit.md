---
"@thomasfosterau/effect-parse": minor
---

The stream runners bound what they buffer, and `ParserStream.parseMany` no longer re-parses an unfinished value on every chunk (#116).

- `maxBufferSize` (tokens: UTF-16 code units, bytes or array elements) is a new option of `parseMany`, `parseAll`, `parseReadable` and `parseResponse`, defaulting to 64 MiB (`ParserStream.defaultMaxBufferSize`); `Infinity` turns it off. `parseMany` counts the input it has not consumed yet (one unfinished value); the other three count the whole input. `parseResponse` also fails before reading the body when `Content-Length` is over the limit.
- Exceeding the limit fails with the new `ParserStream.BufferLimitError` (`limit`, `size`), not a `ParseError`. **Breaking:** it joins the error type of the four runners, so code that treats their error as a `ParseError` has to narrow it first (`Effect.catchTag("BufferLimitError", …)` or `error._tag === "ParseError"`), and a stream over 64 MiB that used to parse now fails unless it passes a larger `maxBufferSize`.
- `parseReadable` and `parseResponse` take an options argument (`ParserStream.BufferOptions`).
- `parseMany` was quadratic in the size of a value that had not completed: it copied the buffer and parsed the value again from its start on every chunk (4 MiB with no delimiter in 1 KiB chunks: 40 s). Its byte buffer now grows geometrically, and a value over 64 KiB is retried only once the buffer has grown by an eighth. **Behaviour change:** the chunk that completes a value larger than 64 KiB may not emit it until more input arrives or the stream ends; smaller values are emitted as soon as they complete, as before.
