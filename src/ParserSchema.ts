/**
 * Effect `Schema`s and parsers, in both directions.
 *
 * {@link make} turns a parser over strings into a schema that decodes a
 * `string` into the parser's output. Parse errors become schema issues
 * carrying the rendered `ParseError` message. Encoding needs a printer,
 * supplied as `encode`; without one, encoding is forbidden.
 *
 * {@link toParser} goes the other way: it derives a parser from a schema,
 * guided by `parser` annotations ({@link annotate}) that say how each part is
 * written, and {@link fromSchema} wraps the derived parser as a schema.
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

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /**
       * How the schema is written as text, read by
       * `ParserSchema.toParser`: a parser for the schema's type, or a
       * `ParserSchema.Grammar`.
       */
      readonly parser?: Annotation<any> | undefined
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

const decodeWith = <T extends Schema.Top>(
  target: T,
  parser: Parser<T["Encoded"], unknown, never, string>,
  encode: ((value: T["Encoded"]) => string) | undefined
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
        encode: (value, parseOptions) =>
          encode !== undefined
            ? Effect.succeed(encode(value))
            : Effect.fail(new SchemaIssue.Forbidden({ message: "Encoding is not supported" }, value, parseOptions))
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
    options?.encode
  )

// -----------------------------------------------------------------------------
// Deriving parsers from schemas
// -----------------------------------------------------------------------------

/**
 * How a schema is written as text, given in a `parser` annotation and read by
 * {@link toParser}. Every field is optional; a schema without one is parsed
 * as described on {@link toParser}.
 *
 * @since 0.3.0
 * @category models
 */
export interface Grammar<A = unknown> {
  /**
   * Parses the schema's type outright, replacing what {@link toParser} would
   * derive. Its output is still validated against the schema's type and
   * checks, and its failures' causes become `SchemaError`s with their message.
   */
  readonly parser?: Parser<A, unknown, never, string> | undefined
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
   * suffix and separators), and trailing whitespace is trimmed from
   * unannotated strings.
   * Inherited by the schemas inside it.
   */
  readonly whitespace?: boolean | undefined
}

/**
 * The value of a `parser` annotation: a {@link Grammar}, or a parser for the
 * schema's type (short for `{ parser }`).
 *
 * @since 0.3.0
 * @category models
 */
export type Annotation<A = unknown> = Grammar<A> | Parser<A, unknown, never, string>

/**
 * Annotates a schema with how it is written as text, for {@link toParser}.
 * The same as `schema.annotate({ parser: annotation })`, except that the
 * parser's output must have the schema's type.
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
  self.annotate({ parser: annotation })
)

/**
 * Derives a parser from a schema. The parser reads the text the schema's
 * `parser` annotations ({@link Grammar}) describe and returns a value of the
 * schema's type, which the schema's checks and transformations have already
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
  const parser = derive(ast, { stop: "", whitespace: false, inherit: undefined, path: [], recursions: [] })
  return grammarOf(ast).whitespace === true ? P.delimited(Ascii.multispace0, parser, Ascii.multispace0) : parser
}

/**
 * Creates a schema that decodes a string with the parser {@link toParser}
 * derives from `schema`, into `schema`'s type.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ParserSchema } from "@thomasfosterau/effect-parse"
 *
 * const Pair = ParserSchema.fromSchema(
 *   Schema.Tuple([Schema.String, Schema.Number]).pipe(ParserSchema.annotate({ separator: "=" })),
 *   { encode: ([key, value]) => `${key}=${value}` }
 * )
 *
 * Schema.decodeUnknownSync(Pair)("width=10") // ["width", 10]
 * Schema.encodeSync(Pair)(["height", 2]) // "height=2"
 * ```
 *
 * @since 0.3.0
 * @category constructors
 */
export const fromSchema = <S extends Schema.ConstraintDecoder<unknown> & Schema.Top>(
  schema: S,
  options?: { readonly encode?: ((value: S["Type"]) => string) | undefined }
): Schema.decodeTo<Schema.toType<S>, Schema.String> =>
  decodeWith<Schema.toType<S>>(Schema.toType(schema), toParser(schema), options?.encode)

type AnyParser = Parser<any, Schema.SchemaError, never, string>

type ForeignParser = Parser<unknown, unknown, never, string>

interface Context {
  /** Characters ending an unannotated string, sorted. */
  readonly stop: string
  readonly whitespace: boolean
  /** Grammar passed from a transformation to its encoded side. */
  readonly inherit: Grammar | undefined
  readonly path: ReadonlyArray<PropertyKey>
  /** The parsers of the recursive schemas met so far, by context. */
  readonly recursions: Array<Recursion>
}

