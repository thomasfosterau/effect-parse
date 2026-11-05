---
"@thomasfosterau/effect-parse": patch
---

`Text.utf8` builds short strings from bytes eight ASCII bytes at a time, and by hand up to 40 bytes (was 24) before calling `TextDecoder`: JSON with escaped strings parses about 25% faster from bytes, and records about 5%.
