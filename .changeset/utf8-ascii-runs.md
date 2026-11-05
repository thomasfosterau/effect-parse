---
"@thomasfosterau/effect-parse": patch
---

`Text.utf8` parsers decode long strings that lie in a run of ASCII bytes by slicing them from the run's text, decoded once per parse, instead of making one `TextDecoder` call per string: a JSON document of ASCII strings parses about 27% faster from bytes.
