/**
 * Effect `Schema`s and parsers, in both directions.
 *
 * {@link make} turns a parser over strings into a schema that decodes a
 * `string` into the parser's output. Parse errors become schema issues
 * carrying the rendered `ParseError` message. Encoding needs a printer,
 * supplied as `encode`; without one, encoding is forbidden.
 *
 * {@link toParser} goes the other way: it derives a parser from a schema,
 * guided by annotations ({@link annotate}) that say how each part is
 * written. {@link toPrinter} derives the printer that writes that text, and
 * {@link fromSchema} wraps both as a schema.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Ascii, Parser, ParserSchema, Token } from "@thomasfosterau/effect-parse"
 *
 * const Version = ParserSchema.make(
 *   Parser.struct({
 *     major: Ascii.decUint,
 *     minor: Parser.preceded(Token.literal("."), Ascii.decUint)
 *   }),
 *   { encode: ({ major, minor }) => `${major}.${minor}` }
 * )
 *
 * Schema.decodeUnknownSync(Version)("1.2") // { major: 1, minor: 2 }
 * Schema.encodeSync(Version)({ major: 3, minor: 4 }) // "3.4"
 * ```
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Match from "effect/Match"
import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Predicate from "effect/Predicate"
import * as Record from "effect/Record"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Ascii from "./Ascii.js"
import type { Parser } from "./Parser.js"
import * as P from "./Parser.js"
import * as Token from "./Token.js"
import { describeLiteral } from "./internal/tokens.js"

/**
 * The key of the annotation that says how a schema is written as text
 * ({@link Annotation}), namespaced to this package so it cannot collide with
 * another library's. {@link annotate} sets it.
 *
 * @since 0.3.0
 * @category annotations
 */
export const annotationKey = "@thomasfosterau/effect-parse/ParserSchema" as const

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /**
       * How the schema is written as text, read by `ParserSchema.toParser`
       * and `ParserSchema.toPrinter`: a parser for the schema's type, or a
       * `ParserSchema.Grammar`.
       */
      readonly [annotationKey]?: Annotation<any> | undefined
    }
  }
}

/**
 * Options for {@link make}.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options<A> {
  /** Prints a value back to a string. Without it, encoding fails. */
  readonly encode?: ((value: A) => string) | undefined
  /** A description of the decoded type, used by schema tooling. */
  readonly description?: string | undefined
}

/**
 * A schema decoding strings with a parser.
 *
 * @since 0.1.0
 * @category models
 */
export interface ParserSchema<A> extends Schema.decodeTo<Schema.declare<A>, Schema.String> {}

type Encode<A> = (value: A) => Result.Result<string, SchemaIssue.Issue>

const encodeWith =
  <A>(encode: (value: A) => string): Encode<A> =>
  (value) =>
    Result.succeed(encode(value))

const decodeWith = <T extends Schema.Top>(
  target: T,
  parser: Parser<T["Encoded"], unknown, never, string>,
  encode: Encode<T["Encoded"]> | undefined
) =>
  Schema.String.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformEffect<T["Encoded"], string>({
        decode: (input, parseOptions) => {
          const result = P.parse(parser, input)
          return Result.isSuccess(result)
            ? Effect.succeed(result.success)
            : Effect.fail(new SchemaIssue.InvalidValue({ message: result.failure.message }, input, parseOptions))
        },
        encode: (value, parseOptions) => {
          if (encode === undefined) {
            return Effect.fail(new SchemaIssue.Forbidden({ message: "Encoding is not supported" }, value, parseOptions))
          }
          const result = encode(value)
          return Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure)
        }
      })
    )
  )

/**
 * Creates a schema that decodes a string with `parser`, which must consume
 * the whole string.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = <A, E>(parser: Parser<A, E, never, string>, options?: Options<A>): ParserSchema<A> =>
  decodeWith(
    Schema.declare<A>(
      (_u): _u is A => true,
      options?.description !== undefined ? { description: options.description } : undefined
    ),
    parser,
    options?.encode === undefined ? undefined : encodeWith(options.encode)
  )

// -----------------------------------------------------------------------------
// Deriving parsers and printers from schemas
// -----------------------------------------------------------------------------

/**
 * How a schema is written as text, given in its annotation (see
 * {@link annotate}) and read by {@link toParser} and {@link toPrinter}.
 * Every field is optional; a schema without one is written as described on
 * {@link toParser}.
 *
 * @since 0.3.0
 * @category models
 */
export interface Grammar<A = unknown> {
  /**
   * Parses the schema's type outright, replacing what {@link toParser} would
   * derive. Its output is still validated against the schema's type and
   * checks, and its failures' causes become `SchemaError`s with their message.
   * Give a {@link Grammar.print} with it, or the schema cannot be printed.
   */
  readonly parser?: Parser<A, unknown, never, string> | undefined
  /** Writes a value as the text {@link Grammar.parser} reads, replacing what {@link toPrinter} would derive. */
  readonly print?: ((value: A) => string) | undefined
  /** Text written before the value. */
  readonly prefix?: string | undefined
  /** Text written after the value. */
  readonly suffix?: string | undefined
  /** Text written between the fields of a struct, the elements of a tuple or array, or the entries of a record. */
  readonly separator?: string | undefined
  /**
   * Text written between a key and its value. On a struct, it writes each
   * field as `key`, separator, value, in any order; records always need one.
   */
  readonly keySeparator?: string | undefined
  /**
   * Whether whitespace may surround the text this schema writes (its prefix,
   * suffix and separators), and whitespace around unannotated strings is
   * trimmed. Inherited by the schemas inside it. Printers write no
   * whitespace.
   */
  readonly whitespace?: boolean | undefined
}

