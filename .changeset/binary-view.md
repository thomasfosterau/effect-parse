---
"@thomasfosterau/effect-parse": patch
---

`Binary` parsers no longer allocate a `DataView` per number: the view is created once per parse state. Parsing a run of 32-bit integers is 3–4× faster, and of floats or a `fold` of 16-bit integers up to 10× when compiled.
