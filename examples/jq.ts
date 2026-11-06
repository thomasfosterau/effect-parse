/**
 * A subset of [jq](https://jqlang.org), the JSON processor, written with
 * effect-parse: the filter language is parsed with the Pratt `Expression`
 * parser, and the JSON input with the grammar of `json-fast.ts`, compiled.
 * `jq-cli.ts` puts it behind an `effect/cli` command, and
 * `bench/jq.bench.ts` races it against the real `jq`.
 *
 * Supported: `.`, `..`, `.foo`, `."foo"`, `.[e]`, `.[a:b]`, `.[]`, `?`,
 * `|`, `,`, `//`, `and`, `or`, comparisons, `+ - * / %`, unary `-`,
 * literals, `[…]`, `{…}` (with `{a}`, `{"a": …}` and `{(e): …}` keys),
 * `if … then … elif … else … end`, `try … catch …` and the common builtins
 * (`length`, `keys`, `map`, `select`, `sort_by`, `group_by`, `to_entries`,
 * …; see `builtins` below). Not supported: variables, `reduce`, `def`,
 * assignment, paths, regular expressions and string interpolation.
 *
 * Objects are plain JavaScript objects, so integer-like keys come out
 * first, where jq keeps input order.
 *
 * ```ts
 * const program = Jq.compile(".[] | select(.active) | .name")
 * Jq.run(program, '[{"name": "a", "active": true}]', { compact: true }).output // '"a"\n'
 * ```
 */
import * as Arr from "effect/Array"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Predicate from "effect/Predicate"
import { Compiler, Expression, Parser, Text } from "@thomasfosterau/effect-parse"
import { jsonGrammar } from "./json-fast.ts"
import type { Json } from "./json.ts"

// -----------------------------------------------------------------------------
// Syntax tree
// -----------------------------------------------------------------------------

/** A jq filter. */
export type Filter =
  | { readonly _tag: "Identity" }
  | { readonly _tag: "Recurse" }
  | { readonly _tag: "Literal"; readonly value: Json }
  | { readonly _tag: "Field"; readonly target: Filter; readonly name: string }
  | { readonly _tag: "Index"; readonly target: Filter; readonly index: Filter }
  | {
      readonly _tag: "Slice"
      readonly target: Filter
      readonly from: Filter | undefined
      readonly to: Filter | undefined
    }
  | { readonly _tag: "Iterate"; readonly target: Filter }
  | { readonly _tag: "Try"; readonly body: Filter; readonly handler: Filter | undefined }
  | { readonly _tag: "Pipe"; readonly left: Filter; readonly right: Filter }
  | { readonly _tag: "Comma"; readonly left: Filter; readonly right: Filter }
  | { readonly _tag: "Alternative"; readonly left: Filter; readonly right: Filter }
  | { readonly _tag: "And"; readonly left: Filter; readonly right: Filter }
  | { readonly _tag: "Or"; readonly left: Filter; readonly right: Filter }
  | { readonly _tag: "Binary"; readonly op: BinaryOp; readonly left: Filter; readonly right: Filter }
  | { readonly _tag: "Negate"; readonly body: Filter }
  | { readonly _tag: "Array"; readonly body: Filter | undefined }
  | { readonly _tag: "Object"; readonly entries: ReadonlyArray<readonly [Filter, Filter]> }
  | { readonly _tag: "If"; readonly cond: Filter; readonly ok: Filter; readonly otherwise: Filter }
  | { readonly _tag: "Call"; readonly name: string; readonly args: ReadonlyArray<Filter> }

/** The arithmetic and comparison operators. */
export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">="

const identity: Filter = { _tag: "Identity" }

// -----------------------------------------------------------------------------
// Filter parser
// -----------------------------------------------------------------------------

const T = Text.string

const ws = T.takeWhile(" \t\r\n")
const lexeme = <A, E>(p: Parser.Parser<A, E>) => Parser.terminated(p, ws)
const sym = <const L extends string>(s: L) => lexeme(T.literal(s))

const isIdentStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_"
const isIdentChar = (c: string) => isIdentStart(c) || (c >= "0" && c <= "9")
const identRaw = T.taken(Parser.preceded(T.takeWhile(isIdentStart, 1), T.takeWhile(isIdentChar)))
const keywords = new Set(["if", "then", "elif", "else", "end", "and", "or", "try", "catch"])
/** A field name after `.`: keywords are allowed there. */
const fieldName = Parser.alt(
  lexeme(identRaw),
  Parser.suspend(() => stringLit)
)
const ident = lexeme(identRaw.pipe(Parser.filter((name) => !keywords.has(name)))).pipe(Parser.expected("identifier"))
/** A keyword: the word, not the start of a longer identifier. */
const keyword = (word: string) =>
  lexeme(identRaw.pipe(Parser.filter((name) => name === word))).pipe(Parser.expected(`\`${word}\``))

const escapeChar = Parser.dispatch(T.any, {
  '"': Parser.succeed('"'),
  "\\": Parser.succeed("\\"),
  "/": Parser.succeed("/"),
  b: Parser.succeed("\b"),
  f: Parser.succeed("\f"),
  n: Parser.succeed("\n"),
  r: Parser.succeed("\r"),
  t: Parser.succeed("\t"),
  u: T.takeWhile("0123456789abcdefABCDEF", 4).pipe(Parser.map((h) => String.fromCharCode(parseInt(h, 16))))
}).pipe(Parser.expected("escape sequence"))

const stringLit = lexeme(
  Parser.preceded(
    T.literal('"'),
    Parser.cut(Parser.terminated(T.escaped(T.takeTill('"\\'), "\\", escapeChar), T.literal('"')))
  )
).pipe(Parser.context("string"))