/**
 * The value of the annotation under {@link annotationKey}: a
 * {@link Grammar}, or a parser for the schema's type (short for
 * `{ parser }`, which cannot be printed).
 *
 * @since 0.3.0
 * @category models
 */
export type Annotation<A = unknown> = Grammar<A> | Parser<A, unknown, never, string>

/**
 * Annotates a schema with how it is written as text, for {@link toParser}
 * and {@link toPrinter}. The same as
 * `schema.annotate({ [ParserSchema.annotationKey]: annotation })`, except
 * that the parser's output must have the schema's type.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ParserSchema } from "@thomasfosterau/effect-parse"
 *
 * const Point = Schema.Struct({ x: Schema.Int, y: Schema.Int }).pipe(
 *   ParserSchema.annotate({ prefix: "(", separator: ",", suffix: ")" })
 * )
 * ```
 *
 * @since 0.3.0
 * @category annotations
 */
export const annotate: {
  // A grammar without a parser constrains nothing
  <A = never>(
    annotation: Annotation<A>
  ): <S extends Schema.Top>(self: S & ([A] extends [S["Type"]] ? unknown : never)) => S["Rebuild"]
  <S extends Schema.Top>(self: S, annotation: Annotation<S["Type"]>): S["Rebuild"]
} = /*#__PURE__*/ dual(2, <S extends Schema.Top>(self: S, annotation: Annotation<S["Type"]>): S["Rebuild"] =>
  self.annotate({ [annotationKey]: annotation })
)

/**
 * Derives a parser from a schema. The parser reads the text the schema's
 * annotations ({@link Grammar}) describe and returns a value of the schema's
 * type, which the schema's checks and transformations have already
 * validated; their failures become parse errors whose `cause` is the
 * `SchemaError`.
 *
 * Without an annotation, a schema is parsed as follows:
 *
 * - `String`: one or more characters up to the next separator, key
 *   separator, suffix or literal around it (to the end of the input at the
 *   top level).
 * - `Number`: a decimal number (`Ascii.float`), or a decimal integer when
 *   the schema checks `isInt` (as `Schema.Int` does). `BigInt`: a decimal
 *   integer. `Boolean`: `true` or `false`. `Null`: `null`. `Undefined` and
 *   `Void`: nothing.
 * - `Literal`, `Enum` and `TemplateLiteral`: their text.
 * - `Struct` and `Tuple`: their fields or elements in order, between
 *   separators; an optional one may be left out along with its separator.
 *   `Array`: elements between separators.
 * - `Record`, and `Struct` with a `keySeparator`: `key`, key separator,
 *   value entries in any order, between separators.
 * - `Union`: the first member that parses, in order (literals longest
 *   first). `suspend`: recursion.
 * - A transformation (a `Class`, `NumberFromString`, ...): its encoded side,
 *   decoded by the schema. A grammar on it with a separator applies to the
 *   encoded side.
 *
 * A parser that fails where the schema starts reports the schema's
 * `identifier` annotation (or its `expected` annotation, unless that belongs
 * to a check) as what it expected. Other declarations, `Unknown`, `Any`,
 * symbols and `object` need a parser in their annotation; without one,
 * `toParser` throws. Transformations must decode synchronously.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Parser, ParserSchema } from "@thomasfosterau/effect-parse"
 *
 * const Version = Schema.Struct({ major: Schema.Int, minor: Schema.Int }).pipe(
 *   ParserSchema.annotate({ separator: "." })
 * )
 *
 * Parser.parse(ParserSchema.toParser(Version), "1.2") // Result.succeed({ major: 1, minor: 2 })
 * ```
 *
 * @since 0.3.0
 * @category derivation
 */
export const toParser = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
): Parser<S["Type"], Schema.SchemaError, never, string> => {
  const ast = schema.ast
  const parser = derive(ast, initial<AnyParser>())
  return grammarOf(ast).whitespace === true ? P.delimited(Ascii.multispace0, parser, Ascii.multispace0) : parser
}

/**
 * Derives a printer from a schema: it writes a value of the schema's type as
 * the text {@link toParser} reads, following the same annotations, with no
 * optional whitespace. Transformations encode the value first, and a
 * {@link Grammar.print} replaces the derived printer.
 *
 * The printer fails with a `SchemaError` when the value is not of the
 * schema's type, or cannot be written so that it reads back: a string that
 * is empty or contains a character that would end it (a separator, a
 * suffix), or a part annotated with a parser but no `print`. Where the
 * grammar is ambiguous (an optional field followed by a field of the same
 * type), the text can still read back as a different value;
 * {@link fromSchema} checks that it doesn't.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ParserSchema } from "@thomasfosterau/effect-parse"
 *
 * const Version = Schema.Struct({ major: Schema.Int, minor: Schema.Int }).pipe(
 *   ParserSchema.annotate({ separator: "." })
 * )
 *
 * ParserSchema.toPrinter(Version)({ major: 1, minor: 2 }) // Result.succeed("1.2")
 * ```
 *
 * @since 0.3.0
 * @category derivation
 */
