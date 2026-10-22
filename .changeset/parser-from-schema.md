---
"@thomasfosterau/effect-parse": minor
---

Add parsers derived from Effect `Schema`s. `ParserSchema.toParser(schema)` derives a parser from a schema, guided by `parser` annotations (`ParserSchema.annotate`, or `schema.annotate({ parser })`) that give a node's `prefix`, `suffix`, `separator`, `keySeparator` and `whitespace`, or a parser that replaces the derived one. Structs, tuples, arrays, records, unions, literals, enums, template literals and recursive schemas are derived; the schema's checks and transformations run on the result. `ParserSchema.fromSchema(schema)` wraps the derived parser as a `Schema` from `string`.

The `parser` annotation key is declared on `Schema.Annotations.Annotations` by module augmentation.
