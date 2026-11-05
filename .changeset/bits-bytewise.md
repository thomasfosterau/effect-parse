---
"@thomasfosterau/effect-parse": patch
---

`Bits.take` and the other bit parsers read as many bits as each byte holds at once rather than one bit at a time: 16-bit fields parse about 2.5× faster, 3-bit fields about 15%.