export const toPrinter = <S extends Schema.ConstraintCodec<unknown, unknown, unknown, never>>(
  schema: S
): ((value: S["Type"]) => Result.Result<string, Schema.SchemaError>) => {
  const validate = typeDecoder(schema.ast)
  const print = printerOf(schema.ast, initial<Printer>())
  return (value) => {
    const valid = validate(value)
    if (Result.isFailure(valid)) return Result.fail(valid.failure)
    const out: Array<string> = []
    const issue = print(valid.success, out)
    return issue === undefined ? Result.succeed(out.join("")) : Result.fail(schemaError(issue))
  }
}

/**
 * Creates a schema that decodes a string with the parser {@link toParser}
 * derives from `schema`, into `schema`'s type, and encodes with the printer
 * {@link toPrinter} derives, or with `encode` when given. A derived printer's
 * text is parsed back, and encoding fails unless it gives a value equivalent
 * to the one encoded, so decoding what was encoded always gives it back.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ParserSchema } from "@thomasfosterau/effect-parse"
 *
 * const Pair = ParserSchema.fromSchema(
 *   Schema.Tuple([Schema.String, Schema.Number]).pipe(ParserSchema.annotate({ separator: "=" }))
 * )
 *
 * Schema.decodeUnknownSync(Pair)("width=10") // ["width", 10]
 * Schema.encodeSync(Pair)(["height", 2]) // "height=2"
 * ```
 *
 * @since 0.3.0
 * @category constructors
 */
export const fromSchema = <S extends Schema.ConstraintCodec<unknown, unknown, never, never> & Schema.Top>(
  schema: S,
  options?: { readonly encode?: ((value: S["Type"]) => string) | undefined }
): Schema.decodeTo<Schema.toType<S>, Schema.String> => {
  const parser = toParser(schema)
  const encode = options?.encode
  return decodeWith<Schema.toType<S>>(
    Schema.toType(schema),
    parser,
    encode === undefined ? roundTrip(schema, parser) : encodeWith(encode)
  )
}

/** Prints with the derived printer, then checks that the text reads back as the value. */
const roundTrip = <S extends Schema.ConstraintCodec<unknown, unknown, never, never> & Schema.Top>(
  schema: S,
  parser: Parser<S["Type"], Schema.SchemaError, never, string>
): Encode<S["Type"]> => {
  const print = toPrinter(schema)
  const equivalent = Schema.toEquivalence(Schema.toType(schema))
  return (value) =>
    Result.flatMap(
      Result.mapError(print(value), (error) => error.issue),
      (text) => {
        const back = P.parse(parser, text)
        return Result.isSuccess(back) && equivalent(back.success, value)
          ? Result.succeed(text)
          : Result.fail(
              new SchemaIssue.InvalidValue({
                message: `The value is written ${describeLiteral(text)}, which does not read back as the value`
              })
            )
      }
    )
}

// -----------------------------------------------------------------------------
// The walk shared by parsers and printers
// -----------------------------------------------------------------------------

interface Context<T> {
  /** Characters ending an unannotated string, sorted. */
  readonly stop: string
  readonly whitespace: boolean
  /** Grammar passed from a transformation to its encoded side. */
  readonly inherit: Grammar | undefined
  readonly path: ReadonlyArray<PropertyKey>
  /** What was derived for the recursive schemas met so far, by context. */
  readonly recursions: Array<Recursion<T>>
}

interface Recursion<T> {
  readonly ast: SchemaAST.Suspend
  readonly key: string
  readonly derived: T
}

const initial = <T>(): Context<T> => ({ stop: "", whitespace: false, inherit: undefined, path: [], recursions: [] })

/** The annotation `key` on `ast`, from its last check back to the node, as `Schema.resolveAnnotations` resolves it. */
const lookup = (ast: SchemaAST.AST, key: string): unknown => {
  const checks = ast.checks
  if (checks !== undefined) {
    for (let i = checks.length - 1; i >= 0; i--) {
      const value = checks[i].annotations?.[key]
      if (value !== undefined) return value
    }
  }
  return ast.annotations?.[key]
}

const grammarOf = (ast: SchemaAST.AST): Grammar => {
  const value = lookup(ast, annotationKey)
  if (value === undefined) return {}
  // SAFETY: the annotation is typed `Annotation`, a parser or a grammar
  return P.isParser(value) ? { parser: value as ForeignParser } : (value as Grammar)
}

const isAnnotated = (ast: SchemaAST.AST): boolean => lookup(ast, annotationKey) !== undefined

const withStop = <T>(ctx: Context<T>, text: string | undefined): Context<T> => {
  if (text === undefined || text === "" || ctx.stop.includes(text[0])) return ctx
  return { ...ctx, stop: Arr.sort([...ctx.stop.split(""), text[0]], Order.String).join("") }
}

const at = <T>(ctx: Context<T>, key: PropertyKey): Context<T> => ({
  ...ctx,
  inherit: undefined,
  path: [...ctx.path, key]
})

const where = <T>(ctx: Context<T>): string => `[${ctx.path.map(String).join(", ")}]`

const unsupported = <T>(ast: SchemaAST.AST, ctx: Context<T>, what: string): never => {
  throw new TypeError(`ParserSchema: cannot derive a ${what} for ${ast._tag} at ${where(ctx)}; annotate it`)
}

interface Resolved<T> {
  readonly grammar: Grammar
  readonly whitespace: boolean
  /** The context of what the node contains. */
  readonly inner: Context<T>
}

