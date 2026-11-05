---
"@thomasfosterau/effect-parse": patch
---

The JIT compiles a repetition of a character set whose values are unused (under `taken`, `asVoid`, `peek` or a dropped element) as one scan of the run: `repeat(oneOf(S))` as `takeWhile(S)`, and `repeat(alt(oneOf(S), ...rest))` (with `min` at most 1 and no `max`) with a `takeWhile` run as its first branch. A name written as a repetition of a shared `alt(nameChar, escape)` no longer calls that alternative once per character: about 20% faster on the drivers benchmark's names. The closure compiler compiles `repeat(oneOf(S))` with unused values as `takeWhile(S)` too: 2.2× faster on runs of 30–70 characters. Results are unchanged (#79).