const numberLit = lexeme(T.float)

const pipe: Parser.Parser<Filter> = Parser.suspend(() => filter)

/** `[e]`, `[]` or `[a:b]` after a term. */
const bracketSuffix: Parser.Parser<(target: Filter) => Filter> = Parser.preceded(
  sym("["),
  Parser.cut(
    Parser.alt(
      sym("]").pipe(Parser.as((target: Filter): Filter => ({ _tag: "Iterate", target }))),
      Parser.terminated(
        Parser.alt(
          Parser.preceded(
            sym(":"),
            pipe.pipe(
              Parser.map((to) => (target: Filter): Filter => ({ _tag: "Slice", target, from: undefined, to }))
            )
          ),
          Parser.zipWith(
            pipe,
            Parser.opt(Parser.preceded(sym(":"), Parser.optional(pipe))),
            (index, slice) =>
              (target: Filter): Filter =>
                Option.isNone(slice)
                  ? { _tag: "Index", target, index }
                  : { _tag: "Slice", target, from: index, to: slice.value }
          )
        ),
        sym("]")
      )
    )
  )
)

/** `.foo`, `."foo"` or `.[…]` after a term. */
const dotSuffix: Parser.Parser<(target: Filter) => Filter> = Parser.preceded(
  T.literal("."),
  Parser.alt(
    fieldName.pipe(
      Parser.map((name) => (target: Filter): Filter => ({ _tag: "Field", target, name }))
    ),
    bracketSuffix
  )
)

const optionalSuffix = sym("?").pipe(Parser.as((body: Filter): Filter => ({ _tag: "Try", body, handler: undefined })))

const args = Parser.delimited(sym("("), Parser.separated(pipe, sym(";"), { min: 1 }), Parser.cut(sym(")")))

const objectKey: Parser.Parser<readonly [Filter, Filter | undefined]> = Parser.alt(
  Parser.alt(ident, stringLit).pipe(
    Parser.map((name): readonly [Filter, Filter | undefined] => [
      { _tag: "Literal", value: name },
      { _tag: "Field", target: identity, name }
    ])
  ),
  Parser.delimited(sym("("), pipe, sym(")")).pipe(Parser.map((key) => [key, undefined] as const))
)

const objectValue: Parser.Parser<Filter> = Parser.suspend(() => entryValue)

const objectEntry = Parser.zipWith(
  objectKey,
  Parser.optional(Parser.preceded(sym(":"), Parser.cut(objectValue))),
  ([key, shorthand], value): readonly [Filter, Filter] => {
    if (value !== undefined) return [key, value]
    if (shorthand !== undefined) return [key, shorthand]
    return [key, key]
  }
)

/** After `if` or `elif`: the condition, the branch, and what follows it. */
const ifBody: Parser.Parser<Filter> = Parser.zipWith(
  Parser.zipWith(Parser.terminated(pipe, keyword("then")), pipe, (cond, then) => [cond, then] as const),
  Parser.alt(
    Parser.preceded(keyword("elif"), Parser.cut(Parser.suspend(() => ifBody))),
    Parser.delimited(keyword("else"), pipe, keyword("end")),
    keyword("end").pipe(Parser.as(identity))
  ),
  ([cond, ok], otherwise): Filter => ({ _tag: "If", cond, ok, otherwise })
)

const ifThen: Parser.Parser<Filter> = Parser.preceded(keyword("if"), Parser.cut(ifBody))

const tryCatch: Parser.Parser<Filter> = Parser.preceded(
  keyword("try"),
  Parser.cut(
    Parser.zipWith(
      Parser.suspend(() => postfixTerm),
      Parser.optional(
        Parser.preceded(
          keyword("catch"),
          Parser.suspend(() => postfixTerm)
        )
      ),
      (body, handler): Filter => ({ _tag: "Try", body, handler: handler ?? { _tag: "Call", name: "empty", args: [] } })
    )
  )
)

const term: Parser.Parser<Filter> = Parser.alt(
  sym("..").pipe(Parser.as<Filter>({ _tag: "Recurse" })),
  Parser.preceded(
    T.literal("."),
    Parser.alt(
      fieldName.pipe(Parser.map((name): Filter => ({ _tag: "Field", target: identity, name }))),
      bracketSuffix.pipe(Parser.map((suffix) => suffix(identity))),
      ws.pipe(Parser.as(identity))
    )
  ),
  numberLit.pipe(Parser.map((value): Filter => ({ _tag: "Literal", value }))),
  stringLit.pipe(Parser.map((value): Filter => ({ _tag: "Literal", value }))),
  Parser.delimited(sym("("), pipe, Parser.cut(sym(")"))),
  Parser.delimited(sym("["), Parser.optional(pipe), Parser.cut(sym("]"))).pipe(
    Parser.map((body): Filter => ({ _tag: "Array", body }))
  ),
  Parser.delimited(sym("{"), Parser.separated(objectEntry, sym(",")), Parser.cut(sym("}"))).pipe(
    Parser.map((entries): Filter => ({ _tag: "Object", entries }))
  ),
  ifThen,
  tryCatch,
  Parser.zipWith(ident, Parser.optional(args), (name, a): Filter => {
    if (a === undefined) {
      if (name === "null") return { _tag: "Literal", value: null }
      if (name === "true") return { _tag: "Literal", value: true }
      if (name === "false") return { _tag: "Literal", value: false }
    }
    return { _tag: "Call", name, args: a ?? [] }
  })
).pipe(Parser.expected("filter"))