/** The node's grammar, with what its transformation passed down, and the context inside it. */
const resolve = <T>(ast: SchemaAST.AST, ctx: Context<T>): Resolved<T> => {
  const own = grammarOf(ast)
  const inherit = ctx.inherit
  const grammar: Grammar =
    inherit === undefined
      ? own
      : {
          ...own,
          separator: own.separator ?? inherit.separator,
          keySeparator: own.keySeparator ?? inherit.keySeparator
        }
  const whitespace = grammar.whitespace ?? ctx.whitespace
  return { grammar, whitespace, inner: { ...withStop(ctx, grammar.suffix), whitespace, inherit: undefined } }
}

/** The context of a transformation's encoded side, which the transformation's separators apply to. */
const encodedContext = <T>(grammar: Grammar, ctx: Context<T>): Context<T> => ({
  ...ctx,
  inherit: { separator: grammar.separator, keySeparator: grammar.keySeparator }
})

/**
 * The node with its chain of links ending at the type of its encoded side,
 * which is what the encoded side is parsed into and printed from.
 */
const linkTarget = (ast: SchemaAST.AST, links: SchemaAST.Encoding): SchemaAST.AST => {
  const last = links[links.length - 1]
  let target = SchemaAST.toType(ast)
  for (const link of links) {
    const source = link === last ? SchemaAST.toType(last.to) : link.to
    // SAFETY: `decodeTo` appends the link as it is, middleware included, as the schema's own links are
    target = SchemaAST.decodeTo(source, target, link.transformation as SchemaTransformation.Transformation<any, any>)
  }
  return target
}

/**
 * What is derived for a recursive schema: deriving it again in the same
 * context gives the same result, so the derivation ends.
 */
const recursive = <T>(ast: SchemaAST.Suspend, ctx: Context<T>, make: () => T): T => {
  const key = `${ctx.whitespace ? 1 : 0}${ctx.stop}`
  const known = ctx.recursions.find((r) => r.ast === ast && r.key === key)
  if (known !== undefined) return known.derived
  const derived = make()
  ctx.recursions.push({ ast, key, derived })
  return derived
}

/** The context for the items of a sequence: unannotated strings also stop at the separator. */
const itemContext = <T>(grammar: Grammar, ctx: Context<T>): Context<T> => withStop(ctx, grammar.separator)

/** The rest element of an array schema, if any; elements after it are not supported. */
const restOf = <T>(ast: SchemaAST.Arrays, ctx: Context<T>, what: string): SchemaAST.AST | undefined => {
  const [head, ...after] = ast.rest
  // Elements after the rest would need the rest to stop short
  return Arr.isReadonlyArrayNonEmpty(after) ? unsupported(ast, ctx, what) : head
}

/** The contexts of an array schema's elements and its rest. */
const elementContexts = <T>(
  ast: SchemaAST.Arrays,
  rest: SchemaAST.AST | undefined,
  grammar: Grammar,
  ctx: Context<T>
): ReadonlyArray<Context<T>> => {
  const n = ast.elements.length
  return ast.elements.map((_, i) => at(i < n - 1 || rest !== undefined ? itemContext(grammar, ctx) : ctx, i))
}

/** The contexts of a struct's fields, written in order. */
const fieldContexts = <T>(ast: SchemaAST.Objects, grammar: Grammar, ctx: Context<T>): ReadonlyArray<Context<T>> => {
  const fields = ast.propertySignatures
  return fields.map((field, i) => at(i < fields.length - 1 ? itemContext(grammar, ctx) : ctx, field.name))
}

const isKeyed = (ast: SchemaAST.Objects, grammar: Grammar): boolean =>
  grammar.keySeparator !== undefined || Arr.isReadonlyArrayNonEmpty(ast.indexSignatures)

const keySeparatorOf = <T>(grammar: Grammar, ctx: Context<T>): string => {
  if (grammar.keySeparator === undefined) {
    throw new TypeError(`ParserSchema: a record at ${where(ctx)} needs a keySeparator in its annotation`)
  }
  return grammar.keySeparator
}

/** The field name of a struct in keyed form: a string. */
const keyName = <T>(ast: SchemaAST.Objects, field: SchemaAST.PropertySignature, ctx: Context<T>, what: string) =>
  Predicate.isString(field.name) ? field.name : unsupported(ast, ctx, what)

const propertyName = (key: PropertyKey): string | symbol => (Predicate.isNumber(key) ? String(key) : key)

/** Whether a check (as `Schema.Int` has) restricts numbers to integers. */
const isIntegral = (checks: SchemaAST.Checks | undefined): boolean =>
  checks !== undefined &&
  checks.some((check) =>
    check instanceof SchemaAST.FilterGroup
      ? isIntegral(check.checks)
      : check.annotations?.arbitraryConstraint?.["number"] === "integer"
  )

type LiteralValue = SchemaAST.Literal["literal"]

/** Literals with the longest text first, so a literal is never cut short by one it starts with. */
const byLength = <A extends LiteralValue>(values: ReadonlyArray<A>): Array<A> =>
  Arr.sort(
    values,
    Order.mapInput(Order.Number, (value: A) => -String(value).length)
  )

const isPlainLiteral = (ast: SchemaAST.AST): ast is SchemaAST.Literal =>
  SchemaAST.isLiteral(ast) && ast.encoding === undefined && !isAnnotated(ast)

