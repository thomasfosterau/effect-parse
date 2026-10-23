---
"@thomasfosterau/effect-parse": minor
---

Add parsers and printers derived from Effect `Schema`s. `ParserSchema.toParser(schema)` derives a parser from a schema, guided by annotations (`ParserSchema.annotate`, under the key `ParserSchema.annotationKey`) that give a node's `prefix`, `suffix`, `separator`, `keySeparator` and `whitespace`, or a `parser` and `print` that replace the derived ones. Structs, tuples, arrays, records, unions, literals, enums, template literals and recursive schemas are derived; the schema's checks and transformations run on the result. `ParserSchema.toPrinter(schema)` derives the printer of the same text. `ParserSchema.fromSchema(schema)` wraps both as a `Schema` from `string`, whose encoding checks that the text reads back as the value.

The annotation key is declared on `Schema.Annotations.Annotations` by module augmentation.