/** A term and its suffixes: `.a.b[0][]?`. */
const postfixTerm: Parser.Parser<Filter> = Parser.zipWith(
  term,
  Parser.repeat(Parser.alt(dotSuffix, bracketSuffix, optionalSuffix)),
  (t, suffixes) => suffixes.reduce((acc, suffix) => suffix(acc), t)
)

const binary =
  (op: BinaryOp) =>
  (left: Filter, _: unknown, right: Filter): Filter => ({ _tag: "Binary", op, left, right })
const node =
  (tag: "Pipe" | "Comma" | "Alternative" | "And" | "Or") =>
  (left: Filter, _: unknown, right: Filter): Filter => ({ _tag: tag, left, right })

const operators = [
  Expression.prefix(sym("-"), 90, (_, body: Filter): Filter => ({ _tag: "Negate", body })),
  Expression.infixLeft(sym("*"), 80, binary("*")),
  Expression.infixLeft(lexeme(Parser.terminated(T.literal("/"), Parser.not(T.literal("/")))), 80, binary("/")),
  Expression.infixLeft(sym("%"), 80, binary("%")),
  Expression.infixLeft(sym("+"), 70, binary("+")),
  Expression.infixLeft(sym("-"), 70, binary("-")),
  Expression.infixLeft(sym("=="), 60, binary("==")),
  Expression.infixLeft(sym("!="), 60, binary("!=")),
  Expression.infixLeft(sym("<="), 60, binary("<=")),
  Expression.infixLeft(sym(">="), 60, binary(">=")),
  Expression.infixLeft(sym("<"), 60, binary("<")),
  Expression.infixLeft(sym(">"), 60, binary(">")),
  Expression.infixLeft(keyword("and"), 50, node("And")),
  Expression.infixLeft(keyword("or"), 40, node("Or")),
  Expression.infixRight(sym("//"), 30, node("Alternative"))
] as const

/**
 * The value of an object entry: anything but `,` at the top level (jq itself
 * accepts only terms and pipes of terms there; this is a superset).
 */
const entryValue: Parser.Parser<Filter> = Expression.make({
  operand: postfixTerm,
  operators: [...operators, Expression.infixRight(sym("|"), 10, node("Pipe"))]
})

const filter: Parser.Parser<Filter> = Expression.make({
  operand: postfixTerm,
  operators: [
    ...operators,
    Expression.infixLeft(sym(","), 20, node("Comma")),
    Expression.infixRight(sym("|"), 10, node("Pipe"))
  ]
})

/** A whole jq program, surrounded by optional whitespace. */
export const program: Parser.Parser<Filter> = Parser.delimited(ws, filter, Parser.eof)

/** Parses a jq program, throwing its `ParseError` on a syntax error. */
export const parseFilter = (source: string): Filter => Parser.parseSync(program, source)

// -----------------------------------------------------------------------------
// Evaluation
// -----------------------------------------------------------------------------

/** A jq runtime error, such as indexing a number. */
export class JqError extends Error {
  readonly value: Json
  constructor(value: Json) {
    super(Predicate.isString(value) ? value : JSON.stringify(value))
    this.value = value
  }
}

/** Carries an error raised downstream of a `try` through it unhandled. */
class Downstream {
  readonly error: unknown
  constructor(error: unknown) {
    this.error = error
  }
}

/** A compiled filter: calls `emit` once per output. */
type Fn = (input: Json, emit: (output: Json) => void) => void

const typeOf = (v: Json): string =>
  v === null
    ? "null"
    : typeof v === "boolean"
      ? "boolean"
      : typeof v === "number"
        ? "number"
        : typeof v === "string"
          ? "string"
          : Array.isArray(v)
            ? "array"
            : "object"

const typeRank: Record<string, number> = { null: 0, boolean: 1, number: 3, string: 4, array: 5, object: 6 }
const rank = (v: Json) => (v === false ? 1 : v === true ? 2 : typeRank[typeOf(v)])

const isArray = (v: Json): v is ReadonlyArray<Json> => Array.isArray(v)
const isObject = (v: Json): v is { readonly [key: string]: Json } =>
  v !== null && typeof v === "object" && !Array.isArray(v)

const compareScalars = (a: number | string, b: number | string): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0)

const compareArrays = (a: ReadonlyArray<Json>, b: ReadonlyArray<Json>): -1 | 0 | 1 => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const c = compare(a[i], b[i])
    if (c !== 0) return c
  }
  return compareScalars(a.length, b.length)
}

const compareObjects = (a: { readonly [key: string]: Json }, b: { readonly [key: string]: Json }): -1 | 0 | 1 => {
  const ka = Arr.sort(Object.keys(a), Order.String)
  const c = compareArrays(ka, Arr.sort(Object.keys(b), Order.String))
  if (c !== 0) return c
  for (const k of ka) {
    const d = compare(a[k], b[k])
    if (d !== 0) return d
  }
  return 0
}

/** jq's total order: null < false < true < numbers < strings < arrays < objects. */
export const compare: Order.Order<Json> = (a, b) => {
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra < rb ? -1 : 1
  // Same rank, so the same type: only the first value's type is tested
  if (typeof a === "number" || typeof a === "string") {
    // SAFETY: `b` has `a`'s rank, so `a`'s type
    const y = b as typeof a
    return compareScalars(a, y)
  }
  if (isArray(a)) {
    // SAFETY: `b` has `a`'s rank, so it is an array too
    const bs = b as ReadonlyArray<Json>
    return compareArrays(a, bs)
  }
  if (isObject(a)) {
    // SAFETY: `b` has `a`'s rank, so it is an object too
    const bo = b as { readonly [key: string]: Json }
    return compareObjects(a, bo)
  }
  return 0
}