/** The literals of a union of plain literals, longest first, or `undefined`. */
const plainLiterals = (ast: SchemaAST.Union): ReadonlyArray<LiteralValue> | undefined => {
  const literals = Arr.filter(ast.types, isPlainLiteral)
  return literals.length === ast.types.length ? byLength(literals.map((member) => member.literal)) : undefined
}

const schemaError = (issue: SchemaIssue.Issue) => new Schema.SchemaError(issue)

const decoder = (schema: Schema.ConstraintDecoder<unknown>) => Schema.decodeUnknownResult(schema)

/** Decodes into the type of `ast`, checks included. */
const typeDecoder = (ast: SchemaAST.AST) => decoder(Schema.make<Schema.Codec<unknown>>(SchemaAST.toType(ast)))

// -----------------------------------------------------------------------------
// Parsers
// -----------------------------------------------------------------------------

type AnyParser = Parser<any, Schema.SchemaError, never, string>

type ForeignParser = Parser<unknown, unknown, never, string>

const messageOf = (cause: unknown): string =>
  Predicate.isString(cause)
    ? cause
    : Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
      ? cause.message
      : String(cause)

/** A parser whose failures' causes are `SchemaError`s, as {@link toParser}'s are. */
const asSchemaErrors = (parser: ForeignParser): AnyParser =>
  P.mapError(parser, (cause) =>
    cause instanceof Schema.SchemaError
      ? cause
      : schemaError(new SchemaIssue.InvalidValue({ message: messageOf(cause) }))
  )

/** Literal text, with optional whitespace around it. */
const text = (s: string, ws: boolean): AnyParser =>
  ws ? P.delimited(Ascii.multispace0, Token.literal(s), Ascii.multispace0) : Token.literal(s)

const derive = (ast: SchemaAST.AST, ctx: Context<AnyParser>): AnyParser => {
  const { grammar, inner, whitespace } = resolve(ast, ctx)
  let parser: AnyParser
  if (grammar.parser !== undefined) parser = P.tryMap(asSchemaErrors(grammar.parser), typeDecoder(ast))
  else if (ast.encoding !== undefined) parser = decoded(ast, ast.encoding, grammar, inner)
  else parser = checked(ast, structural(ast, grammar, inner))
  if (grammar.prefix !== undefined) parser = P.preceded(text(grammar.prefix, whitespace), parser)
  if (grammar.suffix !== undefined) parser = P.terminated(parser, text(grammar.suffix, whitespace))
  // A check's own `expected` describes the check, not the text
  const label = lookup(ast, "identifier") ?? ast.annotations?.expected
  return Predicate.isString(label) ? P.expected(parser, label) : parser
}

/** Runs the checks on `ast` (its filters) on the parser's output. */
const checked = (ast: SchemaAST.AST, parser: AnyParser): AnyParser =>
  ast.checks === undefined ? parser : P.tryMap(parser, decoder(Schema.Unknown.check(...ast.checks)))

/**
 * Parses the encoded side of a transformation and decodes it. The encoded
 * side is parsed into its own type, so the last link decodes from that type
 * rather than from the fully encoded form.
 */
const decoded = (
  ast: SchemaAST.AST,
  links: SchemaAST.Encoding,
  grammar: Grammar,
  ctx: Context<AnyParser>
): AnyParser => {
  const from = derive(links[links.length - 1].to, encodedContext(grammar, ctx))
  return P.tryMap(from, decoder(Schema.make<Schema.Codec<unknown>>(linkTarget(ast, links))))
}

const structural = (ast: SchemaAST.AST, grammar: Grammar, ctx: Context<AnyParser>): AnyParser =>
  Match.valueTags(ast, {
    String: () => unannotatedString(ctx, 1),
    Number: (number) => (isIntegral(number.checks) ? integer : Ascii.float),
    BigInt: () => Ascii.decBigInt,
    Boolean: () => P.alt(P.as(Token.literal("true"), true), P.as(Token.literal("false"), false)),
    Null: () => P.as(Token.literal("null"), null),
    Undefined: () => P.succeed(undefined),
    Void: () => P.succeed(undefined),
    Never: () => P.reject,
    Literal: (lit) => literal(lit.literal),
    Enum: (e) => P.alt(...byLength(e.enums.map(([, value]) => value)).map(literal)),
    TemplateLiteral: (template) => templateLiteral(template, ctx),
    Arrays: (arrays) => sequenceOf(arrays, grammar, ctx),
    Objects: (objects) =>
      isKeyed(objects, grammar) ? keyed(objects, grammar, ctx) : positional(objects, grammar, ctx),
    Union: (union) => alternatives(union, ctx),
    Suspend: (suspend) => recursive(suspend, ctx, () => P.suspend(() => derive(suspend.thunk(), ctx))),
    Declaration: (other) => unsupported(other, ctx, "parser"),
    Unknown: (other) => unsupported(other, ctx, "parser"),
    Any: (other) => unsupported(other, ctx, "parser"),
    Symbol: (other) => unsupported(other, ctx, "parser"),
    UniqueSymbol: (other) => unsupported(other, ctx, "parser"),
    ObjectKeyword: (other) => unsupported(other, ctx, "parser")
  })

const unannotatedString = (ctx: Context<AnyParser>, min: number): AnyParser => {
  const s = Token.takeTill(ctx.stop, { min })
  // Leading whitespace is skipped first, so it doesn't count towards `min`
  return ctx.whitespace
    ? P.preceded(
        Ascii.multispace0,
        P.map(s, (value) => value.trimEnd())
      )
    : s
}