interface Recursion {
  readonly ast: SchemaAST.Suspend
  readonly key: string
  readonly parser: AnyParser
}

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
  const value = lookup(ast, "parser")
  if (value === undefined) return {}
  // SAFETY: the `parser` annotation is typed `Annotation`, a parser or a grammar
  return P.isParser(value) ? { parser: value as ForeignParser } : (value as Grammar)
}

const withStop = (ctx: Context, text: string | undefined): Context => {
  if (text === undefined || text === "" || ctx.stop.includes(text[0])) return ctx
  return { ...ctx, stop: Arr.sort([...ctx.stop, text[0]], Order.String).join("") }
}

const at = (ctx: Context, key: PropertyKey): Context => ({ ...ctx, inherit: undefined, path: [...ctx.path, key] })

const where = (ctx: Context): string => `[${ctx.path.map(String).join(", ")}]`

const unsupported = (ast: SchemaAST.AST, ctx: Context): never => {
  throw new TypeError(
    `ParserSchema.toParser: cannot derive a parser for ${ast._tag} at ${where(ctx)}; annotate it with a parser`
  )
}

const schemaError = (issue: SchemaIssue.Issue) => new Schema.SchemaError(issue)

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

const decoder = (schema: Schema.ConstraintDecoder<unknown>) => Schema.decodeUnknownResult(schema)

/** Decodes into the type of `ast`, checks included. */
const typeDecoder = (ast: SchemaAST.AST) => decoder(Schema.make<Schema.Codec<unknown>>(SchemaAST.toType(ast)))

/** Literal text, with optional whitespace around it. */
const text = (s: string, ws: boolean): AnyParser =>
  ws ? P.delimited(Ascii.multispace0, Token.literal(s), Ascii.multispace0) : Token.literal(s)

const derive = (ast: SchemaAST.AST, ctx: Context): AnyParser => {
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
  const inner: Context = { ...withStop(ctx, grammar.suffix), whitespace, inherit: undefined }
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
const decoded = (ast: SchemaAST.AST, links: SchemaAST.Encoding, grammar: Grammar, ctx: Context): AnyParser => {
  const last = links[links.length - 1]
  const inherit: Grammar = { separator: grammar.separator, keySeparator: grammar.keySeparator }
  const from = derive(last.to, { ...ctx, inherit })
  // The same chain of links, ending at the type of the encoded side
  let target = SchemaAST.toType(ast)
  for (const link of links) {
    const source = link === last ? SchemaAST.toType(last.to) : link.to
    // SAFETY: `decodeTo` appends the link as it is, middleware included, as the schema's own links are
    target = SchemaAST.decodeTo(source, target, link.transformation as SchemaTransformation.Transformation<any, any>)
  }
  return P.tryMap(from, decoder(Schema.make<Schema.Codec<unknown>>(target)))
}

const structural = (ast: SchemaAST.AST, grammar: Grammar, ctx: Context): AnyParser =>
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
      grammar.keySeparator !== undefined || Arr.isReadonlyArrayNonEmpty(objects.indexSignatures)
        ? keyed(objects, grammar, ctx)
        : positional(objects, grammar, ctx),
    Union: (union) => alternatives(union, ctx),
    Suspend: (suspend) => recursion(suspend, ctx),
    Declaration: (other) => unsupported(other, ctx),
    Unknown: (other) => unsupported(other, ctx),
    Any: (other) => unsupported(other, ctx),
    Symbol: (other) => unsupported(other, ctx),
    UniqueSymbol: (other) => unsupported(other, ctx),
    ObjectKeyword: (other) => unsupported(other, ctx)
  })

const unannotatedString = (ctx: Context, min: number): AnyParser => {
  const s = Token.takeTill(ctx.stop, { min })
  return ctx.whitespace ? P.map(s, (value) => value.trimEnd()) : s
}

/** Whether a check (as `Schema.Int` has) restricts numbers to integers. */
const isIntegral = (checks: SchemaAST.Checks | undefined): boolean =>
  checks !== undefined &&
  checks.some((check) =>
    check instanceof SchemaAST.FilterGroup
      ? isIntegral(check.checks)
      : check.annotations?.arbitraryConstraint?.["number"] === "integer"
  )

const integer: AnyParser = /*#__PURE__*/ asSchemaErrors(Ascii.decInt)

type LiteralValue = SchemaAST.Literal["literal"]

const literal = (value: LiteralValue): AnyParser => P.as(Token.literal(String(value)), value)

/** Literals with the longest text first, so a literal is never cut short by one it starts with. */
const byLength = <A extends LiteralValue>(values: ReadonlyArray<A>): Array<A> =>
  Arr.sort(
    values,
    Order.mapInput(Order.Number, (value: A) => -String(value).length)
  )