const fail = (message: string): never => {
  throw new JqError(message)
}

const describe = (v: Json): string => {
  const text = JSON.stringify(v)
  return `${typeOf(v)} (${text.length > 11 ? `${text.slice(0, 10)}...` : text})`
}

const truthy = (v: Json) => v !== null && v !== false

const deepMerge = (a: { readonly [key: string]: Json }, b: { readonly [key: string]: Json }) => {
  const out: Record<string, Json> = { ...a }
  for (const k of Object.keys(b)) {
    const x = out[k]
    const y = b[k]
    out[k] = x !== undefined && isObject(x) && isObject(y) ? deepMerge(x, y) : y
  }
  return out
}

const cannot = (l: Json, r: Json, verb: string): never => fail(`${describe(l)} and ${describe(r)} cannot be ${verb}`)

const plus = (l: Json, r: Json): Json => {
  if (l === null) return r
  if (r === null) return l
  if (typeof l === "number" && typeof r === "number") return l + r
  if (typeof l === "string" && typeof r === "string") return l + r
  if (isArray(l) && isArray(r)) return [...l, ...r]
  if (isObject(l) && isObject(r)) return { ...l, ...r }
  return cannot(l, r, "added")
}

const minus = (l: Json, r: Json): Json => {
  if (typeof l === "number" && typeof r === "number") return l - r
  if (isArray(l) && isArray(r)) return l.filter((x) => !r.some((y) => compare(x, y) === 0))
  return cannot(l, r, "subtracted")
}

const times = (l: Json, r: Json): Json => {
  if (typeof l === "number" && typeof r === "number") return l * r
  if (isObject(l) && isObject(r)) return deepMerge(l, r)
  if (typeof l === "string" && typeof r === "number") return l.repeat(Math.max(0, Math.ceil(r)))
  return cannot(l, r, "multiplied")
}

const divide = (l: Json, r: Json): Json => {
  if (typeof l === "string" && typeof r === "string") return l.split(r)
  if (typeof l !== "number" || typeof r !== "number") return cannot(l, r, "divided")
  return r === 0 ? cannot(l, r, "divided because the divisor is zero") : l / r
}

const modulo = (l: Json, r: Json): Json => {
  if (typeof l !== "number" || typeof r !== "number") return cannot(l, r, "divided")
  const d = Math.trunc(r)
  return d === 0 ? cannot(l, r, "divided because the divisor is zero") : Math.trunc(l) % d
}

/** The binary operators: jq's arithmetic, and comparisons in its order. */
const binaryOps: { readonly [Op in BinaryOp]: (l: Json, r: Json) => Json } = {
  "==": (l, r) => compare(l, r) === 0,
  "!=": (l, r) => compare(l, r) !== 0,
  "<": (l, r) => compare(l, r) < 0,
  "<=": (l, r) => compare(l, r) <= 0,
  ">": (l, r) => compare(l, r) > 0,
  ">=": (l, r) => compare(l, r) >= 0,
  "+": plus,
  "-": minus,
  "*": times,
  "/": divide,
  "%": modulo
}

const indexArray = (target: ReadonlyArray<Json>, key: number): Json => {
  const i = Math.floor(key)
  return target[i < 0 ? target.length + i : i] ?? null
}

const index = (target: Json, key: Json): Json => {
  if (target === null) return null
  if (typeof key === "string" && isObject(target)) return Object.hasOwn(target, key) ? target[key] : null
  if (typeof key === "number" && isArray(target)) return indexArray(target, key)
  return fail(`Cannot index ${typeOf(target)} with ${typeof key === "string" ? `"${key}"` : typeOf(key)}`)
}

const slice = (target: Json, from: Json, to: Json): Json => {
  if (target === null) return null
  if (!isArray(target) && typeof target !== "string") return fail(`Cannot index ${typeOf(target)} with object`)
  const len = target.length
  const clamp = (v: Json, dflt: number) => {
    if (v === null) return dflt
    if (typeof v !== "number") return fail("Start and end indices of an array slice must be numbers")
    const i = Math.floor(v)
    return Math.max(0, Math.min(len, i < 0 ? len + i : i))
  }
  return target.slice(clamp(from, 0), clamp(to, len))
}

const iterate = (v: Json, emit: (output: Json) => void) => {
  if (isArray(v)) {
    for (let i = 0; i < v.length; i++) emit(v[i])
  } else if (isObject(v)) {
    for (const k in v) emit(v[k])
  } else {
    fail(`Cannot iterate over ${describe(v)}`)
  }
}

const recurse = (v: Json, emit: (output: Json) => void) => {
  emit(v)
  if (isArray(v)) for (const x of v) recurse(x, emit)
  else if (isObject(v)) for (const k in v) recurse(v[k], emit)
}

const length = (v: Json): Json => {
  if (v === null) return 0
  if (typeof v === "boolean") return fail(`boolean (${v}) has no length`)
  if (typeof v === "number") return Math.abs(v)
  if (typeof v === "string") {
    let n = 0
    for (const _ of v) n++
    return n
  }
  return isArray(v) ? v.length : Object.keys(v).length
}

const keysOf = (v: Json, sorted: boolean): Json => {
  if (isArray(v)) return v.map((_, i) => i)
  if (isObject(v)) return sorted ? Arr.sort(Object.keys(v), Order.String) : Object.keys(v)
  return fail(`${describe(v)} has no keys`)
}

const add = (v: Json): Json => {
  let acc: Json = null
  iterate(v, (x) => {
    acc = plus(acc, x)
  })
  return acc
}