const integer: AnyParser = /*#__PURE__*/ asSchemaErrors(Ascii.decInt)

const literal = (value: LiteralValue): AnyParser => P.as(Token.literal(String(value)), value)

const templateLiteral = (ast: SchemaAST.TemplateLiteral, ctx: Context<AnyParser>): AnyParser =>
  P.taken(
    P.seq(
      ...ast.parts.map((part, i) => {
        const next = ast.parts[i + 1]
        const partCtx = next !== undefined && SchemaAST.isLiteral(next) ? withStop(ctx, String(next.literal)) : ctx
        // An interpolated string may be empty
        return SchemaAST.isString(part) && !isAnnotated(part)
          ? unannotatedString(partCtx, 0)
          : derive(part, at(partCtx, i))
      })
    )
  )

const alternatives = (ast: SchemaAST.Union, ctx: Context<AnyParser>): AnyParser => {
  const literals = plainLiterals(ast)
  return literals !== undefined
    ? P.alt(...literals.map(literal))
    : P.alt(...ast.types.map((member) => derive(member, ctx)))
}

interface Item {
  readonly parser: AnyParser
  readonly optional: boolean
}

type Values = Parser<Array<unknown>, Schema.SchemaError, never, string>

/**
 * Parses `items` in order, then any number of `rest`, with `separator`
 * between the ones present. The output has the value of item `i` at index
 * `i` (a hole when an optional item is missing), then the rest.
 */
const sequence = (
  items: ReadonlyArray<Item>,
  rest: AnyParser | undefined,
  separator: AnyParser | undefined
): Values => {
  const n = items.length
  const tail = (needSeparator: boolean): Values => {
    if (rest === undefined) return P.sync(() => new Array(n))
    const values =
      separator === undefined
        ? P.repeat(rest)
        : needSeparator
          ? P.repeat(P.preceded(separator, rest))
          : P.separated(rest, separator)
    return P.map(values, (xs) => {
      const out = new Array(n)
      for (let j = 0; j < xs.length; j++) out[n + j] = xs[j]
      return out
    })
  }
  // One parser per position and whether a separator comes first, at index `2 * i + needSeparator`
  const memo: Array<Values | undefined> = []
  const from = (i: number, needSeparator: boolean): Values => {
    const key = i * 2 + (needSeparator ? 1 : 0)
    const known = memo[key]
    if (known !== undefined) return known
    let parser: Values
    if (i === n) parser = tail(needSeparator)
    else {
      const item = items[i]
      const head = needSeparator && separator !== undefined ? P.preceded(separator, item.parser) : item.parser
      const present = P.map(P.seq(head, from(i + 1, true)), ([value, out]) => {
        out[i] = value
        return out
      })
      parser = item.optional ? P.alt(present, from(i + 1, needSeparator)) : present
    }
    memo[key] = parser
    return parser
  }
  return from(0, false)
}

const separatorOf = (grammar: Grammar, ctx: Context<AnyParser>): AnyParser | undefined =>
  grammar.separator === undefined ? undefined : text(grammar.separator, ctx.whitespace)

const sequenceOf = (ast: SchemaAST.Arrays, grammar: Grammar, ctx: Context<AnyParser>): AnyParser => {
  const head = restOf(ast, ctx, "parser")
  const contexts = elementContexts(ast, head, grammar, ctx)
  const items = ast.elements.map((element, i) => ({
    parser: derive(element, contexts[i]),
    optional: SchemaAST.isOptional(element)
  }))
  const rest = head === undefined ? undefined : derive(head, at(itemContext(grammar, ctx), items.length))
  // Optional elements come last, so the present values are the first ones
  return P.map(sequence(items, rest, separatorOf(grammar, ctx)), (out) => out.filter((_, i) => i in out))
}

const positional = (ast: SchemaAST.Objects, grammar: Grammar, ctx: Context<AnyParser>): AnyParser => {
  const fields = ast.propertySignatures
  const contexts = fieldContexts(ast, grammar, ctx)
  const items = fields.map((field, i) => ({
    parser: derive(field.type, contexts[i]),
    optional: SchemaAST.isOptional(field.type)
  }))
  return P.map(sequence(items, undefined, separatorOf(grammar, ctx)), (out) =>
    Record.fromEntries(fields.flatMap((field, i) => (i in out ? [[propertyName(field.name), out[i]] as const] : [])))
  )
}

type Entry = readonly [key: string | symbol, value: unknown, known: boolean]

const keyed = (ast: SchemaAST.Objects, grammar: Grammar, ctx: Context<AnyParser>): AnyParser => {
  const keySeparator = keySeparatorOf(grammar, ctx)
  const between = text(keySeparator, ctx.whitespace)
  const valueCtx = itemContext(grammar, ctx)
  const known = ast.propertySignatures.map((field): AnyParser => {
    const name = keyName(ast, field, ctx, "parser")
    const value = derive(field.type, at(valueCtx, name))
    return P.map(P.preceded(P.seq(Token.literal(name), between), value), (v): Entry => [name, v, true])
  })
  const indexed = ast.indexSignatures.map((signature): AnyParser => {
    const key = derive(signature.parameter, at(withStop(ctx, keySeparator), "<key>"))
    const value = derive(signature.type, at(valueCtx, "<value>"))
    return P.map(P.separatedPair(key, between, value), ([k, v]): Entry => [propertyName(k), v, false])
  })
  const entry = P.alt(...known, ...indexed)
  const separator = separatorOf(grammar, ctx)
  const entries = separator === undefined ? P.repeat(entry) : P.separated(entry, separator)
  // A missing field fails where its entry could have been, as a syntax error, so a
  // failure further in (the entry that ended the repetition early) is reported instead
  const missing = ast.propertySignatures.map((field) =>
    P.expected(P.reject, describeLiteral(`${String(field.name)}${keySeparator}`))
  )
  return P.flatMap(
    P.tryMap(entries, (es: ReadonlyArray<Entry>) => assemble(ast, es)),
    ([value, absent]) => (absent === undefined ? P.succeed(value) : missing[absent])
  )
}