const templateLiteral = (ast: SchemaAST.TemplateLiteral, ctx: Context): AnyParser =>
  P.taken(
    P.seq(
      ...ast.parts.map((part, i) => {
        const next = ast.parts[i + 1]
        const partCtx = next !== undefined && SchemaAST.isLiteral(next) ? withStop(ctx, String(next.literal)) : ctx
        // An interpolated string may be empty
        return SchemaAST.isString(part) && lookup(part, "parser") === undefined
          ? unannotatedString(partCtx, 0)
          : derive(part, at(partCtx, i))
      })
    )
  )

const isPlainLiteral = (ast: SchemaAST.AST): ast is SchemaAST.Literal =>
  SchemaAST.isLiteral(ast) && ast.encoding === undefined && lookup(ast, "parser") === undefined

const alternatives = (ast: SchemaAST.Union, ctx: Context): AnyParser => {
  const literals = Arr.filter(ast.types, isPlainLiteral)
  return literals.length === ast.types.length
    ? P.alt(...byLength(literals.map((member) => member.literal)).map(literal))
    : P.alt(...ast.types.map((member) => derive(member, ctx)))
}

/**
 * The parser of a recursive schema: deriving it again in the same context
 * gives the same parser, so the derivation ends.
 */
const recursion = (ast: SchemaAST.Suspend, ctx: Context): AnyParser => {
  const key = `${ctx.whitespace ? 1 : 0}${ctx.stop}`
  const known = ctx.recursions.find((r) => r.ast === ast && r.key === key)
  if (known !== undefined) return known.parser
  const parser = P.suspend(() => derive(ast.thunk(), ctx))
  ctx.recursions.push({ ast, key, parser })
  return parser
}

// -----------------------------------------------------------------------------
// Sequences: structs, tuples and arrays
// -----------------------------------------------------------------------------

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

/** The context for the items of a sequence: unannotated strings also stop at the separator. */
const itemContext = (grammar: Grammar, ctx: Context): Context => withStop(ctx, grammar.separator)

const separatorOf = (grammar: Grammar, ctx: Context): AnyParser | undefined =>
  grammar.separator === undefined ? undefined : text(grammar.separator, ctx.whitespace)

const sequenceOf = (ast: SchemaAST.Arrays, grammar: Grammar, ctx: Context): AnyParser => {
  const [head, ...after] = ast.rest
  // Elements after the rest would need the rest to stop short
  if (Arr.isReadonlyArrayNonEmpty(after)) return unsupported(ast, ctx)
  const n = ast.elements.length
  const items = ast.elements.map((element, i) => ({
    parser: derive(element, at(i < n - 1 || head !== undefined ? itemContext(grammar, ctx) : ctx, i)),
    optional: SchemaAST.isOptional(element)
  }))
  const rest = head === undefined ? undefined : derive(head, at(itemContext(grammar, ctx), n))
  // Optional elements come last, so the present values are the first ones
  return P.map(sequence(items, rest, separatorOf(grammar, ctx)), (out) => out.filter((_, i) => i in out))
}

const positional = (ast: SchemaAST.Objects, grammar: Grammar, ctx: Context): AnyParser => {
  const fields = ast.propertySignatures
  const items = fields.map((field, i) => ({
    parser: derive(field.type, at(i < fields.length - 1 ? itemContext(grammar, ctx) : ctx, field.name)),
    optional: SchemaAST.isOptional(field.type)
  }))
  return P.map(sequence(items, undefined, separatorOf(grammar, ctx)), (out) =>
    Record.fromEntries(fields.flatMap((field, i) => (i in out ? [[propertyName(field.name), out[i]] as const] : [])))
  )
}

const propertyName = (key: PropertyKey): string | symbol => (Predicate.isNumber(key) ? String(key) : key)

// -----------------------------------------------------------------------------
// Keyed: records, and structs with a key separator
// -----------------------------------------------------------------------------

type Entry = readonly [key: string | symbol, value: unknown, known: boolean]

const keyed = (ast: SchemaAST.Objects, grammar: Grammar, ctx: Context): AnyParser => {
  const keySeparator = grammar.keySeparator
  if (keySeparator === undefined) {
    throw new TypeError(`ParserSchema.toParser: a record at ${where(ctx)} needs a keySeparator in its annotation`)
  }
  const between = text(keySeparator, ctx.whitespace)
  const valueCtx = itemContext(grammar, ctx)
  const known = ast.propertySignatures.map((field): AnyParser => {
    const name = field.name
    if (!Predicate.isString(name)) return unsupported(ast, ctx)
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