const toEntries = (v: Json): Json => {
  if (!isObject(v)) return fail(`${describe(v)} has no keys`)
  return Object.keys(v).map((key) => ({ key, value: v[key] }))
}

/** An entry's key, under any of the names `from_entries` accepts, as a string. */
const entryKey = (e: { readonly [key: string]: Json }): string => {
  const k = e.key ?? e.k ?? e.name ?? e.Name ?? e.K ?? e.Key ?? null
  if (typeof k === "string") return k
  if (typeof k === "number" || typeof k === "boolean") return String(k)
  return fail(`Cannot use ${describe(k)} as object key`)
}

const fromEntries = (v: Json): Json => {
  const out: Record<string, Json> = {}
  iterate(v, (e) => {
    if (!isObject(e)) return fail(`Cannot index ${typeOf(e)} with "key"`)
    out[entryKey(e)] = e.value ?? e.v ?? e.Value ?? e.V ?? null
  })
  return out
}

interface Keyed {
  readonly x: Json
  readonly key: Json
}

const byKey: Order.Order<Keyed> = Order.mapInput(compare, (e: Keyed) => e.key)

/** The elements of an array with their keys, sorted (stably) by key. */
const sortKeyed = (v: Json, keyOf: (x: Json) => Json): ReadonlyArray<Keyed> => {
  if (!isArray(v)) return fail(`${describe(v)} cannot be sorted, as it is not an array`)
  return Arr.sort(
    v.map((x) => ({ x, key: keyOf(x) })),
    byKey
  )
}

/** Sorts by a key of each element, stably. */
const sortBy = (v: Json, keyOf: (x: Json) => Json): Array<Json> => sortKeyed(v, keyOf).map((e) => e.x)

const collect = (f: Fn, input: Json): Array<Json> => {
  const out: Array<Json> = []
  f(input, (x) => {
    out.push(x)
  })
  return out
}

/** The outputs of `f` gathered into an array: jq's `[f]` used as a sort key. */
const keyFn = (f: Fn) => (x: Json) => collect(f, x)

const flatten = (v: Json, depth: number): Array<Json> => {
  if (!isArray(v)) return fail(`Cannot flatten ${typeOf(v)}`)
  const out: Array<Json> = []
  for (const x of v) {
    if (isArray(x) && depth > 0) out.push(...flatten(x, depth - 1))
    else out.push(x)
  }
  return out
}

const tostring = (v: Json): string => (typeof v === "string" ? v : JSON.stringify(v))

const numeric =
  (f: (n: number) => number, message = "number required") =>
  (v: Json): Json =>
    typeof v === "number" ? f(v) : fail(`${describe(v)} ${message}`)

const textual =
  (f: (s: string) => Json, message: string) =>
  (v: Json): Json =>
    typeof v === "string" ? f(v) : fail(`${describe(v)} ${message}`)

const reverse = (v: Json): Json => {
  if (v === null) return []
  if (typeof v === "string") return Array.from(v).reverse().join("")
  return isArray(v) ? [...v].reverse() : fail(`Cannot reverse ${typeOf(v)}`)
}

const tonumber = (v: Json): Json => {
  if (typeof v === "number") return v
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : NaN
  return Number.isNaN(n) ? fail(`Cannot parse ${describe(v)} as JSON`) : n
}

const arrayOf =
  (f: (a: ReadonlyArray<Json>) => Json, message: string) =>
  (v: Json): Json =>
    isArray(v) ? f(v) : fail(`${describe(v)} ${message}`)

/** Builtins of no arguments: one output per input. */
const simple: Record<string, (v: Json) => Json> = {
  length,
  utf8bytelength: textual((s) => new TextEncoder().encode(s).length, "only strings have UTF-8 byte length"),
  not: (v) => !truthy(v),
  keys: (v) => keysOf(v, true),
  keys_unsorted: (v) => keysOf(v, false),
  add,
  type: typeOf,
  sort: (v) => sortBy(v, (x) => x),
  unique: (v) => sortBy(v, (x) => x).filter((x, i, a) => i === 0 || compare(a[i - 1], x) !== 0),
  reverse,
  min: arrayOf((a) => sortBy(a, (x) => x)[0] ?? null, "has no minimum"),
  max: arrayOf((a) => sortBy(a, (x) => x).at(-1) ?? null, "has no maximum"),
  first: (v) => index(v, 0),
  last: (v) => index(v, -1),
  floor: numeric(Math.floor),
  ceil: numeric(Math.ceil),
  round: numeric(Math.round),
  sqrt: numeric(Math.sqrt),
  abs: numeric(Math.abs, "has no absolute value"),
  tostring,
  tonumber,
  tojson: (v) => JSON.stringify(v),
  fromjson: textual((s) => parseJson(s)[0] ?? null, "cannot be parsed as JSON"),
  ascii_downcase: textual((s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase()), "cannot be lowercased"),
  ascii_upcase: textual((s) => s.replace(/[a-z]/g, (c) => c.toUpperCase()), "cannot be uppercased"),
  to_entries: toEntries,
  from_entries: fromEntries,
  flatten: (v) => flatten(v, Infinity),
  any: arrayOf((a) => a.some(truthy), "cannot be iterated over"),
  all: arrayOf((a) => a.every(truthy), "cannot be iterated over"),
  isnan: (v) => (typeof v === "number" ? Number.isNaN(v) : fail(`${describe(v)} number required`)),
  infinite: () => Infinity,
  nan: () => NaN,
  null: () => null
}

