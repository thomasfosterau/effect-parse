---
"@thomasfosterau/effect-parse": minor
---

Add the `Syntax` module: Tree-sitter-style concrete syntax trees and incremental parsing. Mark a grammar's rules with `Syntax.node` (plus `Syntax.token` for anonymous nodes and `Syntax.field` for field names), and `Syntax.parse` returns a tree of nodes with spans, values, parents and siblings, to search by offset (`descendantAt`) or walk with a `TreeCursor`. Recovered and fatal failures become `ERROR` nodes. After an edit, `Syntax.reparse` and `Syntax.replace` parse again, reusing every node whose input is unchanged, and return the same tree a fresh parse would. Outside `Syntax.parse` the annotations change nothing, and compiled parsers compile them away.
