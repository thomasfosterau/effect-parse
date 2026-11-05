---
"@thomasfosterau/effect-parse": patch
---

`Syntax.parse` allocates less per node: leaves share one empty array of children, and nodes are built from the builder's stack without copying their children off it first (about 3% faster on a JSON document).