/** `arrays`, `objects`, …: the input if it is of the type, else nothing. */
const typeFilters: Record<string, (v: Json) => boolean> = {
  arrays: isArray,
  objects: isObject,
  iterables: (v) => isArray(v) || isObject(v),
  scalars: (v) => !isArray(v) && !isObject(v),
  strings: Predicate.isString,
  numbers: Predicate.isNumber,
  booleans: Predicate.isBoolean,
  nulls: (v) => v === null,
  values: (v) => v !== null
}

/** Calls `emit` with `fn(x)` for each output `x` of the argument. */
const unary =
  (fn: (input: Json, x: Json) => Json) =>
  ([arg]: ReadonlyArray<Fn>): Fn =>
  (input, emit) =>
    arg(input, (x) => emit(fn(input, x)))

/** A builtin over two strings: the input and each output of its argument. */
const strings = (name: string, fn: (s: string, t: string) => Json) =>
  unary((v, x) =>
    typeof v === "string" && typeof x === "string" ? fn(v, x) : fail(`${name}() requires string inputs`)
  )

/** Collects the outputs of `f` for each element of the input. */
const mapAll = (f: Fn, input: Json): Array<Json> => {
  const out: Array<Json> = []
  iterate(input, (x) =>
    f(x, (y) => {
      out.push(y)
    })
  )
  return out
}

const mapValues =
  ([f]: ReadonlyArray<Fn>): Fn =>
  (input, emit) => {
    const first = (x: Json) => collect(f, x).slice(0, 1)
    if (isArray(input)) return emit(input.flatMap(first))
    if (!isObject(input)) return fail(`Cannot iterate over ${describe(input)}`)
    const out: Record<string, Json> = {}
    for (const k in input) for (const y of first(input[k])) out[k] = y
    emit(out)
  }

const groupBy =
  ([f]: ReadonlyArray<Fn>): Fn =>
  (input, emit) => {
    const groups: Array<Array<Json>> = []
    const sorted = sortKeyed(input, keyFn(f))
    sorted.forEach((e, i) => {
      if (i > 0 && compare(sorted[i - 1].key, e.key) === 0) groups[groups.length - 1].push(e.x)
      else groups.push([e.x])
    })
    emit(groups)
  }

const uniqueBy =
  ([f]: ReadonlyArray<Fn>): Fn =>
  (input, emit) => {
    const sorted = sortKeyed(input, keyFn(f))
    emit(sorted.filter((e, i) => i === 0 || compare(sorted[i - 1].key, e.key) !== 0).map((e) => e.x))
  }

/** `any(f)` and `all(f)`: whether `f` is truthy for some or every element. */
const quantifier =
  (every: boolean) =>
  ([f]: ReadonlyArray<Fn>): Fn =>
  (input, emit) => {
    let result = every
    iterate(input, (x) =>
      f(x, (y) => {
        if (truthy(y) !== every) result = !every
      })
    )
    emit(result)
  }

const range = (from: Json, to: Json, emit: (output: Json) => void) => {
  if (typeof from !== "number" || typeof to !== "number") return fail("Range bounds must be numeric")
  for (let i = from; i < to; i++) emit(i)
}

const joinPart = (x: Json): string => {
  if (x === null) return ""
  if (typeof x === "object") return fail(`Cannot join with ${typeOf(x)}`)
  return typeof x === "string" ? x : String(x)
}

const join = (input: Json, sep: Json): Json => {
  if (!isArray(input)) return fail(`Cannot iterate over ${describe(input)}`)
  if (typeof sep !== "string") return fail(`${describe(sep)} cannot be used as a separator`)
  return input.map(joinPart).join(sep)
}

/** The builtins that take arguments, by `name/arity`; each gets its compiled arguments. */
const builtins: Record<string, (args: ReadonlyArray<Fn>) => Fn> = {
  "empty/0": () => () => {},
  "error/0": () => (input) => {
    throw new JqError(input)
  },
  "error/1":
    ([f]) =>
    (input) =>
      f(input, (x) => {
        throw new JqError(x)
      }),
  "recurse/0": () => recurse,
  "recurse/1":
    ([f]) =>
    (input, emit) => {
      const go = (v: Json) => {
        emit(v)
        f(v, go)
      }
      go(input)
    },
  "select/1":
    ([f]) =>
    (input, emit) =>
      f(input, (x) => {
        if (truthy(x)) emit(input)
      }),
  "map/1":
    ([f]) =>
    (input, emit) =>
      emit(mapAll(f, input)),
  "map_values/1": mapValues,
  "with_entries/1":
    ([f]) =>
    (input, emit) =>
      emit(fromEntries(mapAll(f, toEntries(input)))),
  "has/1": unary((input, k) => {
    if (isObject(input) && typeof k === "string") return Object.hasOwn(input, k)
    if (isArray(input) && typeof k === "number") return k >= 0 && k < input.length
    return fail(`Cannot check whether ${typeOf(input)} has a ${typeOf(k)} key`)
  }),
  "sort_by/1":
    ([f]) =>
    (input, emit) =>
      emit(sortBy(input, keyFn(f))),
  "group_by/1": groupBy,
  "unique_by/1": uniqueBy,
  "min_by/1":
    ([f]) =>
    (input, emit) =>
      emit(sortBy(input, keyFn(f))[0] ?? null),
  "max_by/1":
    ([f]) =>
    (input, emit) =>
      emit(sortBy(input, keyFn(f)).at(-1) ?? null),
  "any/1": quantifier(false),
  "all/1": quantifier(true),
  "first/1":
    ([f]) =>
    (input, emit) =>
      collect(f, input).slice(0, 1).forEach(emit),
  "last/1":
    ([f]) =>
    (input, emit) =>
      collect(f, input).slice(-1).forEach(emit),
  "limit/2":
    ([f, g]) =>
    (input, emit) =>
      f(input, (n) => {
        if (typeof n !== "number") return fail("Invalid limit: must be a number")
        collect(g, input).slice(0, Math.max(0, n)).forEach(emit)
      }),
  "range/1":
    ([f]) =>
    (input, emit) =>
      f(input, (n) => range(0, n, emit)),
  "range/2":
    ([f, g]) =>
    (input, emit) =>
      f(input, (from) => g(input, (to) => range(from, to, emit))),
  "flatten/1": unary((input, d) =>
    typeof d === "number" && d >= 0 ? flatten(input, d) : fail("flatten depth must not be negative")
  ),
  "join/1": unary(join),
  "split/1": strings("split", (s, t) => (s === "" ? [] : s.split(t))),
  "startswith/1": strings("startswith", (s, t) => s.startsWith(t)),
  "endswith/1": strings("endswith", (s, t) => s.endsWith(t)),
  "ltrimstr/1": unary((input, x) =>
    typeof input === "string" && typeof x === "string" && input.startsWith(x) ? input.slice(x.length) : input
  ),
  "rtrimstr/1": unary((input, x) =>
    typeof input === "string" && typeof x === "string" && x !== "" && input.endsWith(x)
      ? input.slice(0, input.length - x.length)
      : input
  )
}

