---
"@thomasfosterau/effect-parse": patch
---

Interpreted `Token.takeWhile` / `takeTill` and the `Ascii` classes no longer allocate a result record per match: the shared token scanner fills one record that its caller reads at once. The interpreted JSON benchmark (`json.ts`, Token/Ascii) runs 4–7% faster.
