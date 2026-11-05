---
"@thomasfosterau/effect-parse": minor
---

Add `Parser.quiet(p)`, which runs a parser without letting it add to the expectations of later errors. A whitespace or comment skipper that matches zero or more times stops by failing, and what it would have accepted (`" "`, `"(:"`, ...) used to be listed in every error raised after it; wrapped in `quiet`, errors expect only what can actually fail there. When the parser succeeds, its hints and furthest failure are forgotten; when it fails recoverably without consuming input, its failure expects nothing. Compiled parsers treat it as an identity (#74).
