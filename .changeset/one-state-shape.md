---
"@thomasfosterau/effect-parse": minor
---

Breaking: a parser step that moves the cursor backwards (to retry an alternative, or after a lookahead) must call the new `state.rewind(offset)` instead of assigning `state.pos`; moving forward is still an assignment. `Syntax` trees are now built by a separate builder rather than a `State` subclass whose `pos` was an accessor, so every parser sees one state shape. In a program that also builds syntax trees, ordinary interpreted parses no longer slow down by about 20%. Built-in encodings also share one object shape.
