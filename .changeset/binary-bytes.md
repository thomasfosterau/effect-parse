---
"@thomasfosterau/effect-parse": patch
---

`Binary` integers of up to 32 bits are read from the bytes directly, without a `DataView`, and `lengthTake` and `lengthRepeat` reuse the parser they build for each length instead of building one per value: length-prefixed records parse 15–40% faster.