const builtin = (name: string, args: ReadonlyArray<Fn>): Fn => {
  const key = `${name}/${args.length}`
  const make = builtins[key]
  if (make !== undefined) return make(args)
  const fn = args.length === 0 ? simple[name] : undefined
  if (fn !== undefined) return (input, emit) => emit(fn(input))
  const is = args.length === 0 ? typeFilters[name] : undefined
  if (is === undefined) return fail(`${key} is not defined`)
  return (input, emit) => {
    if (is(input)) emit(input)
  }
}

const optional = (f: Filter | undefined): Fn => (f === undefined ? (_, emit) => emit(null) : compileFilter(f))

/** Runs `body`, handing its errors (but not those raised downstream) to `handler`. */
const tryFn =
  (body: Fn, handler: Fn | undefined): Fn =>
  (input, emit) => {
    try {
      body(input, (x) => {
        try {
          emit(x)
        } catch (error) {
          throw new Downstream(error)
        }
      })
    } catch (error) {
      if (error instanceof Downstream) throw error.error
      if (!(error instanceof JqError)) throw error
      if (handler !== undefined) handler(error.value, emit)
    }
  }

/** `left // right`: the truthy outputs of `left`, or if there are none, `right`'s. */
const alternative =
  (left: Fn, right: Fn): Fn =>
  (input, emit) => {
    let any = false
    try {
      left(input, (x) => {
        if (truthy(x)) {
          any = true
          emit(x)
        }
      })
    } catch (error) {
      if (!(error instanceof JqError)) throw error
    }
    if (!any) right(input, emit)
  }

/** `{k: v, …}`: one object per combination of the entries' outputs. */
const object =
  (entries: ReadonlyArray<readonly [Fn, Fn]>): Fn =>
  (input, emit) => {
    const go = (i: number, acc: Record<string, Json>) => {
      if (i === entries.length) return emit({ ...acc })
      const [key, value] = entries[i]
      key(input, (k) => {
        if (typeof k !== "string") return fail(`Object keys must be strings`)
        value(input, (v) => {
          acc[k] = v
          go(i + 1, acc)
          delete acc[k]
        })
      })
    }
    go(0, {})
  }

/** Applies `fn` to each output of `target`. */
const onTarget = (target: Filter, fn: (t: Json, emit: (output: Json) => void) => void): Fn => {
  if (target._tag === "Identity") return fn
  const t = compileFilter(target)
  return (input, emit) => t(input, (x) => fn(x, emit))
}

type Compilers = { readonly [Tag in Filter["_tag"]]: (f: Extract<Filter, { readonly _tag: Tag }>) => Fn }

/** How each kind of filter compiles. */
const compilers: Compilers = {
  Identity: () => (input, emit) => emit(input),
  Recurse: () => recurse,
  Literal:
    ({ value }) =>
    (_, emit) =>
      emit(value),
  Field: ({ target, name }) => onTarget(target, (t, emit) => emit(index(t, name))),
  Index: (f) => {
    const target = compileFilter(f.target)
    const key = compileFilter(f.index)
    return (input, emit) => target(input, (t) => key(input, (k) => emit(index(t, k))))
  },
  Slice: (f) => {
    const target = compileFilter(f.target)
    const from = optional(f.from)
    const to = optional(f.to)
    return (input, emit) => target(input, (t) => to(input, (b) => from(input, (a) => emit(slice(t, a, b)))))
  },
  Iterate: ({ target }) => onTarget(target, iterate),
  Try: (f) => tryFn(compileFilter(f.body), f.handler === undefined ? undefined : compileFilter(f.handler)),
  Pipe: (f) => {
    const left = compileFilter(f.left)
    const right = compileFilter(f.right)
    return (input, emit) => left(input, (x) => right(x, emit))
  },
  Comma: (f) => {
    const left = compileFilter(f.left)
    const right = compileFilter(f.right)
    return (input, emit) => {
      left(input, emit)
      right(input, emit)
    }
  },
  Alternative: (f) => alternative(compileFilter(f.left), compileFilter(f.right)),
  And: (f) => {
    const left = compileFilter(f.left)
    const right = compileFilter(f.right)
    return (input, emit) => left(input, (l) => (truthy(l) ? right(input, (r) => emit(truthy(r))) : emit(false)))
  },
  Or: (f) => {
    const left = compileFilter(f.left)
    const right = compileFilter(f.right)
    return (input, emit) => left(input, (l) => (truthy(l) ? emit(true) : right(input, (r) => emit(truthy(r)))))
  },
  Binary: (f) => {
    const left = compileFilter(f.left)
    const right = compileFilter(f.right)
    const op = binaryOps[f.op]
    return (input, emit) => right(input, (r) => left(input, (l) => emit(op(l, r))))
  },
  Negate: (f) => {
    const body = compileFilter(f.body)
    return (input, emit) =>
      body(input, (x) => emit(typeof x === "number" ? -x : fail(`${describe(x)} cannot be negated`)))
  },
  Array: (f) => {
    if (f.body === undefined) return (_, emit) => emit([])
    const body = compileFilter(f.body)
    return (input, emit) => emit(collect(body, input))
  },
  Object: (f) => object(f.entries.map(([k, v]) => [compileFilter(k), compileFilter(v)] as const)),
  If: (f) => {
    const cond = compileFilter(f.cond)
    const ok = compileFilter(f.ok)
    const otherwise = compileFilter(f.otherwise)
    return (input, emit) => cond(input, (c) => (truthy(c) ? ok(input, emit) : otherwise(input, emit)))
  },
  Call: (f) => builtin(f.name, f.args.map(compileFilter))
}

