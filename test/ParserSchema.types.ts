/**
 * Compile-time assertions for `ParserSchema`: each expect-error directive is
 * the assertion (the statement below it must fail to type-check). Checked by
 * `vp run check`, never executed.
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Ascii, Parser, ParserSchema } from "../src/index.js"

// A parser whose output has the schema's type, or a narrower one
Schema.Int.pipe(ParserSchema.annotate(Ascii.hexUint))
Schema.Unknown.pipe(ParserSchema.annotate(Ascii.digit1))
Schema.Int.pipe(ParserSchema.annotate(Parser.reject))
ParserSchema.annotate(Schema.Unknown, Ascii.digit1)
// A grammar alone fits any schema
Schema.Array(Schema.Int).pipe(ParserSchema.annotate({ separator: "," }))

// @ts-expect-error: a number parser for a string schema
Schema.String.pipe(ParserSchema.annotate(Ascii.decUint))
// @ts-expect-error: the same, schema first
ParserSchema.annotate(Schema.String, Ascii.decUint)
// @ts-expect-error: a string parser for a literal schema
Schema.Literal("yes").pipe(ParserSchema.annotate(Ascii.alpha1))
// A print for the schema's type
Schema.Int.pipe(ParserSchema.annotate({ parser: Ascii.hexUint, print: (n) => n.toString(16) }))
ParserSchema.annotate(Schema.Int, { print: (n) => n.toFixed(0) })
// @ts-expect-error: a print for another type
ParserSchema.annotate(Schema.Int, { print: (s: string) => s })
// @ts-expect-error: the grammar's parser is checked too
Schema.Int.pipe(ParserSchema.annotate({ parser: Ascii.alpha1, prefix: "#" }))

// The derived parser has the schema's type
export const point: Parser.Parser<{ readonly x: number; readonly y: number }, Schema.SchemaError> =
  ParserSchema.toParser(Schema.Struct({ x: Schema.Int, y: Schema.Int }))

declare const NeedsService: Schema.Codec<number, number, "Service">
// @ts-expect-error: a schema whose decoding needs services cannot be derived
ParserSchema.toParser(NeedsService)

// The derived printer takes the schema's type
export const printPoint: (value: {
  readonly x: number
  readonly y: number
}) => Result.Result<string, Schema.SchemaError> = ParserSchema.toPrinter(
  Schema.Struct({ x: Schema.Int, y: Schema.Int })
)
// @ts-expect-error: a value of another type
ParserSchema.toPrinter(Schema.Int)("1")
