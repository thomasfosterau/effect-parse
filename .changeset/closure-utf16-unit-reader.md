---
"@thomasfosterau/effect-parse": patch
---

The closure compiler reads UTF-16 bytes a code unit at a time, as the JIT does, instead of decoding every code point: compiled `Text.utf16le` / `Text.utf16be` parsers run about 1.75× faster on the JSON benchmark when `new Function` is unavailable.