/**
 * Builds the object from its entries, declared fields first, rejecting
 * duplicate keys. Also returns the index of the first required field
 * missing, if any.
 */
const assemble = (
  ast: SchemaAST.Objects,
  entries: ReadonlyArray<Entry>
): Result.Result<readonly [object, number | undefined], Schema.SchemaError> => {
  const values = MutableHashMap.empty<string | symbol, unknown>()
  for (const [key, value] of entries) {
    if (MutableHashMap.has(values, key)) {
      return Result.fail(
        schemaError(new SchemaIssue.Pointer([key], new SchemaIssue.InvalidValue({ message: "Duplicate key" })))
      )
    }
    MutableHashMap.set(values, key, value)
  }
  const out: Array<readonly [string | symbol, unknown]> = []
  let absent: number | undefined
  ast.propertySignatures.forEach((field, i) => {
    const name = propertyName(field.name)
    const value = MutableHashMap.get(values, name)
    if (Option.isSome(value)) out.push([name, value.value])
    else if (absent === undefined && !SchemaAST.isOptional(field.type)) absent = i
  })
  for (const [key, value, isKnown] of entries) if (!isKnown) out.push([key, value])
  return Result.succeed([Record.fromEntries(out), absent])
}

// -----------------------------------------------------------------------------
// Printers
// -----------------------------------------------------------------------------

/**
 * Writes the text of a value, already validated against the schema's type,
 * to `out`, or returns why it cannot be written.
 */
type Printer = (value: any, out: Array<string>) => SchemaIssue.Issue | undefined

/** The issue for a value that cannot be written at the node `ctx` is at. */
const unwritable = <T>(ctx: Context<T>, message: string, value: unknown): SchemaIssue.Issue => {
  const issue = new SchemaIssue.InvalidValue({ message }, value, { reportInput: true })
  return Arr.isReadonlyArrayNonEmpty(ctx.path) ? new SchemaIssue.Pointer(ctx.path, issue) : issue
}

const writing =
  (show: (value: any) => string): Printer =>
  (value, out) => {
    out.push(show(value))
    return undefined
  }

const nothing: Printer = (_, __) => undefined

const printerOf = (ast: SchemaAST.AST, ctx: Context<Printer>): Printer => {
  const { grammar, inner } = resolve(ast, ctx)
  let print: Printer
  if (grammar.print !== undefined) print = writing(grammar.print)
  else if (grammar.parser !== undefined) print = unprintable(ctx)
  else if (ast.encoding !== undefined) print = encoded(ast, ast.encoding, grammar, inner)
  else print = printerFor(ast, grammar, inner)
  const prefix = grammar.prefix
  const suffix = grammar.suffix
  if (prefix === undefined && suffix === undefined) return print
  const inside = print
  return (value, out) => {
    if (prefix !== undefined) out.push(prefix)
    const issue = inside(value, out)
    if (suffix !== undefined) out.push(suffix)
    return issue
  }
}

const unprintable =
  (ctx: Context<Printer>): Printer =>
  (value) =>
    unwritable(ctx, "This value has a parser in its annotation but no print, so it cannot be written", value)

/** Encodes a transformation's value and prints its encoded side. */
const encoded = (ast: SchemaAST.AST, links: SchemaAST.Encoding, grammar: Grammar, ctx: Context<Printer>): Printer => {
  const to = printerOf(links[links.length - 1].to, encodedContext(grammar, ctx))
  const encode = Schema.encodeUnknownResult(Schema.make<Schema.Codec<unknown, unknown>>(linkTarget(ast, links)))
  return (value, out) => {
    const result = encode(value)
    return Result.isSuccess(result) ? to(result.success, out) : result.failure.issue
  }
}

const printerFor = (ast: SchemaAST.AST, grammar: Grammar, ctx: Context<Printer>): Printer =>
  Match.valueTags(ast, {
    String: () => stringPrinter(ctx),
    Number: () => writing(String),
    BigInt: () => writing(String),
    Boolean: () => writing(String),
    Null: () => writing(String),
    Undefined: () => nothing,
    Void: () => nothing,
    Never: () => nothing,
    Literal: () => writing(String),
    Enum: () => writing(String),
    TemplateLiteral: () => writing(String),
    Arrays: (arrays) => arraysPrinter(arrays, grammar, ctx),
    Objects: (objects) =>
      isKeyed(objects, grammar) ? keyedPrinter(objects, grammar, ctx) : positionalPrinter(objects, grammar, ctx),
    Union: (union) => unionPrinter(union, ctx),
    Suspend: (suspend) =>
      recursive(suspend, ctx, () => {
        let print: Printer | undefined
        return (value, out) => (print ??= printerOf(suspend.thunk(), ctx))(value, out)
      }),
    Declaration: (other) => unsupported(other, ctx, "printer"),
    Unknown: (other) => unsupported(other, ctx, "printer"),
    Any: (other) => unsupported(other, ctx, "printer"),
    Symbol: (other) => unsupported(other, ctx, "printer"),
    UniqueSymbol: (other) => unsupported(other, ctx, "printer"),
    ObjectKeyword: (other) => unsupported(other, ctx, "printer")
  })