/** Compiles a syntax tree to a function of an input and a callback. */
export const compileFilter = (f: Filter): Fn =>
  // SAFETY: `compilers[f._tag]` is the compiler for filters tagged `f._tag`, which `f` is
  (compilers[f._tag] as (f: Filter) => Fn)(f)

// -----------------------------------------------------------------------------
// Input and output
// -----------------------------------------------------------------------------

/** How the JSON input is parsed: the interpreter, or one of the compilers. */
export type Backend = "interpreted" | "closure" | "jit" | "wasm"

/** A stream of JSON values separated by optional whitespace, as jq reads. */
const values = <I extends string | Uint8Array>(T: Text.TextParsers<I>) =>
  Parser.terminated(Parser.repeat(jsonGrammar(T)), Parser.eof)

const compiled = <A, E, R, I extends string | Uint8Array>(p: Parser.Parser<A, E, R, I>, backend: Backend) =>
  backend === "jit"
    ? Compiler.jit(p)
    : backend === "wasm"
      ? Compiler.wasm(p)
      : backend === "closure"
        ? Compiler.closure(p)
        : p

const stringParsers: Partial<Record<Backend, Parser.Parser<ReadonlyArray<Json>>>> = {}
const utf8Parsers: Partial<Record<Backend, Parser.Parser<ReadonlyArray<Json>, never, never, Uint8Array>>> = {}

/** Parses a stream of JSON values from text or UTF-8 bytes. */
export const parseJson = (input: string | Uint8Array, backend: Backend = "jit"): ReadonlyArray<Json> => {
  if (Predicate.isString(input)) {
    const p = (stringParsers[backend] ??= compiled(Parser.named(values(Text.string), "json"), backend))
    return Parser.parseSync(p, input)
  }
  const p = (utf8Parsers[backend] ??= compiled(Parser.named(values(Text.utf8), "json"), backend))
  return Parser.parseSync(p, input)
}

/** jq's output options. */
export interface Options {
  /** `-c`: one value per line, with no whitespace. */
  readonly compact?: boolean | undefined
  /** `-r`: strings printed without quotes. */
  readonly raw?: boolean | undefined
  /** `-n`: run the filter once, on `null`, ignoring the input. */
  readonly nullInput?: boolean | undefined
  /** `-s`: run the filter once, on an array of all the inputs. */
  readonly slurp?: boolean | undefined
  /** `--tab`: indent with tabs. */
  readonly tab?: boolean | undefined
  /** `--indent n`: indent with `n` spaces (default 2). */
  readonly indent?: number | undefined
  /** How the JSON input is parsed (default `jit`). */
  readonly backend?: Backend | undefined
}

/** A parsed and compiled jq program. */
export interface Program {
  readonly filter: Filter
  readonly fn: Fn
}

/** Parses and compiles a jq program. */
export const compile = (source: string): Program => {
  const filter = parseFilter(source)
  return { filter, fn: compileFilter(filter) }
}

/** What a run printed: its outputs, and the runtime errors jq would report on standard error. */
export interface Output {
  /** One output per line, as jq prints them. */
  readonly output: string
  /** One message per input whose filter failed: jq prints what came before, then moves on. */
  readonly errors: ReadonlyArray<string>
}

/** Runs a program over a stream of JSON values, as jq does. */
export const run = (program: Program, input: string | Uint8Array, options: Options = {}): Output => {
  const indent = options.tab ? "\t" : options.compact ? undefined : " ".repeat(options.indent ?? 2)
  const out: Array<string> = []
  const errors: Array<string> = []
  const emit = (v: Json) => {
    out.push(options.raw && typeof v === "string" ? v : (JSON.stringify(v, null, indent) ?? "null"))
  }
  const apply = (v: Json) => {
    try {
      program.fn(v, emit)
    } catch (error) {
      if (!(error instanceof JqError)) throw error
      errors.push(`jq: error: ${error.message}`)
    }
  }
  if (options.nullInput) {
    apply(null)
  } else {
    const inputs = parseJson(input, options.backend)
    if (options.slurp) apply(inputs)
    else for (const v of inputs) apply(v)
  }
  return { output: out.length === 0 ? "" : `${out.join("\n")}\n`, errors }
}
