---
"@thomasfosterau/effect-parse": patch
---

The closure compiler writes the `Text` `takeWhile` loop once per kind of unit read (string, bytes, UTF-16 bytes), so it keeps inlining its reads in a program that parses more than one input kind or encoding: about 17-20% faster on the JSON benchmark's `Text` grammars.