/**
 * Writes a string as an unannotated string is parsed: refusing one that
 * would not read back, being empty or holding a character that ends it.
 */
const stringPrinter =
  (ctx: Context<Printer>): Printer =>
  (value: string, out) => {
    if (value === "") return unwritable(ctx, "An empty string cannot be written here", value)
    const stop = Arr.findFirst(Array.from(ctx.stop), (c) => value.includes(c))
    if (Option.isSome(stop)) {
      return unwritable(ctx, `A string containing ${describeLiteral(stop.value)} cannot be written here`, value)
    }
    if (ctx.whitespace && value.trim() !== value) {
      return unwritable(ctx, "A string with whitespace around it cannot be written here", value)
    }
    out.push(value)
    return undefined
  }

/** Writes values with a separator between them, stopping at the first that cannot be written. */
const writeAll = (
  writes: ReadonlyArray<(out: Array<string>) => SchemaIssue.Issue | undefined>,
  separator: string,
  out: Array<string>
): SchemaIssue.Issue | undefined => {
  for (let i = 0; i < writes.length; i++) {
    if (i > 0) out.push(separator)
    const issue = writes[i](out)
    if (issue !== undefined) return issue
  }
  return undefined
}

const arraysPrinter = (ast: SchemaAST.Arrays, grammar: Grammar, ctx: Context<Printer>): Printer => {
  const head = restOf(ast, ctx, "printer")
  const contexts = elementContexts(ast, head, grammar, ctx)
  const elements = ast.elements.map((element, i) => printerOf(element, contexts[i]))
  const rest = head === undefined ? nothing : printerOf(head, at(itemContext(grammar, ctx), elements.length))
  const separator = grammar.separator ?? ""
  return (value: ReadonlyArray<unknown>, out) =>
    writeAll(
      value.map((element, i) => (o: Array<string>) => (elements[i] ?? rest)(element, o)),
      separator,
      out
    )
}

const positionalPrinter = (ast: SchemaAST.Objects, grammar: Grammar, ctx: Context<Printer>): Printer => {
  const contexts = fieldContexts(ast, grammar, ctx)
  const fields = ast.propertySignatures.map((field, i) => ({
    name: propertyName(field.name),
    print: printerOf(field.type, contexts[i])
  }))
  const separator = grammar.separator ?? ""
  return (value: Record.ReadonlyRecord<string | symbol, unknown>, out) =>
    writeAll(
      fields
        .filter((field) => Record.has(value, field.name))
        .map((field) => (o: Array<string>) => field.print(value[field.name], o)),
      separator,
      out
    )
}

const keyedPrinter = (ast: SchemaAST.Objects, grammar: Grammar, ctx: Context<Printer>): Printer => {
  const keySeparator = keySeparatorOf(grammar, ctx)
  const valueCtx = itemContext(grammar, ctx)
  const fields = ast.propertySignatures.map((field) => {
    const name = keyName(ast, field, ctx, "printer")
    return { name, print: printerOf(field.type, at(valueCtx, name)) }
  })
  const names = fields.map((field) => field.name)
  const indexed = ast.indexSignatures.map((signature) => ({
    is: Schema.is(Schema.make<Schema.Top>(SchemaAST.toType(signature.parameter))),
    key: printerOf(signature.parameter, at(withStop(ctx, keySeparator), "<key>")),
    value: printerOf(signature.type, at(valueCtx, "<value>"))
  }))
  const entry =
    (key: Printer, print: Printer, k: unknown, v: unknown) =>
    (out: Array<string>): SchemaIssue.Issue | undefined =>
      key(k, out) ?? (out.push(keySeparator), print(v, out))
  return (value: Record.ReadonlyRecord<string, unknown>, out) => {
    const writes = fields
      .filter((field) => Record.has(value, field.name))
      .map((field) => entry(writing(String), field.print, field.name, value[field.name]))
    for (const key of Record.keys(value)) {
      const signature = names.includes(key) ? undefined : indexed.find((s) => s.is(key))
      if (signature !== undefined) writes.push(entry(signature.key, signature.value, key, value[key]))
    }
    return writeAll(writes, grammar.separator ?? "", out)
  }
}

/** Writes a union's value with the first member it belongs to that can write it. */
const unionPrinter = (ast: SchemaAST.Union, ctx: Context<Printer>): Printer => {
  if (plainLiterals(ast) !== undefined) return writing(String)
  const members = ast.types.map((member) => ({
    is: Schema.is(Schema.make<Schema.Top>(SchemaAST.toType(member))),
    print: printerOf(member, ctx)
  }))
  return (value, out) => {
    let issue: SchemaIssue.Issue | undefined
    for (const member of members) {
      if (!member.is(value)) continue
      const mark = out.length
      issue = member.print(value, out)
      if (issue === undefined) return undefined
      out.length = mark
    }
    return issue ?? unwritable(ctx, "No member of the union can write this value", value)
  }
}
