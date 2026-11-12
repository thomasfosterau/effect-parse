/**
 * Differential tests: compiled parsers must give exactly the interpreter's
 * results, values and errors alike, on valid, invalid and truncated input.
 */
import * as Arr from "effect/Array"
import * as Predicate from "effect/Predicate"
import * as Context from "effect/Context"
import * as Formatter from "effect/Formatter"
import * as Record from "effect/Record"

import * as Option from "effect/Option"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { assert, describe, expect, it, onTestFinished, vi } from "vite-plus/test"

import * as Arithmetic from "../examples/arithmetic.js"
import * as Http from "../examples/http.js"
import * as Ini from "../examples/ini.js"
import * as Json from "../examples/json.js"
import * as JsonFast from "../examples/json-fast.js"
import { jsonGrammar } from "../examples/json-text.js"
import * as Sexpr from "../examples/sexpr.js"
import {
  Ascii,
  Binary,
  Bits,
  Compiler,
  Encoding,
  Expression,
  Input,
  Nom,
  Parser,
  ParserSchema,
  ParserStream,
  Text,
  Token
} from "../src/index.js"
import { State } from "../src/Input.js"
import { Fail } from "../src/Input.js"
import { FirstSets } from "../src/internal/compiler/first.js"
import * as Registry from "../src/internal/compiler/registry.js"
import { allStrings, mutations, randomJson, rng } from "./generators.js"
import { defined, expectFailure, runOfAs } from "./utils.js"

const backends = ["closure", "jit", "wasm"] as const
type Backend = (typeof backends)[number]

/** A text backend under test: its name, its parsers, and how to encode a string for it. */
type TextBackend = [name: string, T: Text.TextParsers<any>, encode: (s: string) => Input.Input]

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

const errorFields = (e: any) => ({
  offset: e.offset,
  kind: e.kind,
  mode: e.mode,
  expected: e.expected,
  context: e.context,
  cause: e.cause,
  description: e.description,
  message: e.message
})

const outcome = (r: Result.Result<unknown, any>) =>
  Result.isSuccess(r) ? { ok: true, value: r.success } : { ok: false, error: errorFields(r.failure) }

const compiledCopy: Record<Backend, WeakMap<Parser.Parser.Any, Parser.Parser.Any>> = {
  closure: new WeakMap(),
  jit: new WeakMap(),
  wasm: new WeakMap()
}
const backendOf = new WeakMap<Parser.Parser.Any, Backend>()

/** A compiled twin of `p` (with the same description), leaving `p` interpreted. */
const twin = <P extends Parser.Parser.Any>(p: P, backend: Backend): P => {
  const byParser = compiledCopy[backend]
  let c = byParser.get(p)
  if (c === undefined) {
    c = Compiler[backend](Parser.named(p, p.name ?? "root"))
    byParser.set(p, c)
    backendOf.set(c, backend)
  }
  // SAFETY: `c` is `Compiler[backend](Parser.named(p, …))`, which has `p`'s
  // type; only the cache erases it to `Parser.Any`.
  return c as P
}

/** Whether `s` has a character outside Latin-1, which `Text.latin1` cannot encode. */
const beyondLatin1 = (s: string): boolean => Array.from(s).some((c) => (c.codePointAt(0) ?? 0) > 0xff)

/** Runs the compiled step alone, to catch compiled failures that the fallback would hide. */
const fast = (p: Parser.Parser.Any, input: Input.Input, context?: Context.Context<any>) => {
  const state = new State(input, { context })
  const step = defined(Registry.stepFor(p, state))
  const kind = state.inputKind
  const compiled = defined(Registry.compiled(p, kind))
  if (compiled.error !== undefined) throw compiled.error
  if (compiled.jitError !== undefined) throw compiled.jitError
  if (compiled.wasmError !== undefined) throw compiled.wasmError
  if (backendOf.get(p) === "jit") assert.strictEqual(compiled.backend, "jit")
  if (backendOf.get(p) === "wasm") assert.strictEqual(compiled.backend, kind === 2 ? "jit" : "wasm")
  const a = step(state)
  return a === Fail ? undefined : { value: a, pos: state.pos, end: state.end }
}

/**
 * One step on a fresh state, interpreted (`step`) or with a resumable
 * compiled build: the value and position, or the failure mode.
 */
const stepOutcome = (
  step: Parser.Parser.Any["step"] | undefined,
  input: Input.Input,
  partial: boolean,
  context: Context.Context<any> | undefined
) => {
  const state = new State(input, { partial, context })
  if (step === undefined) return "missing"
  const a = step(state)
  return a === Fail ? { mode: state.mode } : { value: a, pos: state.pos }
}

/** The resumable build of a registered parser (as used by streaming parses). */
const resumableStep = (p: Parser.Parser.Any, input: Input.Input) => {
  const kind = new State(input).inputKind
  const compiled = defined(Registry.compiled(p, kind, true))
  if (compiled.error !== undefined) throw compiled.error
  if (compiled.jitError !== undefined) throw compiled.jitError
  const step = defined(compiled.step)
  return (state: State<any>) => {
    state.resume = new Map()
    return step(state)
  }
}

/** The options the harness runs a parser with: `ParseOptions`, plus a context when the parser needs one. */
type RunOptions = Parser.ParseOptions & { readonly context?: Context.Context<any> }

/**
 * The runners over erased parsers. The harness holds every parser as
 * `Parser.Any`, whose `R` is `any`, so neither overload of the typed runners
 * (no context for `R = never`, a required one otherwise) applies.
 */
const runners = {
  parse: (p: Parser.Parser.Any, input: Input.Input, options?: RunOptions) =>
    // SAFETY: `options` carries the context exactly when the parser needs one.
    Parser.parse(p, input, options as Parser.ParseOptionsWithContext<any>),
  peek: (p: Parser.Parser.Any, input: Input.Input, options?: RunOptions) =>
    // SAFETY: `options` carries the context exactly when the parser needs one.
    Parser.parsePeek(p, input, options as Parser.ParseOptionsWithContext<any>),
  partial: (p: Parser.Parser.Any, input: Input.Input, options?: RunOptions) =>
    // SAFETY: `options` carries the context exactly when the parser needs one.
    Parser.parsePartial(p, input, options as Parser.ParseOptionsWithContext<any>)
}

let checked = 0

/** Checks that `p` gives the same results compiled and interpreted on `input`. */
const same = (p: Parser.Parser.Any, input: Input.Input, context?: Context.Context<any>): void => {
  const options = context === undefined ? undefined : { context }
  const expected = outcome(runners.parse(p, input, options))
  const expectedPeek = outcome(runners.peek(p, input, options))
  backends.forEach((backend) => {
    const c = twin(p, backend)
    const label = `${backend} on ${Formatter.formatJson(Predicate.isString(input) ? input : Array.from(input))}`
    expect(outcome(runners.parse(c, input, options)), label).toEqual(expected)
    expect(outcome(runners.peek(c, input, options)), label).toEqual(expectedPeek)
    // The compiled step on its own succeeds exactly when the interpreter does
    const f = fast(c, input, context)
    expect(f !== undefined, `${label}: compiled success`).toBe(expectedPeek.ok)
    if (f !== undefined && expected.ok) assert.strictEqual(f.pos, f.end, label)
    // The resumable build agrees with the interpreter on partial and on complete input
    const resumable = resumableStep(c, input)
    ;[true, false].forEach((partial) => {
      expect(stepOutcome(resumable, input, partial, context), `${label}, resumable, partial: ${partial}`).toEqual(
        stepOutcome(p.step, input, partial, context)
      )
    })
    checked++
  })
}

const jsonAlphabet = '{}[],:"\\0123456789.eE+-tfnulrsa \n\tuéx😀'

const jsonDocs = (() => {
  const random = rng(42)
  const docs = Array.from({ length: 40 }, () => ` ${randomJson(random)} `)
  docs.push("[1,,2]", '{"a": "unterminated}', '"\\x"', '"\\ud800"', '"\\ud800\\u0041"', "1e999", "-", "nan", "inf")
  docs.push('["a\\u00"]', '{"a" 1}', "[1 2]", "{,}", "", " ", "[", '"\u0000"', "0x10", "01", ".5", "5.", "-inf")
  return docs
})()

const jsonInputs = [
  ...jsonDocs,
  ...jsonDocs.slice(0, 20).flatMap((doc, i) => mutations(doc, jsonAlphabet, 12, i)),
  // Every prefix of a document exercises end-of-input handling
  ...(() => {
    const doc = '{"a": [1, -2.5e3, true, null, "x\\n\\u00e9😀"], "b": {}}'
    return Array.from({ length: doc.length + 1 }, (_, i) => doc.slice(0, i))
  })()
]

// -----------------------------------------------------------------------------
// Example grammars
// -----------------------------------------------------------------------------

describe("compiled examples", () => {
  it("json (Token/Ascii)", () => {
    jsonInputs.forEach((input) => same(Json.json, input))
  })

  it.each<TextBackend>([
    ["Text.string", Text.string, (s: string) => s],
    ["Text.utf8", Text.utf8, (s: string) => Encoding.utf8.encode(s)],
    ["Text.utf16le", Text.utf16le, (s: string) => Encoding.utf16le.encode(s)],
    ["Text.utf16be", Text.utf16be, (s: string) => Encoding.utf16be.encode(s)]
  ])("json-text with %s", (_, T, encode) => {
    const p = jsonGrammar(T)
    jsonInputs.forEach((input) => same(p, encode(input)))
  })

  it.each<TextBackend>([
    ["Text.string", Text.string, (s: string) => s],
    ["Text.utf8", Text.utf8, (s: string) => Encoding.utf8.encode(s)],
    ["Text.utf16le", Text.utf16le, (s: string) => Encoding.utf16le.encode(s)]
  ])("json-fast with %s, accepting what json-text accepts", (_, T, encode) => {
    const fast = JsonFast.jsonGrammar(T)
    const text = jsonGrammar(T)
    const inputs = [
      ...jsonInputs,
      '{"__proto__": 1, "toString": [2], "constructor": {"__proto__": null}}',
      '{"a": 1, "a": 2, "b": {"a": 3, "a": 4}}',
      '"\\ud83d\\ude00\\udc00\\u0041"',
      '"\\ud83d\\u0041"',
      '"\\ud83d"',
      '"\\ud83d\\x"'
    ]
    inputs.forEach((input) => {
      const bytes = encode(input)
      same(fast, bytes)
      const a = Parser.parse(fast, bytes)
      const b = Parser.parse(text, bytes)
      expect(Result.isSuccess(a), input).toBe(Result.isSuccess(b))
      expect(Result.getSuccess(a), input).toEqual(Result.getSuccess(b))
    })
  })

  it("json-text on malformed bytes", () => {
    const p = jsonGrammar(Text.utf8)
    const random = rng(7)
    const base = Encoding.utf8.encode('["aé😀", {"k": "v"}, 12]')
    Array.from({ length: 300 }).forEach((_, i) => {
      const bytes = base.slice()
      const at = Math.floor(random() * bytes.length)
      bytes[at] = [0x80, 0xc0, 0xe0, 0xed, 0xf0, 0xf5, 0xff, 0x22, 0x5c][i % 9]
      same(p, bytes.subarray(0, i % 3 === 0 ? bytes.length : at + 1))
    })
    const latin = jsonGrammar(Text.latin1)
    Array.from({ length: 256 }).forEach((_, b) => same(latin, new Uint8Array([0x22, b, 0x22])))
  })

  it.each([
    ["Text.utf16le", Text.utf16le, Encoding.utf16le],
    ["Text.utf16be", Text.utf16be, Encoding.utf16be]
  ] as const)("UTF-16 unit reader on malformed and truncated %s", (_, T, enc) => {
    const parsers = [
      jsonGrammar(T),
      T.any,
      Parser.repeat(T.oneOf("aé😀")),
      T.take(3),
      T.caseless("aÉ"),
      Parser.taken(Parser.repeat(T.noneOf("x"))),
      Parser.repeat(T.alpha1),
      // A control character read as a unit, and one only `decode` reads
      T.escaped(T.takeTill("é\\"), "é", T.oneOf("é\\")),
      T.escaped(T.takeTill("😀\\"), "😀", T.oneOf("😀\\"))
    ]
    const random = rng(13)
    const base = enc.encode('["aé😀", {"k": "v\\n"}, 12]')
    Array.from({ length: 300 }).forEach((_, i) => {
      const bytes = base.slice()
      const at = Math.floor(random() * bytes.length)
      // Lone and misordered surrogates, and units that are not the JSON syntax
      bytes[at] = [0xd8, 0xdb, 0xdc, 0xdf, 0x00, 0x22, 0x5c][i % 7]
      // Cutting after `at` leaves an odd length about half the time: a unit cut in two
      const input = bytes.subarray(0, i % 3 === 0 ? bytes.length : at + 1)
      parsers.forEach((p) => same(p, input))
    })
  })

  it("a parser derived from a schema", () => {
    const { annotate } = ParserSchema
    const Entry = Schema.Struct({
      name: Schema.String,
      tags: Schema.Array(Schema.Literals(["a", "ab"])).pipe(annotate({ prefix: "[", separator: ",", suffix: "]" })),
      size: Schema.optionalKey(Schema.Int.check(Schema.isLessThan(100)))
    }).pipe(annotate({ separator: ";", whitespace: true }))
    const Doc = Schema.Union([
      Schema.Array(Entry).pipe(annotate({ separator: "|" })),
      Schema.Record(Schema.String, Schema.Int).pipe(annotate({ prefix: "{", separator: ",", keySeparator: "=" }))
    ])
    const p = ParserSchema.toParser(Doc)
    const docs = ["x;[a,ab];3| y ; [ ] ", "{a=1,b=2,a=3}"]
    docs.flatMap((doc) => [doc, ...mutations(doc, "xy;[],ab3 |{}=1", 200, 3)]).forEach((input) => same(p, input))
  })

  it("arithmetic", () => {
    const docs = [
      "3",
      " 12",
      " 2* 3  *2 *2 / 3",
      "12 + 6 - 4+  3",
      " 2* (  3 + 4 ) ",
      "  2*2 / ( 5 - 1) + 3",
      "-1 + 2",
      "(1 + 2",
      "1 +",
      "1 ++ 2"
    ]
    const inputs = [...docs, ...docs.flatMap((d, i) => mutations(d, "0123456789+-*/() x", 15, 100 + i))]
    inputs.forEach((input) => {
      same(Arithmetic.evaluate, input)
      same(Arithmetic.ast, input)
      same(Arithmetic.lex, input)
      const lexed = Parser.parse(Arithmetic.lex, input)
      if (Result.isSuccess(lexed)) same(Arithmetic.tokens, lexed.success)
    })
  })

  it("ini", () => {
    const doc = "[owner]\nname=John Doe\norganization=Acme\n\n[database]\nserver=192.0.2.62\nport=143\n"
    const inputs = [
      doc,
      ...mutations(doc, "[]=\n abc", 120, 5),
      ...Array.from({ length: doc.length + 1 }, (_, i) => doc.slice(0, i))
    ]
    inputs.forEach((input) => same(Ini.ini, input))
  })

  it("sexpr", () => {
    const docs = ["(+ 1 2)", "(if (= 1 1) (* 2 3) 4)", "((lambda x) 1)", "(- 10 #t)", "(+ 1", "  (* (+ 1 2) (- 5 3) ) "]
    const inputs = [...docs, ...docs.flatMap((d, i) => mutations(d, "()+-*/=# 0123456789iftx", 20, 200 + i))]
    inputs.forEach((input) => {
      same(Sexpr.expr, input)
      same(Sexpr.program, input)
    })
  })

  it("http", () => {
    const doc = "GET /index.html HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n continued\r\n\r\n"
    const inputs = [
      doc,
      ...mutations(doc, "\r\n :/GETHP1.x", 150, 9),
      ...Array.from({ length: doc.length + 1 }, (_, i) => doc.slice(0, i))
    ]
    inputs.forEach((input) => same(Http.request, new TextEncoder().encode(input)))
  })
})

// -----------------------------------------------------------------------------
// Combinators, exhaustively on short inputs
// -----------------------------------------------------------------------------

const a = Token.literal("a")
const b = Token.literal("b")
const ab = Token.literal("ab")
const digit = Token.oneOf(Token.range("0", "9"))

// One predicate the compiler sees through (with ranges), one it must call
const aOrAstral = Token.codePoints("a or astral", (c) => c === 0x61 || c > 0xffff, [
  [0x61, 0x61],
  [0x10000, 0x10ffff]
])
const digitOrSurrogate = Token.codePoints(
  "digit or surrogate",
  (c) => (c >= 0x30 && c <= 0x39) || (c >= 0xd800 && c <= 0xdfff)
)

const grammars: ReadonlyArray<readonly [string, Parser.Parser<any, any, never, string>]> = [
  ["alt with pruning", Parser.alt(a, b, ab, Parser.succeed("none"))],
  ["alt of shared prefixes", Parser.alt(ab, a, Parser.seq(b, a))],
  ["alt with cut", Parser.alt(Parser.preceded(a, Parser.cut(b)), Parser.seq(a, a), Token.any)],
  ["alt with backtrack", Parser.alt(Parser.backtrack(Parser.preceded(a, Parser.cut(b))), Parser.seq(a, a))],
  ["alt of optional", Parser.alt(Parser.opt(a), b)],
  // Nested alts whose branches tie: the ties are merged lazily (#38)
  [
    "alt of tied alts",
    Parser.alt(
      Parser.alt(a, Parser.context(b, "b"), ab),
      Parser.alt(digit, Parser.seq(b, a)),
      Parser.alt(Parser.alt(Token.literal("+"), a), Token.literal(".")),
      Parser.preceded(Token.literal("e"), Parser.failMessage("no e"))
    )
  ],
  [
    "repeat of tied alts",
    Parser.seq(Parser.repeat(Parser.alt(Parser.alt(ab, a, b), digit, Parser.opt(a))), Token.literal("."))
  ],
  [
    "opt and optional",
    Parser.seq(
      Parser.opt(a),
      Parser.optional(b),
      Parser.orElseSucceed(ab, () => 0)
    )
  ],
  ["peek and not", Parser.seq(Parser.peek(a), Parser.not(ab), Token.any, Parser.opt(Parser.not(b)))],
  // Branches that start with a lookahead: dispatched on what follows it (#84)
  [
    "alt of branches led by not",
    Parser.alt(
      Parser.preceded(Parser.seq(Parser.not(ab), Token.literal("a.")), b),
      Parser.preceded(Parser.not(Parser.preceded(b, Parser.cut(a))), Token.literal("bb")),
      Parser.seq(Parser.not(digit), Parser.not(Parser.opt(a)), Token.literal(".")),
      Parser.preceded(Parser.peek(b), Token.any),
      Parser.seq(Parser.not(Parser.eof), Token.any)
    )
  ],
  ["repeat", Parser.repeat(Parser.alt(a, b))],
  [
    "repeat ranges",
    Parser.seq(Parser.repeat(a, { min: 1, max: 2 }), Parser.repeat(b, 2), Parser.repeat(Parser.alt(a, b), { max: 1 }))
  ],
  ["repeat of nothing", Parser.repeat(Parser.opt(a))],
  ["fold of nothing", Parser.fold(Parser.opt(a), { init: () => 0, f: (n) => n + 1 })],
  ["repeat until", Parser.repeatTill(Parser.alt(a, b), Token.literal("bb"), { min: 1, max: 3 })],
  ["fold", Parser.fold(Parser.alt(a, b), { init: () => "", f: (acc, x) => acc + x.toUpperCase(), range: { min: 1 } })],
  [
    "fold while",
    Parser.seq(
      Parser.fold(Parser.alt(a, b), { init: () => "", f: (acc, x) => acc + x, while: (acc) => !acc.endsWith("b") }),
      Parser.fold(Parser.alt(a, b), { init: () => 0, f: (n) => n + 1, range: { min: 1, max: 3 }, while: (n) => n < 2 })
    )
  ],
  [
    "fold while, unused",
    Parser.taken(
      Parser.seq(
        Parser.fold(Parser.alt(a, b), { init: () => 0, f: (n, x) => (x === "a" ? n + 1 : n), while: (n) => n < 2 }),
        Parser.opt(b)
      )
    )
  ],
  ["separated", Parser.separated(Parser.alt(ab, a), b)],
  ["separated ranges", Parser.terminated(Parser.separated(a, b, { min: 2, max: 3 }), Parser.opt(b))],
  ["separated of nothing", Parser.separated(Parser.opt(a), Parser.opt(b))],
  [
    "separatedFoldl1",
    Parser.separatedFoldl1<string, never, never, string, string, never, never, string>(
      Parser.alt(a, b),
      Token.oneOf("+-"),
      (l, op, r) => `(${l}${op}${r})`
    )
  ],
  [
    "separatedFoldr1",
    Parser.separatedFoldr1<string, never, never, string, string, never, never, string>(
      Parser.alt(a, b),
      Token.oneOf("+-"),
      (l, op, r) => `(${l}${op}${r})`
    )
  ],
  [
    "taken and spans",
    Parser.seq(
      Parser.taken(Parser.repeat(a)),
      Parser.span(Parser.opt(b)),
      Parser.withTaken(Parser.opt(ab)),
      Parser.withSpan(Token.any)
    )
  ],
  [
    "map, filter and friends",
    Parser.alt(
      digit.pipe(
        Parser.map(Number),
        Parser.filter((n) => n % 2 === 0)
      ),
      digit.pipe(Parser.tryMap((d) => (d === "5" ? Result.fail("five") : Result.succeed(d + d)))),
      digit.pipe(Parser.filterMap((d) => (d === "3" ? Option.none() : Option.some(-Number(d))))),
      digit.pipe(
        Parser.mapOrFail(
          (d) => (d === "1" ? Input.Fail : `${d}!`),
          (d) => `no ${d}`
        )
      ),
      Parser.mapOrFail(Token.oneOf("ab+"), (c) => (c === "+" ? Input.Fail : c.toUpperCase())),
      Token.any.pipe(
        Parser.filterOrFail(
          (c) => c !== "x",
          () => "x!"
        )
      )
    )
  ],
  [
    "as, asVoid, zipWith",
    Parser.seq(
      Parser.as(a, 1),
      Parser.asVoid(Parser.opt(b)),
      Parser.zipWith(Parser.opt(a), Parser.opt(b), (x, y) => [y, x])
    )
  ],
  // The allocation-free spellings of map(withSpan(p)) and map(seq(...)) (#64)
  [
    "mapSpan and seqWith",
    Parser.alt(
      Parser.seqWith([digit, Parser.mapSpan(Parser.repeat(a), (xs, s, e) => [xs.length, s, e]), b], (x, y, z) => [
        z,
        y,
        x
      ]),
      Parser.seqWith([Parser.opt(b), Parser.opt(a)], (x, y) => [y, x]),
      Parser.seqWith([b], (x) => x + x),
      Parser.seqWith([digit, digit, digit, a], (...xs) => xs.join("")),
      Parser.mapSpan(Token.oneOf("+e"), (x, s, e) => `${x}${s}${e}`)
    )
  ],
  ["struct", Parser.struct({ x: Parser.opt(a), y: Parser.repeat(b, { max: 2 }), z: Token.rest })],
  [
    "delimited and pairs",
    Parser.alt(Parser.delimited(a, Parser.repeat(digit), b), Parser.separatedPair(digit, Token.oneOf(":="), digit))
  ],
  [
    "dispatch",
    Parser.dispatch(
      Token.any,
      { a: Parser.succeed(1), b: Parser.repeat(digit, { min: 1 }), "😀": Parser.succeed("smile") },
      Parser.preceded(Parser.not(Parser.eof), Token.any)
    )
  ],
  ["dispatch on peek", Parser.dispatch(Parser.peek(Token.any), { a: ab, b: Parser.taken(Parser.repeat(b)) })],
  ["dispatch with a function", Parser.dispatch(digit, (d) => (d === "0" ? undefined : Token.take(Number(d))))],
  [
    // The selector is not a single token, so the cases are chosen by key, then run inline
    "dispatch on a slice",
    Parser.dispatch(
      Parser.taken(Parser.repeat(Token.oneOf("ab"), { min: 1, max: 2 })),
      { a: Parser.repeat(digit, { min: 1 }), ab: Parser.succeed("ab"), ba: Parser.cut(Token.literal(":")) },
      Parser.preceded(Parser.not(Parser.eof), Token.any)
    )
  ],
  [
    "dispatch on peek, nested",
    Parser.dispatch(
      Parser.peek(Token.any),
      { a: Parser.dispatch(Parser.peek(Parser.preceded(a, Token.any)), { b: ab, "1": Parser.seq(a, digit) }, a) },
      Parser.taken(Parser.repeat(b))
    )
  ],
  ["flatMap", digit.pipe(Parser.flatMap((d) => Token.take(Number(d))))],
  [
    "eof, location, rest",
    Parser.seq(
      Parser.location,
      Parser.opt(a),
      Parser.location,
      Token.restLen,
      Parser.alt(Parser.eof, Parser.asVoid(Token.rest))
    )
  ],
  ["cut and context", Parser.preceded(a, Parser.cut(Parser.context(Parser.expected(digit, "a digit"), "number")))],
  // Repetitions of a character set whose values are unused scan as runs (#79)
  [
    "repeat(oneOf) as a run",
    (() => {
      const chars = Parser.alt(Token.oneOf("ab😀"), Parser.seq(Token.literal("\\"), Token.any))
      const tail = Parser.repeat(
        Parser.alt(Parser.repeat(chars, { min: 1 }), Parser.seq(Token.takeWhile(".", { min: 1 }), Parser.peek(chars)))
      )
      return Parser.seq(
        Parser.taken(tail),
        Parser.asVoid(Parser.repeat(Token.oneOf("0+"), { min: 1, max: 2 })),
        Parser.taken(Parser.repeat(Token.noneOf("e"), { min: 2 })),
        Parser.peek(Parser.asVoid(Parser.repeat(chars)))
      )
    })()
  ],
  // A hand-written fast path in front of a grammar (#78): runs of "a" before a "b"
  [
    "withFastPath",
    Parser.separated(
      Parser.withFastPath(Parser.terminated(Token.takeWhile("a", { min: 1 }), b), runOfAs),
      Token.literal("+")
    )
  ],
  // A check that fails at an offset it chooses (#73)
  [
    "failAt",
    Parser.alt(
      Parser.seq(Parser.taken(Parser.repeat(digit)), Parser.location, Parser.alt(a, b)).pipe(
        Parser.flatMap(([n, at, x]) => (n.length % 2 === 0 ? Parser.succeed(x) : Parser.failAt(at - 1, n)))
      ),
      Parser.seq(digit, b)
    )
  ],
  // Skippers whose hints and furthest failures are dropped (#74)
  [
    "quiet",
    Parser.separated(
      Parser.preceded(Parser.quiet(Parser.repeat(Parser.alt(a, Parser.seq(b, Parser.cut(a))))), Parser.alt(digit, ab)),
      Parser.quiet(Parser.opt(Token.literal("+")))
    )
  ],
  [
    "errors only",
    Parser.alt(
      Parser.mapError(Parser.fail("e"), (e) => e + "!"),
      Parser.orFail(ab, () => "no ab"),
      Parser.failMessage("m")
    )
  ],
  ["todo and reject", Parser.alt(Parser.preceded(b, Parser.todo), Parser.reject, a)],
  ["complete", Parser.complete(Parser.repeat(a))],
  ["recovery outside parseRecoverable", Parser.seq(Parser.resumeAfter(a, b), Parser.retryAfter(Parser.opt(b), a))],
  ["trace", Parser.trace(Parser.repeat(Parser.alt(a, b)), "t")],
  [
    "suspend",
    (() => {
      const nested: Parser.Parser<unknown> = Parser.alt(
        Parser.delimited(a, Parser.repeat(Parser.suspend(() => nested)), b),
        digit
      )
      return nested
    })()
  ],
  ["orElse", Parser.orElse(ab, () => Parser.repeat(a, { min: 1 }))],
  [
    "make and gen",
    Parser.seq(
      Parser.make((s) => (s.pos < s.end ? s.input[s.pos++] : s.backtrack("Token"))),
      Parser.gen(function* () {
        const x = yield* Parser.opt(a)
        return Option.isSome(x) ? yield* b : "-"
      })
    )
  ],
  ["permutation", Parser.permutation(a, b, digit)],
  [
    "a combinator counting separated items",
    Parser.combinator([Parser.alt(ab, digit), Token.literal("+")], ([item, sep]) => {
      const more = (state: State<string>, n: number): number | Fail => {
        const start = state.pos
        if (sep(state) === Fail || item(state) === Fail) {
          if (state.mode !== "Backtrack") return Fail
          state.rewind(start)
          return n
        }
        return more(state, n + 1)
      }
      return (state) => (item(state) === Fail ? Fail : more(state, 1))
    })
  ],
  // Permutation and expression rounds whose attempts tie: merged lazily (#44)
  [
    "permutation of tied alts",
    Parser.seq(
      Parser.permutation(Parser.alt(ab, Parser.context(b, "b")), Parser.alt(a, digit), Token.literal(".")),
      Parser.opt(Parser.permutation(Parser.alt(Parser.alt(a, b), digit), Token.literal("+")))
    )
  ],
  [
    "expression with tied operators",
    Expression.make({
      operand: Parser.alt(digit, Parser.context(Parser.seq(a, b), "ab")),
      operators: [
        Expression.prefix(Parser.alt(Token.literal("-"), Token.literal("~")), 3, (_, x) => `-${x}`),
        Expression.postfix(Token.literal("!"), 4, (x) => `${x}!`),
        Expression.postfix(Parser.alt(Token.literal("?"), Token.literal(".")), 4, (x) => `${x}?`),
        Expression.infixLeft(Parser.alt(Token.literal("+"), Token.literal("-")), 1, (l, _, r) => `(${l}+${r})`),
        Expression.infixRight(Token.literal("^"), 2, (l, _, r) => `(${l}^${r})`)
      ]
    })
  ],
  ["mapParser", Token.take(2).pipe(Parser.mapParser(Parser.repeat(a)))],
  [
    "expression",
    Expression.make({
      operand: digit,
      operators: [
        Expression.prefix(Token.literal("-"), 3, (_, x) => `-${x}`),
        Expression.infixLeft(Token.literal("+"), 1, (l, _, r) => `(${l}+${r})`)
      ]
    })
  ],
  [
    "Token tokens",
    Parser.seq(
      Token.oneOf(["a", Token.range("0", "2"), (c: string) => c === "😀"]),
      Token.noneOf("ab"),
      Parser.opt(Token.take(2))
    )
  ],
  [
    "Token slices",
    Parser.seq(
      Token.takeWhile("ab", { min: 1, max: 2 }),
      Token.takeTill("0", { max: 3 }),
      Parser.opt(Token.takeUntil("0", { min: 1 }))
    )
  ],
  ["takeTill with surrogates", Parser.seq(Token.takeTill("0", { min: 2, max: 3 }), Token.rest)],
  ["takeWhile with a string predicate", Token.takeWhile((c: string) => c !== "b" && c < "😀")],
  [
    "Token.codePoints with ranges",
    Parser.seq(
      Token.takeWhile([aOrAstral, "+"], { max: 3 }),
      Parser.opt(Token.oneOf(digitOrSurrogate)),
      Parser.opt(Token.noneOf([aOrAstral, "b"]))
    )
  ],
  [
    "Token.codePoints without ranges",
    Parser.seq(Token.takeTill(digitOrSurrogate, { max: 2 }), Parser.opt(Token.oneOf([digitOrSurrogate, aOrAstral])))
  ],
  ["takeUntil", Parser.seq(Token.takeUntil("ab"), Token.rest)],
  [
    "literal edge cases",
    Parser.seq(Token.literal(""), Parser.opt(Token.literal("a😀")), Parser.opt(Ascii.caseless("Ab")))
  ],
  [
    "fromEntries of separated pairs",
    Parser.fromEntries(
      Parser.separated(
        Parser.separatedPair(Token.oneOf("ab"), Token.literal("+"), Parser.opt(digit)),
        Token.literal("\\")
      )
    )
  ],
  [
    "fromEntries of a ranged repeat",
    Parser.fromEntries(
      Parser.repeat(Parser.seq(Token.oneOf("ab01"), Parser.opt(Token.literal("e"))), { min: 1, max: 3 })
    )
  ],
  [
    "fromEntries through preceded and cut",
    Parser.preceded(
      a,
      Parser.cut(
        Parser.terminated(Parser.separated(Parser.seq(digit, Token.oneOf("ab")), Token.literal("+"), { max: 2 }), b)
      )
    ).pipe(Parser.fromEntries, Parser.context("entries"))
  ],
  // Keys need not be property keys: they are converted, as Object.fromEntries does
  [
    "fromEntries of nothing",
    Parser.fromEntries(
      // SAFETY: a deliberate type lie: the keys are `Option`s, not property
      // keys; `fromEntries` converts them as `Object.fromEntries` does.
      Parser.repeat(Parser.seq(Parser.opt(a), Parser.opt(b))) as Parser.Parser<Array<[any, unknown]>>
    )
  ],
  [
    "fromEntries of separated nothing",
    Parser.fromEntries(
      // SAFETY: a deliberate type lie: the keys are `Option`s, not property
      // keys; `fromEntries` converts them as `Object.fromEntries` does.
      Parser.separated(Parser.seq(Parser.opt(a), Parser.opt(digit)), Parser.opt(b)) as Parser.Parser<
        Array<[any, unknown]>
      >
    )
  ],
  [
    "map(Object.fromEntries)",
    Parser.map(
      Parser.separated(
        Parser.separatedPair(digit, Parser.opt(Token.literal(".")), Token.oneOf("ab")),
        Token.literal("+")
      ),
      Object.fromEntries
    )
  ],
  ["Ascii numbers", Parser.separated(Parser.alt(Ascii.float, Ascii.hexUint), Token.literal(","))],
  ["Ascii integers", Parser.seq(Ascii.decInt, Parser.opt(Parser.preceded(Token.literal(":"), Ascii.decUint)))],
  [
    "Ascii classes",
    Parser.seq(Ascii.alpha0, Ascii.digit0, Ascii.space0, Parser.opt(Ascii.alphanumeric1), Parser.opt(Ascii.lineEnding))
  ],
  [
    "Ascii escapes",
    Parser.seq(
      Ascii.escaped(
        Token.takeTill('\\"'),
        "\\",
        Parser.alt(Token.literal("n").pipe(Parser.as("\n")), Token.literal("\\"))
      ),
      Parser.opt(Ascii.takeEscaped(Ascii.alpha1, "\\", Token.oneOf("an")))
    )
  ],
  ["tillLineEnding", Parser.terminated(Ascii.tillLineEnding, Parser.opt(Ascii.lineEnding))]
]

const alphabet = ["a", "b", "0", "1", "+", "\\", '"', "😀", "\ud800", "\n", "e", "."]

describe("compiled combinators", () => {
  // Every input up to 3 characters, and a sample of longer ones
  const inputs = (() => {
    const random = rng(1)
    const longer = Array.from({ length: 1500 }, () =>
      Array.from({ length: 4 + Math.floor(random() * 3) }, () => alphabet[Math.floor(random() * alphabet.length)]).join(
        ""
      )
    )
    return [...allStrings(alphabet, 3), ...longer]
  })()

  it.each(grammars)("%s", (_, p) => {
    inputs.forEach((input) => same(p, input))
  })

  // In void position (output unused) parsers compile differently
  it.each(grammars)("%s, output unused", (_, p) => {
    const unused = Parser.seq(Parser.taken(p), Parser.asVoid(Parser.opt(p)))
    allStrings(alphabet, 3).forEach((input) => same(unused, input))
  })

  const textGrammars = (T: Text.TextParsers<any>, x = "😀") => [
    Parser.seq(T.any, Parser.opt(T.oneOf(`a${x}`)), Parser.opt(T.noneOf(["b", Token.range("0", "9")]))),
    Parser.seq(T.alpha0, T.digit0, Parser.opt(T.takeWhile("ab+", { min: 1, max: 2 })), Parser.opt(T.take(2))),
    Parser.seq(T.caseless("aé"), Parser.opt(T.literal(`${x}b`)), T.rest),
    Parser.seq(T.takeTill('\\"', { max: 3 }), Parser.opt(T.takeUntil("0"))),
    Parser.seq(T.taken(Parser.repeat(Parser.alt(T.literal("a"), T.any))), Parser.opt(T.identifier)),
    Parser.seq(Parser.opt(T.decInt), Parser.opt(T.float), Parser.opt(T.hexUint), T.multispace0),
    Parser.seq(
      T.escaped(T.takeTill('\\"'), "\\", Parser.alt(T.literal("n").pipe(Parser.as("\n")), T.literal("\\"))),
      Parser.opt(T.takeEscaped(T.alpha1, "\\", T.oneOf("an")))
    ),
    Parser.dispatch(T.any, { a: Parser.succeed(1), é: T.alpha1, [x]: Parser.succeed(3) }, T.any),
    Parser.seq(T.bom, Parser.alt(T.tillLineEnding, T.lineEnding)),
    Parser.seq(
      T.takeWhile([aOrAstral, "+"], { max: 2 }),
      Parser.opt(T.oneOf(digitOrSurrogate)),
      Parser.opt(T.noneOf([digitOrSurrogate, "b"]))
    )
  ]
  const textAlphabet = ["a", "b", "0", "é", "😀", "\\", '"', "+", "\n", "\r", "\ufeff", "Ä"]

  it.each<[name: string, T: Text.TextParsers<any>]>([
    ["Text.string", Text.string],
    ["Text.utf8", Text.utf8],
    ["Text.utf16le", Text.utf16le],
    ["Text.latin1", Text.latin1]
  ])(
    "%s parsers",
    (name, T) => {
      const inputs = allStrings(textAlphabet, 3)
      textGrammars(T, name === "Text.latin1" ? "þ" : "😀").forEach((p) => {
        inputs.forEach((input) => {
          if (name === "Text.latin1" && beyondLatin1(input)) return
          same(p, T.encoding.encode(input))
        })
        if (name !== "Text.string") {
          const random = rng(3)
          Array.from({ length: 200 }).forEach(() => {
            same(
              p,
              Uint8Array.from(
                { length: Math.floor(random() * 6) },
                () => [0x61, 0x30, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80, 0xff, 0x00, 0x5c][Math.floor(random() * 11)]
              )
            )
          })
        }
      })
    },
    // Every grammar on every short input, with three backends: about 5 s
    30_000
  )

  it("byte inputs", () => {
    const bytes = Token.literal(new Uint8Array([1, 2]))
    const p = Parser.seq(
      Parser.opt(bytes),
      // SAFETY: a string literal also matches byte input, as its UTF-8 bytes
      // (`Token.literalImpl`); the overloads type it for string input only.
      Parser.opt(Token.literal("ab") as Parser.Parser<"ab", never, never, any>),
      Token.takeWhile<Uint8Array>([Token.range(0x30, 0x39), 1], { max: 3 }),
      Parser.opt(Ascii.caseless(new Uint8Array([0x41]))),
      Parser.opt(Ascii.bytes.decUint),
      Parser.alt(Binary.u8, Parser.eof)
    )
    const random = rng(11)
    Array.from({ length: 2000 }).forEach(() => {
      same(
        p,
        Uint8Array.from(
          { length: Math.floor(random() * 7) },
          () => [1, 2, 0x30, 0x39, 0x41, 0x61, 0x62, 0xff][Math.floor(random() * 8)]
        )
      )
    })
  })

  it("takeUntil and takeUntilAny on bytes (SIMD in WebAssembly)", () => {
    const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))
    const sets: ReadonlyArray<ReadonlyArray<Uint8Array>> = [
      [bytes("ab")],
      [bytes("a")],
      [bytes("abcab")],
      [bytes("ba"), bytes("ccc"), bytes("a\xff")],
      // More literals than buckets, sharing them; one of one byte
      Array.from({ length: 11 }, (_, i) => bytes(["ab", "bc", "ca", "abc", "cab"][i % 5] + "abc"[i % 3])).concat([
        bytes("\xff")
      ])
    ]
    const grammars: ReadonlyArray<Parser.Parser<any, never, never, Uint8Array>> = [
      ...sets.map((lits) => Parser.seq(Token.takeUntilAny(lits), Token.restOf<Uint8Array>())),
      // Every occurrence, overlapping ones included: a prefilter's candidates
      ...sets.map((lits) =>
        Parser.repeat(
          Parser.zipLeft(Parser.preceded(Token.takeUntilAny(lits), Parser.location), Token.take<Uint8Array>(1))
        )
      ),
      Parser.seq(Token.takeUntil(bytes("abc")), Token.restOf<Uint8Array>()),
      Parser.repeat(Parser.terminated(Token.takeUntil(bytes("cb")), Token.take<Uint8Array>(2)))
    ]
    const random = rng(21)
    grammars.forEach((p) => {
      Array.from({ length: 300 }).forEach(() => {
        same(
          p,
          Uint8Array.from(
            { length: Math.floor(random() * 90) },
            () => [0x61, 0x62, 0x63, 0xff][Math.floor(random() * 4)]
          )
        )
      })
      // Searched natively, not called back into JavaScript
      const compiled = Registry.compiled(Compiler.wasm(p), 1)
      expect(compiled?.backend).toBe("wasm")
      expect(compiled?.fallbacks.filter((f) => f.tag.startsWith("TakeUntil"))).toEqual([])
    })
  })

  it("takeWhile and takeTill over long runs (SIMD in WebAssembly)", () => {
    const random = rng(23)
    const alphabet = ["a", "b", " ", "0", "\\", '"', "é", "😀", "\ud800", "\u0100", "\u00ff", "\u7fff", "\u8000"]
    const text = () =>
      Array.from({ length: Math.floor(random() * 120) }, () =>
        // Mostly runs of one class, so the vector steps are taken
        random() < 0.9 ? "ab "[Math.floor(random() * 3)] : alphabet[Math.floor(random() * alphabet.length)]
      ).join("")
    const grammar = (T: typeof Text.string | typeof Text.utf8) =>
      Parser.repeat(
        Parser.alt(T.takeWhile("ab", { min: 1 }), T.takeTill('\\"0', { min: 1 }), T.takeWhile(" ", { min: 1 }), T.any)
      )
    ;[Text.string, Text.utf8, Text.latin1].forEach((T) => {
      const p = grammar(T)
      Array.from({ length: 300 }).forEach(() => {
        const input = text()
        if (T === Text.latin1 && beyondLatin1(input)) return
        same(p, T.encoding.encode(input))
      })
    })
    const tokens = Parser.repeat(
      Parser.alt(Token.takeWhile("ab", { min: 1 }), Token.takeTill("\\0", { min: 1 }), Token.anyToken())
    )
    Array.from({ length: 300 }).forEach(() => same(tokens, text()))
    const bytes = Parser.repeat(
      Parser.alt(
        Token.takeWhile<Uint8Array>([0x61, 0x62], { min: 1 }),
        Token.takeTill<Uint8Array>([0x30, 0x80], { min: 1 }),
        Token.anyToken<Uint8Array>()
      )
    )
    Array.from({ length: 300 }).forEach(() => same(bytes, new TextEncoder().encode(text())))
  })

  it("long literals, compared many bytes at a time", () => {
    const words = ["Sherlock Holmes, consulting detective", "null", "ab", "Baker Street, 221B"]
    const grammar = Parser.repeat(
      Parser.alt(
        ...words.map((w) => Token.literal(w)),
        ...words.map((w) => Ascii.caseless(w)),
        Token.literal("é😀éé😀é"),
        Token.anyToken<string>()
      )
    )
    const bytes = Parser.repeat(
      Parser.alt(
        ...words.map((w) => Token.literal(new TextEncoder().encode(w))),
        ...words.map((w) => Ascii.caseless(new TextEncoder().encode(w))),
        Token.anyToken<Uint8Array>()
      )
    )
    const random = rng(29)
    // Each literal, or one with a byte changed or its case flipped, at every position
    const variants = words.flatMap((w) =>
      Array.from({ length: w.length + 1 }, (_, i) =>
        i === w.length ? w : w.slice(0, i) + (random() < 0.5 ? "x" : (w[i]?.toUpperCase() ?? "")) + w.slice(i + 1)
      )
    )
    Array.from({ length: 400 }).forEach(() => {
      const input = Array.from({ length: 4 }, () => variants[Math.floor(random() * variants.length)]).join(
        random() < 0.5 ? "" : "é"
      )
      same(grammar, input)
      same(bytes, new TextEncoder().encode(input))
    })
  })

  it("Binary numbers", () => {
    const grammars: ReadonlyArray<Parser.Parser<any, any, never, Uint8Array>> = [
      Parser.repeat(Binary.beU32),
      Parser.seq(Binary.u8, Binary.beU16, Binary.leU32, Binary.i8, Parser.opt(Binary.beI24)),
      Parser.repeat(
        Parser.alt(
          Parser.preceded(Token.literal(new Uint8Array([1])), Binary.leF32),
          Parser.preceded(Token.literal(new Uint8Array([2])), Binary.beF64),
          Parser.preceded(Token.literal(new Uint8Array([3])), Binary.leU64),
          Parser.preceded(Binary.u8, Binary.beI16)
        )
      ),
      // Values discarded, and a fold over them
      Parser.preceded(Binary.beU16, Parser.terminated(Binary.leI32, Binary.u8)),
      Parser.fold(Binary.leU16, { init: () => 0, f: (a: number, x: number) => a + x }),
      Parser.alt(Parser.seq(Binary.beU32, Parser.eof), Parser.seq(Binary.leU24, Binary.u8)),
      Parser.seq(Binary.u128("big"), Binary.i64("little"))
    ]
    const random = rng(12)
    grammars.forEach((p) => {
      Array.from({ length: 400 }).forEach(() => {
        same(
          p,
          Uint8Array.from(
            { length: Math.floor(random() * 26) },
            () => [0, 1, 2, 3, 0x7f, 0x80, 0xff][Math.floor(random() * 7)]
          )
        )
      })
    })
  })

  it("Text.taken validates what lenient parsers consumed", () => {
    const str = Parser.seq(Text.string.taken(Token.take(2)), Token.rest)
    allStrings(["a", "\ud800", "\udc00", "😀"], 3).forEach((input) => same(str, input))
    const bytes = Parser.seq(Text.utf8.taken(Token.take<Uint8Array>(2)), Token.restOf<Uint8Array>())
    allStrings(["a", "\xff", "\xc3", "\xa9"], 3).forEach((input) => {
      same(
        bytes,
        Uint8Array.from(input, (c) => c.charCodeAt(0))
      )
    })
  })

  it("escapes whose normal part can match nothing", () => {
    const p = Parser.seq(
      Parser.opt(Ascii.takeEscaped(Ascii.alpha0, "\\", Token.oneOf("an"))),
      Ascii.escaped(Ascii.alpha0, "\\", Token.literal("n").pipe(Parser.as("\n"))),
      Token.rest
    )
    allStrings(["a", "\\", "n", "0"], 4).forEach((input) => same(p, input))
  })

  it("caseless literals with other characters", () => {
    const p = Parser.seq(Parser.opt(Ascii.caseless("+0a")), Parser.opt(Ascii.caseless("@")), Token.rest)
    allStrings(["+", "\u000b", "0", "\u0010", "a", "A", "@", "`"], 3).forEach((input) => same(p, input))
  })

  // Sets compile to comparisons on their accepted or rejected ranges, or to a
  // table: every code unit up to 0x103 crosses each boundary
  it("token sets at their boundaries", () => {
    const sets: ReadonlyArray<Token.TokenSet<string>> = [
      ['"\\', Token.range("\u0000", "\u001f")],
      Token.range("a", "z"),
      Token.range(" ", "~"),
      [Token.range("0", "9"), Token.range("A", "F"), Token.range("a", "f")],
      Token.range("\u0080", "ÿ"),
      Token.range("\u0000", "\u007f"),
      [Token.range("a", "ÿ"), "_"],
      [Token.range("\u0001", "~"), "ÿ"],
      "acegikmoq",
      // Cheaper to test by the rejected units, up to the end of the table
      [Token.range("\u0000", "\t"), Token.range("\u000b", "\u00c7")],
      [Token.range("\u0000", "\t"), Token.range("\u000b", "c")],
      [
        Token.range("\u0000", "\t"),
        Token.range("\u000b", "\u0013"),
        Token.range("\u001e", "'"),
        Token.range(")", "\u00ff")
      ],
      (c: string) => c > "m" && c !== "x"
    ]
    const units = Array.from({ length: 0x104 }, (_, i) => String.fromCharCode(i))
    const inputs = [...units.map((c) => `${c}${c}a`), "é😀", "😀\u0000", "\ud800a", "Āÿ"]
    sets.forEach((set) => {
      const token = Parser.seq(
        Parser.opt(Token.oneOf(set)),
        Parser.opt(Token.noneOf(set)),
        Token.takeWhile(set),
        Token.takeTill(set, { max: 2 })
      )
      inputs.forEach((input) => same(token, input))
      // SAFETY: a deliberate type lie: the string sets (character ranges, a
      // predicate on characters) run on byte input, which `ByteTokenSet` does
      // not admit, to check that compiled and interpreted parsers agree there too.
      const bytes = Parser.seq(Token.takeWhile<Uint8Array>(set as never), Token.takeTill<Uint8Array>(set as never))
      Array.from({ length: 256 }).forEach((_, b) => same(bytes, new Uint8Array([b, b, 0x61])))
      const texts: ReadonlyArray<Text.TextParsers<any>> = [Text.string, Text.utf8, Text.latin1]
      texts.forEach((T) => {
        const text = Parser.seq(
          Parser.opt(T.oneOf(set)),
          Parser.opt(T.noneOf(set)),
          T.takeWhile(set),
          T.takeTill(set, { max: 2 })
        )
        inputs.forEach((input) => {
          if (T === Text.latin1 && beyondLatin1(input)) return
          if (T === Text.utf8 && /[\ud800-\udfff]/.test(input.replace("😀", ""))) return
          same(text, T.encoding.encode(input))
        })
      })
    })
    // Every case with three backends: about 5 s
  }, 30_000)

  // Compiled floats are read from the input without slicing it, when they
  // are in decimal notation
  it("float conversions", () => {
    const random = rng(5)
    const digits = (n: number) => Array.from({ length: n }, () => Math.floor(random() * 10)).join("")
    const generated = Array.from({ length: 3000 }, (_, i) => {
      const sign = ["", "-", "+"][i % 3]
      const int = digits(Math.floor(random() * 12))
      const frac = random() < 0.6 ? `.${digits(Math.floor(random() * 12))}` : ""
      const exp =
        random() < 0.4 ? `${random() < 0.5 ? "e" : "E"}${["", "-", "+"][i % 3]}${Math.floor(random() * 30)}` : ""
      return `${sign}${int}${frac}${exp}`
    })
    const inputs = [
      "0",
      "-0",
      "+0",
      "0.0",
      "-0.0e5",
      "-0e-999",
      "1",
      "123456789012345",
      "1234567890123456",
      "999999999999999",
      "9999999999999999",
      "12345678901234567890",
      "0.1",
      "0.30000000000000004",
      "1e22",
      "1e23",
      "-1e-22",
      "1e-23",
      "9007199254740993",
      "1.7976931348623157e308",
      "1e309",
      "-1e309",
      "5e-324",
      "4.9e-324",
      "1e-400",
      ".5",
      "5.",
      "+.5e-3",
      "1e",
      "1e+",
      "1.e5",
      "0000.0001",
      "00012",
      "1E5",
      "1.5e-22",
      "123.456e-20",
      "123.456e+20",
      "0.000000000000000000000000000001",
      "100000000000000000000000",
      "1e0000000000000000000001",
      "nan",
      "-inf",
      "infinity",
      "INF",
      "+Infinity",
      "1_0",
      "1.2.3",
      "-",
      "+",
      ".",
      "e5",
      "1e5x",
      "12,5",
      // 16 to 19 significant digits, including ties between doubles
      "18014398509481985",
      "18014398509481987",
      "1.000000000000000111",
      "0.1000000000000000055511151231257827",
      "123456789012345678e-22",
      "9999999999999999999e22",
      "-0.0000000000000000001234567890123456789",
      "4.35679845407817e15",
      "3.0517578125000000001e-5",
      "2.2250738585072011e-308",
      ...Array.from({ length: 300 }, () =>
        ((random() - 0.5) * 10 ** Math.floor(random() * 30 - 12)).toPrecision(16 + Math.floor(random() * 4))
      ),
      ...generated
    ]
    const encodings: ReadonlyArray<
      readonly [name: string, float: Parser.Parser<number, never, never, any>, encode: (s: string) => Input.Input]
    > = [
      ["string", Ascii.float, (s: string) => s],
      ["bytes", Ascii.bytes.float, (s: string) => Encoding.utf8.encode(s)],
      ["Text.string", Text.string.float, (s: string) => s],
      ["Text.utf8", Text.utf8.float, (s: string) => Encoding.utf8.encode(s)],
      ["Text.latin1", Text.latin1.float, (s: string) => Encoding.latin1.encode(s)],
      ["Text.utf16le", Text.utf16le.float, (s: string) => Encoding.utf16le.encode(s)]
    ]
    encodings.forEach(([, float, encode]) => {
      const p = Parser.seq(float, Token.restLen)
      inputs.forEach((input) => {
        const bytes = encode(input)
        same(p, bytes)
        const expected = Parser.parse(p, bytes)
        backends.forEach((backend) => {
          const actual = Parser.parse(twin(p, backend), bytes)
          // `toEqual` does not tell 0 from -0
          const first = (r: typeof actual) => Result.map(r, (values) => Object.is(values[0], -0))
          expect(first(actual), `${backend} on ${input}`).toEqual(first(expected))
        })
      })
    })
    // Every case with three backends: about 5 s
  }, 30_000)

  // Compiled parsers assign plain keys and define the others, as
  // Object.fromEntries does
  describe("withFastPath (#78)", () => {
    const grammar = Parser.terminated(Token.takeWhile("a", { min: 1 }), Token.literal("b"))
    const fast =
      (calls: { n: number }, wrong = false) =>
      (state: State<string>) => {
        calls.n++
        const value = runOfAs(state)
        return wrong && value !== Parser.Defer ? value.toUpperCase() : value
      }

    it("runs the fast path in compiled code only", () => {
      const calls = { n: 0 }
      // A wrong fast path shows which runs used it
      const p = Parser.withFastPath(grammar, fast(calls, true))
      expect(Parser.parse(p, "aab")).toEqual(Result.succeed("aa"))
      expect(calls.n).toBe(0)
      backends.forEach((backend) => {
        expect(Parser.parse(Compiler[backend](Parser.named(p, backend)), "aab"), backend).toEqual(Result.succeed("AA"))
      })
      // Once per backend
      expect(calls.n).toBe(backends.length)
    })

    it.each(backends)("defers to the grammar, whose errors are reported (%s)", (backend) => {
      const calls = { n: 0 }
      const p = Compiler[backend](Parser.separated(Parser.withFastPath(grammar, fast(calls)), Token.literal(",")))
      const reference = Parser.separated(grammar, Token.literal(","))
      ;["ab,aab", "ab,b", "ab,a", "", "ab,", "aab,ab,x"].forEach((input) => {
        expect(Parser.parse(p, input), input).toEqual(Parser.parse(reference, input))
      })
      expect(calls.n).toBeGreaterThan(0)
      // Partial input: the fast path defers at the end, and the grammar reports `Incomplete`
      expect(Parser.parsePartial(p, "ab,aa")).toEqual(Parser.parsePartial(reference, "ab,aa"))
    })

    it("verifyFastPath finds where a fast path disagrees", () => {
      const inputs = ["ab", "aab", "b", "abab", "aa", ""]
      expect(Parser.verifyFastPath(grammar, fast({ n: 0 }), inputs)).toEqual([])
      const wrong = Parser.verifyFastPath(grammar, fast({ n: 0 }, true), inputs)
      expect(wrong.map((m) => [m.input, m.offset, m.partial])).toEqual([
        ["ab", 0, false],
        ["ab", 0, true],
        ["aab", 0, false],
        ["aab", 0, true],
        ["aab", 1, false],
        ["aab", 1, true],
        ["abab", 0, false],
        ["abab", 0, true],
        ["abab", 2, false],
        ["abab", 2, true]
      ])
      expect(wrong[0]).toMatchObject({ fast: { value: "A", end: 2 }, grammar: { value: "a", end: 2 } })
      // A fast path that accepts what the grammar rejects
      const greedy = (state: State<string>) => {
        state.pos = state.end
        return state.input
      }
      expect(Parser.verifyFastPath(grammar, greedy, ["b"])[0]).toMatchObject({ grammar: { failed: "Backtrack" } })
    })
  })

  it("takeTill searches for its stop characters (#75)", () => {
    const random = rng(75)
    // Astral characters and lone surrogates: a `Token` set accepts both
    const fill = ["a", "😀", "\ud800", "é", "b"]
    const run = (n: number) => Array.from({ length: n }, () => fill[Math.floor(random() * fill.length)]).join("")
    const lengths = [0, 1, 7, 8, 9, 15, 16, 17, 33, 1000]
    const quoted = Parser.repeat(
      Parser.terminated(
        Parser.delimited(Token.literal('"'), Token.takeTill('"'), Token.literal('"')),
        Token.takeWhile(",\r\n", { min: 1 })
      )
    )
    const plain = Parser.repeat(
      Parser.terminated(Token.takeTill(",\r\n", { min: 1 }), Token.takeWhile(",\r\n", { min: 1 }))
    )
    // The second branch searches again from before the first one's stop
    const backtracking = Parser.repeat(
      Parser.alt(
        Parser.seq(Token.takeTill(",;"), Token.literal(",x")),
        Parser.seq(Token.takeTill(",;"), Token.oneOf(",;"))
      )
    )
    const inputs = lengths.flatMap((n) => [
      `"${run(n)}",\n"${run(n)}"\r\n`,
      `"${run(n)}",${'"'}${run(n)}`,
      `${run(n)},${run(n)}\n${run(n)}`,
      `${run(n)}\r${run(n)},`,
      `${run(n)},x${run(n)};${run(n)},`,
      `${run(n)};${run(n)}`
    ])
    inputs.forEach((input) => [quoted, plain, backtracking].forEach((p) => same(p, input)))
  })

  it("takeTill keeps its searches per state, across runs (#75)", () => {
    const field = Token.takeTill(",;")
    const separator = Token.oneOf(",;")
    /** The fields of `text`, one run of `step` each, on one state reset before every run. */
    const lex = (step: (state: State<string>) => string | Fail, text: string): ReadonlyArray<string> => {
      const state = new State(text)
      const next = (): ReadonlyArray<string> => {
        if (state.pos >= state.end) return []
        const v = step(state.reset(state.pos))
        if (v === Fail) return []
        return Parser.run(separator, state.reset(state.pos)) === Fail ? [v] : [v, ...next()]
      }
      return next()
    }
    const text = Array.from({ length: 50 }, (_, i) => "x".repeat(i * 7)).join(",")
    const expected = lex(field.step, text)
    backends.forEach((backend) => {
      const run = Compiler.runner(Compiler[backend](Parser.named(field, "field")))
      expect(lex(run, text), backend).toEqual(expected)
      // Another state over another input: nothing is carried over
      expect(lex(run, text.replaceAll(",", ";")), backend).toEqual(lex(field.step, text.replaceAll(",", ";")))
      expect(lex(run, text), backend).toEqual(expected)
    })
  })

  it("seq tuples of every arity, by literal up to 8 and past it (#86)", () => {
    Array.from({ length: 11 }, (_, n) => n).forEach((n) => {
      const p = Parser.seq(...Array.from({ length: n }, () => Parser.alt(a, b)))
      const input = "ab".repeat(n).slice(0, n)
      expect(Parser.parse(p, input)).toEqual(Result.succeed(input.split("")))
      // Each position can fail, and the output can be unused
      allStrings(["a", "b", "0"], Math.min(n + 1, 4)).forEach((x) => same(p, x))
      allStrings(["a", "b"], Math.min(n, 3)).forEach((x) => same(Parser.taken(p), x))
    })
  })

  it("fromEntries keys", () => {
    const sym = Symbol("s")
    const key = Parser.alt(
      Token.literal("p").pipe(Parser.as("__proto__")),
      Token.literal("t").pipe(Parser.as("toString")),
      Token.literal("x").pipe(Parser.as("x")),
      // An object key that converts to "x", and one whose conversion counts
      Token.literal("o").pipe(Parser.map(() => ({ toString: () => "x" }))),
      Token.literal("s").pipe(Parser.as(sym)),
      Token.literal("1").pipe(Parser.as(1)),
      Token.literal("n").pipe(Parser.as(null))
    )
    const entries = Parser.fromEntries(
      // SAFETY: a deliberate type lie: the keys include an object, `null` and
      // a number, which `fromEntries` converts as `Object.fromEntries` does.
      Parser.repeat(Parser.seq(key, Token.oneOf("abc"))) as Parser.Parser<Array<[string, string]>>
    )
    const describe = (o: any) => ({
      proto: Object.getPrototypeOf(o) === Object.prototype,
      keys: Reflect.ownKeys(o).map(String),
      values: Reflect.ownKeys(o).map((k) => o[k]),
      descriptors: Reflect.ownKeys(o).map((k) => Object.getOwnPropertyDescriptor(o, k))
    })
    allStrings(["pa", "tb", "xa", "oc", "sb", "1a", "nb"], 3)
      .map((s) => s)
      .forEach((input) => {
        const expected = describe(Parser.parseSync(entries, input))
        backends.forEach((backend) => {
          expect(describe(Parser.parseSync(twin(entries, backend), input)), `${backend} on ${input}`).toEqual(expected)
        })
      })
  })

  it("cut and lookahead errors (#21)", () => {
    const ident = Parser.taken(
      Parser.seq(
        Token.takeWhile("abcx", { min: 1 }),
        Parser.optional(Parser.seq(Token.literal(":"), Token.takeWhile("abc", { min: 1 })))
      )
    )
    const notReserved = Parser.flatMap(Parser.peek(ident), (name) =>
      name === "x" ? Parser.cut(Parser.reject) : ident
    ).pipe(Parser.expected("identifier"))
    const p = Parser.alt(
      Parser.terminated(notReserved, Token.literal(";")),
      Parser.preceded(Parser.not(Parser.seq(Token.literal("a"), Token.literal(":"))), Parser.cut(Token.literal("c;")))
    )
    allStrings(["x", "a", "b", "c", ":", ";"], 4).forEach((input) => same(p, input))
  })

  it("a branch led by not(p) starts with p's first units and what follows (#84)", () => {
    const iri = Parser.seq(Token.literal("<"), Token.takeTill(">"), Token.literal(">"))
    const arrow = Parser.preceded(Parser.seq(Parser.not(iri), Token.literal("<-")), Ascii.alpha1)
    const first = new FirstSets(0).of(arrow)
    expect(first.mode).toBe(0)
    expect([...first.units.keys()].filter((u) => first.units[u] === 1)).toEqual(["<".charCodeAt(0)])
    // A lookahead over an unknown parser leaves the branch unknown
    expect(new FirstSets(0).of(Parser.preceded(Parser.not(Parser.make(() => undefined)), a)).mode).toBe(2)
    const p = Parser.alt(arrow, Parser.preceded(Parser.not(Parser.preceded(iri, Parser.cut(a))), Ascii.alpha1), iri)
    allStrings(["<", ">", "-", "a", "x"], 4).forEach((input) => same(p, input))
  })

  it("array inputs", () => {
    const p = Parser.separated(Token.oneOf<ReadonlyArray<string>>(["x", "y"]), Token.literal(["+"]))
    allStrings(["x", "y", "+", "z"], 5).forEach((input) => same(p, Array.from(input)))
  })

  it("token parsers on array inputs", () => {
    type Tok = { readonly kind: string }
    const isX = (t: Tok) => t.kind === "x"
    const kindOf = Parser.map(Parser.peek(Token.anyToken<ReadonlyArray<Tok>>()), (t) => t.kind)
    const p = Parser.alt(
      Parser.seq(Token.oneOf<ReadonlyArray<Tok>>(isX), Token.takeWhile<ReadonlyArray<Tok>>(isX, { min: 1, max: 2 })),
      Parser.dispatch(kindOf, {
        y: Parser.preceded(Token.anyToken<ReadonlyArray<Tok>>(), Token.takeTill<ReadonlyArray<Tok>>(isX)),
        z: Parser.seq(Token.noneOf<ReadonlyArray<Tok>>(isX), Token.takeWhile<ReadonlyArray<Tok>>(isX, 2))
      }),
      Parser.taken(Parser.repeat(Token.noneOf<ReadonlyArray<Tok>>(isX), { min: 1 }))
    )
    allStrings(["x", "y", "z"], 5).forEach((input) =>
      same(
        p,
        Array.from(input, (kind) => ({ kind }))
      )
    )
  })

  it("services", () => {
    class Limit extends Context.Service<Limit, number>()("Limit") {}
    const p = Parser.service(Limit).pipe(Parser.flatMap((n) => Parser.repeat(a, { max: n })))
    const q = Parser.seq(p, Parser.provideService(p, Limit, 1))
    allStrings(["a", "b"], 5).forEach((input) => same(q, input, Context.make(Limit, 2)))
  })

  it("checked many inputs", () => {
    expect(checked).toBeGreaterThan(200_000)
  })
})

// -----------------------------------------------------------------------------
// Behaviour of Compiler.jit and Compiler.closure
// -----------------------------------------------------------------------------

describe.each(backends)("Compiler.%s", (backend) => {
  const compile: typeof Compiler.jit = Compiler[backend]
  it("returns the same parser, and is pipeable", () => {
    const p = Parser.repeat(a)
    expect(Compiler[backend](p)).toBe(p)
    const q = Parser.repeat(b)
    expect(q.pipe(compile)).toBe(q)
    expect(Parser.parse(q, "bb")).toEqual(Result.succeed(["b", "b"]))
    expect(Registry.compiled(q, 0)?.backend).toBe(backend)
  })

  it("re-runs the interpreter for errors, so callbacks may run twice", () => {
    let calls = 0
    const p = Compiler[backend](Parser.terminated(digit.pipe(Parser.tap(() => calls++)), b))
    expect(Result.isSuccess(Parser.parse(p, "1b"))).toBe(true)
    expect(calls).toBe(1)
    calls = 0
    const err = Parser.parse(p, "1c")
    expect(Result.isFailure(err)).toBe(true)
    expect(calls).toBe(2)
  })

  it("stays interpreted with tracing and recovery", () => {
    const events: Array<string> = []
    const p = Compiler[backend](Parser.trace(Parser.resumeAfter(a, Token.any), "t"))
    Parser.parse(p, "a", { trace: (e) => events.push(e._tag) })
    expect(events).toEqual(["Enter", "Exit"])
    const r = Parser.parseRecoverable(p, "x")
    expect(r.errors.length).toBe(1)
  })

  it("is safe to re-enter from a callback", () => {
    const inner = Compiler[backend](Parser.repeat(digit))
    const outer = Compiler[backend](
      Parser.separated(
        Token.takeWhile("0123456789", { min: 1 }).pipe(Parser.map((s) => Parser.parseSync(inner, s).length)),
        b
      )
    )
    expect(Parser.parseSync(outer, "12b345")).toEqual([2, 3])
  })

  it("reports what runs interpreted in the JSON grammar", () => {
    const p = twin(Json.json, backend)
    Parser.parse(p, "1")
    const fallbacks = defined(Registry.compiled(p, 0)).fallbacks
    expect(fallbacks.map((f) => f.tag)).toEqual(["FlatMap"])
  })

  it("compiles the parsers inside a combinator", () => {
    // The parsers inside are a `make` (which stays interpreted) and compiled tokens
    const opaque = Parser.make<string>((state) => {
      if (state.pos < state.end && state.input[state.pos] === "x") return state.input[state.pos++]
      return state.backtrack("Token", ["x"])
    }, "x")
    const p = twin(
      Parser.combinator([Parser.alt(a, opaque), Token.literal(",")], ([item, sep]) => (state) => {
        const first = item(state)
        return first === Fail ? Fail : sep(state) === Fail ? Fail : first
      }),
      backend
    )
    Parser.parse(p, "a,")
    const fallbacks = defined(Registry.compiled(p, 0)).fallbacks
    // The WebAssembly scan runs the combinator as an island: its JIT-compiled step, whose parsers compile
    expect(fallbacks.map((f) => (backend === "wasm" ? f.tag : f.name))).toEqual([
      backend === "wasm" ? "Combinator" : "x"
    ])
  })

  it("an interpreted guard builds no failure inside compiled code (#82)", () => {
    const built: Array<boolean> = []
    const guard = Parser.make<undefined>((state) => {
      const before = state.failureHead
      const c = state.pos < state.end ? state.input[state.pos] : ""
      const r = c >= "0" && c <= "9" ? undefined : state.backtrack("Token", ["a digit"])
      built.push(state.failureHead !== before)
      return r
    }, "digit guard")
    const p = Parser.separated(Parser.alt(Parser.preceded(guard, Ascii.digit1), Ascii.alpha1), Token.literal(" "))
    const compiled = Compiler[backend](p)
    expect(Parser.parse(compiled, "ab 12 cd")).toEqual(Result.succeed(["ab", "12", "cd"]))
    expect(built).toEqual([false, false, false])
    // The interpreted re-run builds the error, which is the interpreter's
    ;["ab 12 cd!", "ab 1x", "", "ab  cd"].forEach((input) => same(p, input))
    // A step that throws leaves a caller-owned state as it found it
    const throwing = Compiler[backend](
      Parser.alt(
        Parser.make(() => {
          throw new RangeError("boom")
        }),
        a
      )
    )
    const state = new State("a")
    expect(() => Parser.run(throwing, state)).toThrow("boom")
    expect(state.compiledRun).toBe(false)
  })

  it("runs a state whose end is not the input's length", () => {
    const p = Compiler[backend](Parser.repeat(a))
    Parser.parse(p, "")
    const state = new State("aaa")
    state.end = 2
    expect(defined(Registry.stepFor(p, state))(state)).toEqual(["a", "a"])
  })

  it("takeUntil does not match past a state's end (#30)", () => {
    const p = Compiler[backend](Token.takeUntil("-->"))
    Parser.parse(p, "-->")
    const state = new State("abcdefg-->h")
    state.end = 3
    expect(Predicate.isSymbol(defined(Registry.stepFor(p, state))(state))).toBe(true)
    const fits = new State("abc-->h")
    fits.end = 6
    expect(defined(Registry.stepFor(p, fits))(fits)).toBe("abc")
  })
})

// -----------------------------------------------------------------------------
// Running from an offset
// -----------------------------------------------------------------------------

/**
 * A compiled twin of `p` whose root `step` (the interpreter) counts its
 * calls, so tests can tell whether a runner took the compiled path.
 */
const watched = <P extends Parser.Parser.Any>(p: P, backend: Backend) => {
  const c = Compiler[backend](Parser.named(p, "watched"))
  const step = c.step
  // SAFETY: `c` is `p` renamed (`Parser.named`) and registered for a
  // compiler; it runs on the same input and produces the same values as `p`.
  const counter = { parser: c as P, interpreted: 0 }
  Object.defineProperty(c, "step", {
    value: (state: State<any>) => {
      counter.interpreted++
      return step(state)
    }
  })
  return counter
}

/**
 * Shifts the offsets in an outcome of `parse`, `parsePeek` or
 * `parsePartial` by `by`, leaving out the message, whose line and column
 * are counted in the whole input.
 */
const shifted = (o: any, by: number) => {
  if (!o.ok) return { ...o, error: { ...o.error, offset: o.error.offset + by, message: undefined } }
  if (o.value?._tag === "Done") return { ...o, value: { ...o.value, offset: o.value.offset + by } }
  return o
}

const concatInput = (a: Input.Input, b: Input.Input): Input.Input => {
  if (Predicate.isString(a) && Predicate.isString(b)) return a + b
  if (!(a instanceof Uint8Array && b instanceof Uint8Array)) return assert.fail("concatInput: mixed inputs")
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/**
 * Checks that running `p` from just after `prefix` gives the results of
 * running it on `input`, with offsets moved by the length of the prefix
 * (unless it returns `positions`); that it gives the same results compiled;
 * and that compiled runs call the interpreter only to report a failure or
 * `Incomplete`. With `leafRoot`, `p` may be a token parser, which the
 * resumable build runs interpreted near the end of partial input, so
 * partial runs are not counted.
 */
const sameAtOffset = (
  p: Parser.Parser.Any,
  prefix: Input.Input,
  input: Input.Input,
  options?: { readonly positions?: boolean; readonly leafRoot?: boolean }
): void => {
  const whole = concatInput(prefix, input)
  const offset = prefix.length
  const label = Formatter.formatJson(Predicate.isString(input) ? input : Array.from(input))
  Record.toEntries(runners).forEach(([runner, run]) => {
    const expected: any = outcome(run(p, whole, { offset }))
    // Values that are positions (spans, `location`) are positions in the whole input
    if (!options?.positions) {
      assert.deepEqual(
        shifted(expected, 0),
        shifted(outcome(run(p, input)), offset),
        `${runner}, interpreted on ${label}`
      )
    }
    backends.forEach((backend) => {
      const w = watched(p, backend)
      expect(outcome(run(w.parser, whole, { offset })), `${runner}, ${backend} on ${label}`).toEqual(expected)
      // Unless the root itself runs interpreted (`permutation`, say)
      const kind = new State(whole).inputKind
      const rootFallback = defined(Registry.compiled(w.parser, kind, runner === "partial")).fallbacks.some(
        (f) => f.name === "watched"
      )
      if (rootFallback || (runner === "partial" && options?.leafRoot)) return
      // An error is built interpreted; `Incomplete` comes from the compiled run itself
      const rerun = !expected.ok
      expect(w.interpreted, `${runner}, ${backend} on ${label}: interpreted runs`).toBe(rerun ? 1 : 0)
    })
  })
}

/** Runs a parser on a fresh state with `run`: its value and position, or its failure. */
const stateOutcome = (run: Parser.Parser.Any["step"], input: Input.Input, partial: boolean) => {
  const state = new State(input, { partial })
  const a = run(state)
  return a === Fail ? { mode: state.mode, failure: state.reportedFailure() } : { value: a, pos: state.pos }
}

describe("Parser.run", () => {
  it("agrees with the step, compiled or not, in complete and partial mode", () => {
    const check = (name: string, g: Parser.Parser.Any, input: string, partial: boolean) => {
      const expected = stateOutcome(g.step, input, partial)
      const label = `${name} on "${input}", partial: ${partial}`
      expect(
        stateOutcome((s) => Parser.run(g, s), input, partial),
        `${label}, interpreted`
      ).toEqual(expected)
      backends.forEach((backend) => {
        const c = twin(g, backend)
        expect(
          stateOutcome((s) => Parser.run(c, s), input, partial),
          `${label}, ${backend}`
        ).toEqual(expected)
      })
    }
    const inputs = allStrings(alphabet, 2)
    grammars.forEach(([name, g]) =>
      inputs.forEach((input) => [false, true].forEach((partial) => check(name, g, input, partial)))
    )
  }, 30_000)

  it("reports Incomplete compiled as the interpreter does, needed included", () => {
    const inputs = allStrings(alphabet, 3)
    grammars.forEach(([name, g]) =>
      backends.forEach((backend) => {
        const c = twin(g, backend)
        inputs.forEach((input) => {
          const label = `${name} on "${input}", ${backend}`
          expect(Parser.parsePartial(c, input), label).toEqual(Parser.parsePartial(g, input))
          const state = new State(input, { partial: true })
          if (Parser.run(c, state, { diagnostics: false }) !== Fail || state.mode !== "Incomplete") return
          const reference = new State(input, { partial: true })
          expect(g.step(reference), label).toBe(Fail)
          expect([reference.mode, reference.failure.needed], label).toEqual(["Incomplete", state.failure.needed])
        })
      })
    )
  }, 60_000)

  it.each([
    ["json.ts", Json.json, (s: string): Input.Input => s],
    ["json-text, Text.utf8", jsonGrammar(Text.utf8), (s: string): Input.Input => new TextEncoder().encode(s)],
    [
      "json-fast, Text.utf16le",
      JsonFast.jsonGrammar(Text.utf16le),
      (s: string): Input.Input => Encoding.utf16le.encode(s)
    ]
  ] as const)(
    "parsePartial agrees compiled on every prefix of JSON (%s)",
    (_, g, encode) => {
      const docs = ['{"a": [1, -2.5e3, true, null, "x\\n\\u00e9😀\\"q"], "b": {}} ', jsonDocs[3], jsonDocs[7]]
      const p: Parser.Parser<unknown, never, never, any> = g
      backends.forEach((backend) => {
        const c = twin(p, backend)
        docs.forEach((doc) =>
          Array.from({ length: doc.length + 1 }, (_, i) => i).forEach((i) => {
            const input = encode(doc.slice(0, i))
            expect(Parser.parsePartial(c, input), `${backend}, prefix of ${i} characters`).toEqual(
              Parser.parsePartial(p, input)
            )
          })
        )
      })
    },
    60_000
  )

  it.each(backends)("runs compiled with the %s backend, interpreting only failures", (backend) => {
    const token = Parser.preceded(Ascii.multispace0, Parser.alt(Ascii.alpha1, Ascii.digit1, Token.literal("=")))
    const w = watched(token, backend)
    const state = new State("let x = 10;")
    const next = (): ReadonlyArray<string> => {
      const t = Parser.run(w.parser, state.reset(state.pos, { partial: true }))
      return t === Fail ? [] : [t, ...next()]
    }
    expect(next()).toEqual(["let", "x", "=", "10"])
    // Only the failure at ";" ran interpreted, and left the interpreter's failure
    expect(w.interpreted).toBe(1)
    expect(state.pos).toBe(10)
    expect(state.mode).toBe("Backtrack")
    expect(state.reportedFailure().offset).toBe(10)
    // At the end of a partial input, the step reports `Incomplete`
    w.interpreted = 0
    expect(Parser.run(w.parser, new State("let x", { partial: true, offset: 3 }))).toBe(Fail)
    expect(w.interpreted).toBe(1)
    expect(Parser.run(w.parser, new State("let x", { offset: 3 }))).toBe("x")
    expect(w.interpreted).toBe(1)
  })

  it.each(backends)("skips the interpreted re-run with diagnostics off (%s)", (backend) => {
    const w = watched(Parser.delimited(Token.literal("("), Ascii.digit1, Token.literal(")")), backend)
    const state = new State("(12) (x)")
    expect(Parser.run(w.parser, state, { diagnostics: false })).toBe("12")
    const before = state.failure
    // Fails after reading "(": the mode is set, the cursor is back where the run started
    expect(Parser.run(w.parser, state.reset(5), { diagnostics: false })).toBe(Fail)
    expect(state.mode).toBe("Backtrack")
    expect(state.pos).toBe(5)
    expect(state.failure).toBe(before)
    expect(w.interpreted).toBe(0)
    // `Incomplete` on a partial input, and `Cut` from a committed failure
    expect(Parser.run(w.parser, new State("(1", { partial: true }), { diagnostics: false })).toBe(Fail)
    const partial = new State("(1", { partial: true })
    Parser.run(w.parser, partial, { diagnostics: false })
    expect(partial.mode).toBe("Incomplete")
    const committed = Compiler[backend](Parser.preceded(Token.literal("("), Parser.cut(Ascii.digit1)))
    const cut = new State("(x")
    expect(Parser.run(committed, cut, { diagnostics: false })).toBe(Fail)
    expect(cut.mode).toBe("Cut")
    expect(w.interpreted).toBe(0)
    // With diagnostics (the default), the failure is the interpreter's
    expect(Parser.run(w.parser, state.reset(5))).toBe(Fail)
    expect(w.interpreted).toBe(1)
    expect(state.failure.offset).toBe(6)
  })

  it("runs interpreted under a tracer or with recovery on", () => {
    const w = watched(Ascii.alpha1, "jit")
    const traced = new State("abc")
    traced.tracer = () => {}
    expect(Parser.run(w.parser, traced)).toBe("abc")
    const recovering = new State("abc")
    recovering.recovered = []
    expect(Parser.run(w.parser, recovering)).toBe("abc")
    expect(w.interpreted).toBe(2)
  })

  it("reports deep nesting as a TooDeep failure", () => {
    const nested: Parser.Parser<unknown> = Parser.alt(
      Parser.delimited(
        Token.literal("["),
        Parser.suspend(() => nested),
        Token.literal("]")
      ),
      Token.literal("x")
    )
    const c = Compiler.jit(nested)
    const state = new State("[".repeat(200_000))
    expect(Parser.run(c, state)).toBe(Fail)
    expect(state.mode).toBe("Cut")
    expect(state.failure.kind).toBe("TooDeep")
  })
})

describe("Compiler.runner", () => {
  it("agrees with Parser.run, compiled or not, in complete and partial mode", () => {
    const inputs = allStrings(alphabet, 2)
    grammars.forEach(([name, g]) => {
      const runners = [
        ["interpreted", g, Compiler.runner(g)] as const,
        ...backends.map((backend) => {
          const c = twin(g, backend)
          return [backend, c, Compiler.runner(c)] as const
        })
      ]
      inputs.forEach((input) =>
        [false, true].forEach((partial) =>
          runners.forEach(([label, p, run]) => {
            expect(stateOutcome(run, input, partial), `${name} on "${input}", partial: ${partial}, ${label}`).toEqual(
              stateOutcome((s) => Parser.run(p, s), input, partial)
            )
          })
        )
      )
    })
  }, 30_000)

  it.each(backends)("follows the state's input kind, mode and end (%s)", (backend) => {
    const w = watched(Parser.terminated(Ascii.digit1, Token.literal(";")), backend)
    const run: (state: State<any>) => string | Uint8Array | typeof Fail = Compiler.runner(w.parser)
    expect(run(new State("12;"))).toBe("12")
    expect(run(new State(new TextEncoder().encode("34;")))).toEqual(new TextEncoder().encode("34"))
    // Partial states run the resumable build, and report `Incomplete`
    const partial = new State("56", { partial: true })
    expect(run(partial)).toBe(Fail)
    expect(partial.mode).toBe("Incomplete")
    expect(run(new State("78;"))).toBe("78")
    // A state that ends before its input's end
    const short = new State("9;0;")
    short.end = 2
    expect(run(short)).toBe("9")
    short.reset(0).end = 1
    expect(run(short)).toBe(Fail)
    expect(short.failure.offset).toBe(1)
    // Every failure above ran interpreted once (two), and nothing else did
    expect(w.interpreted).toBe(2)
  })

  it.each(backends)("skips the interpreted re-run with diagnostics off (%s)", (backend) => {
    const w = watched(Parser.delimited(Token.literal("("), Ascii.digit1, Token.literal(")")), backend)
    const run = Compiler.runner(w.parser, { diagnostics: false })
    const state = new State("(12) (x)")
    expect(run(state)).toBe("12")
    const before = state.failure
    expect(run(state.reset(5))).toBe(Fail)
    expect(state.mode).toBe("Backtrack")
    expect(state.pos).toBe(5)
    expect(state.failure).toBe(before)
    expect(w.interpreted).toBe(0)
  })

  it("runs interpreted under a tracer or with recovery on", () => {
    const w = watched(Ascii.alpha1, "jit")
    const run = Compiler.runner(w.parser)
    const traced = new State("abc")
    traced.tracer = () => {}
    expect(run(traced)).toBe("abc")
    expect(run(new State("abc"))).toBe("abc")
    expect(w.interpreted).toBe(1)
  })

  it.each(backends)("reports deep nesting as a TooDeep failure (%s)", (backend) => {
    const nested: Parser.Parser<unknown> = Parser.alt(
      Parser.delimited(
        Token.literal("["),
        Parser.suspend(() => nested),
        Token.literal("]")
      ),
      Token.literal("x")
    )
    const run = Compiler.runner(Compiler[backend](nested))
    const state = new State("[".repeat(200_000))
    expect(run(state)).toBe(Fail)
    expect(state.mode).toBe("Cut")
    expect(state.failure.kind).toBe("TooDeep")
    // With diagnostics off, the compiled run's own TooDeep failure
    const quick = new State("[".repeat(200_000))
    expect(Compiler.runner(Compiler[backend](nested), { diagnostics: false })(quick)).toBe(Fail)
    expect(quick.mode).toBe("Cut")
  })
})

describe("ParserStream.parseMany", () => {
  it.each(backends)("runs compiled with the %s backend, interpreting only where a chunk ends", (backend) => {
    const line = Parser.terminated(Ascii.decInt, Token.literal("\n"))
    const w = watched(line, backend)
    const collect = (p: typeof line, chunks: ReadonlyArray<string>) =>
      Effect.runSync(Stream.fromIterable(chunks).pipe(ParserStream.parseMany(p), Stream.runCollect))
    const chunks = ["1\n2", "3\n-4\n5", "\n6\n"]
    expect(collect(w.parser, chunks)).toEqual(collect(line, chunks))
    expect(collect(w.parser, chunks)).toEqual([1, 23, -4, 5, 6])
    // "2" and "5", cut short by their chunk, end `Incomplete` compiled: nothing runs interpreted
    expect(w.interpreted).toBe(0)
    const failed = Effect.runSync(
      Effect.flip(Stream.fromIterable(["1\nx\n"]).pipe(ParserStream.parseMany(w.parser), Stream.runCollect))
    )
    // The interpreter's error, with offsets in the buffer of unconsumed input
    expect(w.interpreted).toBe(1)
    assert(Predicate.isTagged(failed, "ParseError"))
    expect(failed.offset).toBe(2)
    expect(failed.input).toBe("1\nx\n")
  })
})

describe("running from an offset", () => {
  it("json (Token/Ascii)", () => {
    jsonInputs.forEach((input) => sameAtOffset(Json.json, "[1, 2] ", input))
  })

  it("json-text with Text.utf8", () => {
    const p = jsonGrammar(Text.utf8)
    const prefix = Encoding.utf8.encode("é😀{")
    jsonInputs.forEach((input) => sameAtOffset(p, prefix, Encoding.utf8.encode(input)))
  })

  // Every grammar on every short string, in every runner and backend, each
  // run compiling a fresh parser (`watched`): about 25 s, mostly compiling
  // (a WebAssembly module takes about 0.5 ms), and two to three times that
  // under coverage
  it("combinators", () => {
    grammars.forEach(([name, g]) => {
      const positions = name === "taken and spans" || name === "eof, location, rest" || name === "mapSpan and seqWith"
      allStrings(alphabet, 2).forEach((input) => sameAtOffset(g, "ab\n", input, { positions, leafRoot: true }))
    })
  }, 120_000)

  it.each(backends)("takes the compiled path with the %s backend, in complete and partial mode", (backend) => {
    const token = Parser.preceded(Ascii.multispace0, Parser.alt(Ascii.alpha1, Ascii.digit1, Token.literal("=")))
    const w = watched(token, backend)
    const buffer = "let x = 10;"
    // A lexer loop: one token at a time, in partial mode, until the buffer runs out
    const tokens: Array<string> = []
    const lex = (offset: number): number => {
      const r = Parser.parsePartial(w.parser, buffer, { offset })
      if (Result.isFailure(r) || r.success._tag === "Incomplete") return offset
      tokens.push(r.success.value)
      return lex(r.success.offset)
    }
    const offset = lex(0)
    expect(tokens).toEqual(["let", "x", "=", "10"])
    expect(offset).toBe(10)
    // Only the final failure (at ";") ran interpreted
    expect(w.interpreted).toBe(1)
    w.interpreted = 0
    expect(Parser.parsePartial(w.parser, "let x", { offset: 3 })).toEqual(
      Result.succeed({ _tag: "Incomplete", needed: Option.some(1) })
    )
    // `Incomplete`, `needed` included, comes from the compiled run: nothing runs interpreted
    expect(w.interpreted).toBe(0)
    w.interpreted = 0
    expect(Parser.parse(w.parser, buffer.slice(0, 10), { offset: 7 })).toEqual(Result.succeed("10"))
    expect(Parser.parsePeek(w.parser, buffer, { offset: 3 })).toEqual(Result.succeed([" = 10;", "x"]))
    expect(Parser.parseSync(w.parser, "let x", { offset: 3 })).toBe("x")
    expect(w.interpreted).toBe(0)
    expect(Registry.compiled(w.parser, 0, false)?.backend).toBe(backend)
    // The streaming build of the WebAssembly compiler is the JIT's
    expect(Registry.compiled(w.parser, 0, true)?.backend).toBe(backend === "wasm" ? "jit" : backend)
  })

  it("reports offsets, lines and columns in the whole input", () => {
    const p = Compiler.jit(Parser.terminated(Ascii.decInt, Token.literal(";")))
    const r = Parser.parse(p, "1;\n2;\n3?", { offset: 6 })
    expect(Result.isFailure(r) && r.failure.offset).toBe(7)
    expect(Result.isFailure(r) && r.failure.position).toMatchObject({ line: 3, column: 2 })
    expect(Parser.parsePeek(Parser.span(Token.take(1)), "abc", { offset: 2 })).toEqual(
      Result.succeed(["", { start: 2, end: 3 }])
    )
  })

  it("rejects offsets outside the input", () => {
    ;[-1, 4, 1.5, Number.NaN].forEach((offset) => {
      expect(() => Parser.parse(Token.rest, "abc", { offset })).toThrow(RangeError)
    })
    expect(Parser.parse(Token.rest, "abc", { offset: 3 })).toEqual(Result.succeed(""))
  })
})

describe("the JIT", () => {
  it("falls back to the closure compiler where new Function is blocked", () => {
    vi.stubGlobal("Function", function () {
      throw new EvalError("Refused to evaluate a string as JavaScript")
    })
    try {
      const p = Compiler.jit(Parser.repeat(a))
      expect(Parser.parse(p, "aa")).toEqual(Result.succeed(["a", "a"]))
      expect(Registry.compiled(p, 0)?.backend).toBe("closure")
    } finally {
      vi.unstubAllGlobals()
    }
    const q = Compiler.jit(Parser.repeat(a))
    Parser.parse(q, "a")
    expect(Registry.compiled(q, 0)?.backend).toBe("jit")
  })
})

describe("a bounded repetition checks progress (#115)", () => {
  const b = (...xs: ReadonlyArray<number>) => new Uint8Array(xs)
  const optA = Parser.opt(a)
  const comma = Token.literal(",")
  const text: ReadonlyArray<[name: string, p: Parser.Parser.Any]> = [
    ["repeat(opt(a), 3)", Parser.repeat(optA, 3)],
    ["repeat(opt(a), { min: 1, max: 4 })", Parser.repeat(optA, { min: 1, max: 4 })],
    ["repeat(succeed(0), 2)", Parser.repeat(Parser.succeed(0), 2)],
    ["repeat(takeWhile(a), { max: 2 })", Parser.repeat(Token.takeWhile("a"), { max: 2 })],
    ["repeat(a, 3)", Parser.repeat(a, 3)],
    ["repeat(a, { max: 2 }) then rest", Parser.seq(Parser.repeat(a, { max: 2 }), Token.rest)],
    ["fold(opt(a), { max: 3 })", Parser.fold(optA, { range: { max: 3 }, init: () => 0, f: (n: number) => n + 1 })],
    ["separated(a, opt(comma), { max: 3 })", Parser.separated(a, Parser.opt(comma), { max: 3 })],
    ["separated(opt(a), comma, 2)", Parser.separated(optA, comma, 2)],
    ["separated(a, comma, { max: 2 })", Parser.separated(a, comma, { max: 2 })],
    ["repeatTill(opt(a), b, { max: 3 })", Parser.repeatTill(optA, Token.literal("b"), { max: 3 })],
    ["repeat(struct of optionals, 2)", Parser.repeat(Parser.struct({ x: optA, y: Parser.opt(comma) }), 2)],
    ["Nom.count(opt(a), 2)", Nom.count(optA, 2)]
  ]
  const strings = ["", "a", "aa", "aaa", "aaaa", "a,a", "a,a,a", "aab", "b", "ab", ",", "a,", "x"]

  it.each(text)("%s: every backend agrees", (_, p) => {
    strings.forEach((input) => same(p, input))
  })

  const counted: ReadonlyArray<[name: string, p: Parser.Parser.Any]> = [
    ["lengthRepeat(u8, succeed(0))", Binary.lengthRepeat(Binary.u8, Parser.succeed(0))],
    ["lengthRepeat(u8, opt(u8))", Binary.lengthRepeat(Binary.u8, Parser.opt(Binary.u8))],
    ["lengthRepeat(u8, take(0))", Binary.lengthRepeat(Binary.u8, Token.take<Uint8Array>(0))],
    ["lengthRepeat(u8, u8)", Binary.lengthRepeat(Binary.u8, Binary.u8)]
  ]
  const bytes = [b(), b(0), b(1), b(1, 7), b(2, 7), b(2, 7, 8), b(3, 7, 8), b(0xff), b(0xff, 1, 2, 3)]

  it.each(counted)("%s: every backend agrees", (_, p) => {
    bytes.forEach((input) => same(p, input))
  })

  it("an element that consumes nothing is an Assert failure, whatever the range", () => {
    const error = expectFailure(Parser.repeat(optA, 3), "ab")
    expect(error.kind).toBe("Assert")
    expect(error.mode).toBe("Cut")
    expect(error.offset).toBe(1)
    expect(error.message).toContain("`repeat` parsers must always consume")
    expect(expectFailure(Parser.separated(a, Parser.opt(comma), { max: 3 }), "aa").kind).toBe("Assert")
    // A repetition that never reaches such an element is unchanged
    expect(Parser.parse(Parser.repeat(optA, 3), "aaa")).toEqual(Result.succeed(Arr.replicate(Option.some("a"), 3)))
  })

  it("a count from the input cannot ask for more elements than the input has tokens", () => {
    // Used to succeed with 16 777 215 elements from 3 bytes, and to throw a RangeError from 4
    const started = performance.now()
    const three = Parser.parse(Binary.lengthRepeat(Binary.beU24, Parser.succeed(0)), b(0xff, 0xff, 0xff))
    const four = Parser.parse(Binary.lengthRepeat(Binary.beU32, Parser.succeed(0)), b(0xff, 0xff, 0xff, 0xff))
    assert(Result.isFailure(three))
    assert(Result.isFailure(four))
    expect(three.failure.kind).toBe("Assert")
    expect(four.failure.kind).toBe("Assert")
    expect(performance.now() - started).toBeLessThan(1000)
    backends.forEach((backend) => {
      const p = Compiler[backend](Binary.lengthRepeat(Binary.beU32, Parser.opt(Binary.u8)))
      const r = Parser.parse(p, b(0xff, 0xff, 0xff, 0xff, 1, 2, 3))
      assert(Result.isFailure(r), backend)
      expect(r.failure.kind, backend).toBe("Assert")
    })
  })
})

describe("hostile counts and bounds (#114, #121)", () => {
  /** A bound that is a number only in the types, as one read from JSON or a query string is. */
  const payload = "64&&(globalThis.effectParseHit=(globalThis.effectParseHit||0)+1,64)"
  // SAFETY: deliberately ill-typed, as `JSON.parse(text).max` is for a grammar that trusts its config: a string
  // where a `number` is declared
  const hostile: number = payload as never
  const hit = () => "effectParseHit" in globalThis

  const constructors: ReadonlyArray<[name: string, build: (n: number) => Parser.Parser.Any]> = [
    ["Token.take", (n) => Token.take(n)],
    ["Token.takeWhile max", (n) => Token.takeWhile("abc", { min: 1, max: n })],
    ["Token.takeWhile min", (n) => Token.takeWhile("abc", { min: n })],
    ["Token.takeWhile on arrays", (n) => Token.takeWhile<ReadonlyArray<number>>([1, 2], { max: n })],
    ["Token.takeTill", (n) => Token.takeTill("abc", n)],
    ["Token.takeUntil", (n) => Token.takeUntil("abc", { max: n })],
    ["Token.takeUntilAny", (n) => Token.takeUntilAny(["a", "b"], { min: n })],
    ["Text.utf8.take", (n) => Text.utf8.take(n)],
    ["Text.utf8.takeWhile", (n) => Text.utf8.takeWhile("abc", { max: n })],
    ["Text.utf8.takeUntil", (n) => Text.utf8.takeUntil("abc", { max: n })],
    ["Parser.repeat count", (n) => Parser.repeat(a, n)],
    ["Parser.repeat max", (n) => Parser.repeat(a, { max: n })],
    ["Parser.fold", (n) => Parser.fold(a, { range: { max: n }, init: () => 0, f: (acc: number) => acc + 1 })],
    ["Parser.repeatTill", (n) => Parser.repeatTill(a, Token.literal("b"), { min: n })],
    ["Parser.separated min", (n) => Parser.separated(a, Token.literal(","), { min: n })],
    ["Parser.separated max", (n) => Parser.separated(a, Token.literal(","), { max: n })],
    ["Bits.take", (n) => Bits.take(n)],
    ["Bits.takeBig", (n) => Bits.takeBig(n)],
    ["Bits.pattern", (n) => Bits.pattern(1, n)]
  ]

  it.each(constructors)("%s rejects a count that is not a non-negative integer", (_, build) => {
    ;[hostile, -1, 1.5, Number.NaN, -Infinity, 2 ** 53].forEach((n) => {
      expect(() => build(n), String(n)).toThrow(RangeError)
    })
    expect(hit()).toBe(false)
  })

  it("accepts the counts that are", () => {
    expect(() => constructors.forEach(([, build]) => [1, 7].forEach(build))).not.toThrow()
    expect(Parser.parsePeek(Token.take(0), "abc")).toEqual(Result.succeed(["abc", ""]))
    expect(Parser.parse(Parser.repeat(a, { min: 0, max: Infinity }), "aa")).toEqual(Result.succeed(["a", "a"]))
  })

  it("a range names its bad bound without printing it", () => {
    expect(() => Parser.repeat(a, { max: hostile })).toThrow(
      "invalid range: max: expected a non-negative integer, got a string"
    )
    expect(() => Token.take(-1)).toThrow("invalid count: expected a non-negative integer, got -1")
    expect(() => Token.takeWhile("a", { min: 3, max: 2 })).toThrow("invalid range: min (3) > max (2)")
  })

  it("rejects a control character that is not a character or its code", () => {
    const control = { charCodeAt: () => payload, codePointAt: () => payload }
    // SAFETY: deliberately ill-typed: an object answering `charCodeAt`, whose answer the JIT used to write into its source
    const hostileControl: string = control as never
    const escape = Token.literal("n")
    expect(() => Ascii.escaped(Token.takeTill("\\", { min: 1 }), hostileControl, escape)).toThrow(RangeError)
    expect(() => Ascii.takeEscaped(Token.takeTill("\\", { min: 1 }), hostileControl, escape)).toThrow(RangeError)
    expect(() =>
      Text.utf8.escaped(Text.utf8.takeTill("\\", { min: 1 }), hostileControl, Text.utf8.literal("n"))
    ).toThrow(RangeError)
    expect(() => Ascii.escaped(Token.takeTill("\\", { min: 1 }), "", escape)).toThrow(RangeError)
    expect(() => Ascii.escaped(Token.takeTill("\\", { min: 1 }), -1, escape)).toThrow(RangeError)
    expect(hit()).toBe(false)
  })

  it("the JIT writes no bound into its source that is not a number", () => {
    // A description built by hand, past the constructors' checks: the emitter refuses it on its own
    const descriptions: ReadonlyArray<Parser.Parser<unknown, never, never, string>> = [
      Parser.described(Parser.repeat(a).step, "repeat", { _tag: "Repeat", self: a, min: 0, max: hostile }),
      Parser.described(Parser.repeat(a).step, "repeat", { _tag: "Repeat", self: a, min: hostile, max: Infinity }),
      Parser.described(Token.takeWhile("a").step, "takeWhile", {
        _tag: "TakeWhile",
        set: "a",
        negate: false,
        min: 1,
        max: hostile,
        encoding: undefined
      }),
      Parser.described(Parser.separated(a, Token.literal(",")).step, "separated", {
        _tag: "Separated",
        self: a,
        separator: Token.literal(","),
        min: hostile,
        max: hostile
      })
    ]
    const builds = descriptions.map((description) => {
      const p = Compiler.jit(Parser.preceded(Token.literal("x"), description))
      Parser.parse(p, "xaaa")
      const compiled = defined(Registry.compiled(p, 0))
      return { backend: compiled.backend, refused: compiled.jitError instanceof TypeError }
    })
    // Where the emitter would have written the bound, it gives up and the closure compiler takes over
    expect(builds.filter((build) => build.backend !== "jit")).toEqual(
      builds.filter((build) => build.refused).map(() => ({ backend: "closure", refused: true }))
    )
    expect(builds.some((build) => build.refused)).toBe(true)
    expect(hit()).toBe(false)
  })

  describe("a count read from the input", () => {
    const b = (...xs: ReadonlyArray<number>) => new Uint8Array(xs)
    const float = Parser.map(Binary.beF32, (n) => n)
    const grammars: ReadonlyArray<[name: string, p: Parser.Parser.Any]> = [
      ["lengthTake(i8)", Binary.lengthTake(Binary.i8)],
      ["lengthTake(beI64)", Binary.lengthTake(Binary.beI64)],
      ["lengthTake(beU64)", Binary.lengthTake(Binary.beU64)],
      ["lengthTake(beF32)", Binary.lengthTake(float)],
      ["seq(lengthTake(i8), u8, u8)", Parser.seq(Binary.lengthTake(Binary.i8), Binary.u8, Binary.u8)],
      ["repeat(lengthTake(i8))", Parser.repeat(Binary.lengthTake(Binary.i8))],
      ["lengthRepeat(i8, u8)", Binary.lengthRepeat(Binary.i8, Binary.u8)],
      ["repeat(lengthRepeat(i8, u8))", Parser.repeat(Binary.lengthRepeat(Binary.i8, Binary.u8))],
      ["lengthAndThen(i8, rest)", Binary.lengthAndThen(Binary.i8, Token.restOf<Uint8Array>())]
    ]
    const inputs = [
      b(0xfe),
      b(0xfe, 1, 2, 3),
      b(0xff),
      b(0x80, 0, 0, 0, 0, 0, 0, 0, 1),
      b(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
      // 1.5 and NaN as big-endian floats
      b(0x3f, 0xc0, 0, 0, 1, 2),
      b(0x7f, 0xc0, 0, 0, 1, 2),
      b(2, 1, 2),
      b(0),
      b(1, 0xfe, 0xfe)
    ]

    it.each(grammars)("%s: every backend agrees", (_, p) => {
      inputs.forEach((input) => same(p, input))
    })

    it("a negative length fails at the length, and the cursor never moves back", () => {
      const negative = Parser.parsePeek(
        Parser.seq(Binary.lengthTake(Binary.i8), Binary.u8, Binary.u8),
        b(0xfe, 1, 2, 3)
      )
      assert(Result.isFailure(negative))
      expect(negative.failure.offset).toBe(0)
      expect(negative.failure.kind).toBe("Verify")
      // Used to alternate between -1 and 0 until the heap ran out
      expect(Parser.parsePeek(Parser.repeat(Binary.lengthTake(Binary.i8)), b(0xfe))).toEqual(
        Result.succeed([b(0xfe), []])
      )
      expect(Result.isFailure(Parser.parse(Binary.lengthRepeat(Binary.i8, Binary.u8), b(0xff)))).toBe(true)
      expect(Result.isFailure(Parser.parse(Binary.lengthTake(float), b(0x3f, 0xc0, 0, 0, 1, 2)))).toBe(true)
      expect(
        Result.isFailure(
          Parser.parse(Binary.lengthTake(Binary.beU64), b(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))
        )
      ).toBe(true)
    })

    it("a text protocol's signed length throws where the grammar builds the parser", () => {
      const netstring = Parser.flatMap(Ascii.decInt, (n) => Token.take(n))
      expect(() => Parser.parse(netstring, "-3:abc")).toThrow(RangeError)
    })
  })
})

describe("generated code stays proportional to the grammar (#122)", () => {
  const leaf: Parser.Parser.Any = Parser.map(a, (x) => x)
  /** `p` used twice by its parent, `levels` times over: 2^levels uses of the innermost parser. */
  const doubled = (levels: number): Parser.Parser.Any =>
    Arr.reduce(Arr.range(1, levels), leaf, (p): Parser.Parser.Any => Parser.seq(p, p))

  it.each(["jit", "wasm"] as const)("a parser used twice by one parent is generated once (%s)", (backend) => {
    const p = doubled(20)
    const compiled = Compiler[backend](p)
    const started = performance.now()
    // The first parse compiles: it took 22 s and 160 MB of source on the JIT, and ran wasm out of memory
    expect(Result.isFailure(runners.parse(compiled, "b"))).toBe(true)
    expect(performance.now() - started).toBeLessThan(2000)
    const built = defined(Registry.compiled(compiled, 0))
    expect(built.backend).toBe(backend)
    expect(defined(built.source).length).toBeLessThan(100_000)
    expect(outcome(runners.parse(compiled, "b"))).toEqual(outcome(runners.parse(p, "b")))
  })

  it("agrees with the interpreter on a doubled grammar, on every backend", () => {
    const p = doubled(4)
    ;["a".repeat(16), "a".repeat(15), `${"a".repeat(16)}a`, `${"a".repeat(7)}b`, ""].forEach((input) => same(p, input))
  })

  it("gives up generating code for a grammar of a hundred thousand distinct parsers", () => {
    /** A tree of distinct parsers: nothing is shared, so nothing can be made a rule. */
    const tree = (levels: number): Parser.Parser.Any =>
      levels === 0 ? Parser.map(Token.literal("a"), (x) => x) : Parser.seq(tree(levels - 1), tree(levels - 1))
    const p = tree(16)
    const input = "a".repeat(2 ** 16)
    const expected = runners.parse(p, input)
    expect(Result.isSuccess(expected)).toBe(true)
    ;(["jit", "wasm"] as const).forEach((backend) => {
      const compiled = Compiler[backend](p)
      const started = performance.now()
      expect(Result.isSuccess(runners.parse(compiled, input)), backend).toBe(true)
      expect(performance.now() - started, backend).toBeLessThan(10_000)
      const built = defined(Registry.compiled(compiled, 0))
      // The closure compiler takes over, and says why
      expect(built.backend, backend).toBe("closure")
      expect(String(built.jitError), backend).toContain("too large to generate code for")
    })
    expect(Result.isSuccess(runners.parse(Compiler.closure(p), input))).toBe(true)
  })
})

describe("the WebAssembly compiler", () => {
  /** A JSON document of `n` records, pretty-printed. */
  const records = (n: number) =>
    `[\n${Arr.makeBy(n, (i) => ` {\n  "id": ${i},\n  "name": "item ${i}",\n  "tags": ["a", "b"],\n  "price": ${i * 1.25}\n }`).join(",\n")}\n]`

  /** `p` compiled with the WebAssembly compiler parses `input` as the interpreter does, compiled. */
  const sameAsInterpreted = <A, E, I extends string | Uint8Array>(p: Parser.Parser<A, E, never, I>, input: I) => {
    const compiled = Compiler.wasm(Parser.named(p, "wasm"))
    expect(Parser.parse(compiled, input)).toEqual(Parser.parse(p, input))
    expect(Registry.compiled(compiled, Predicate.isString(input) ? 0 : 1)?.backend).toBe("wasm")
  }

  it("grows its trace past the memory it starts with", () => {
    // About 8 MB of trace: several times the initial memory
    const doc = records(40000)
    sameAsInterpreted(JsonFast.json, doc)
    sameAsInterpreted(JsonFast.jsonGrammar(Text.utf8), new TextEncoder().encode(doc))
  })

  it("parses again after a callback threw", () => {
    let calls = 0
    const p = Compiler.wasm(
      Parser.separated(
        Ascii.decUint.pipe(
          Parser.tap((n) => {
            calls++
            if (n === 13) throw new RangeError("unlucky")
          })
        ),
        Token.literal(",")
      )
    )
    expect(() => Parser.parseSync(p, "1,13,2")).toThrow("unlucky")
    expect(Parser.parseSync(p, "1,2,3")).toEqual([1, 2, 3])
    expect(Registry.compiled(p, 0)?.backend).toBe("wasm")
    expect(calls).toBeGreaterThan(3)
  })

  it("returns the same strings from its string cache, across parses", () => {
    const doc = '[{"key": "value", "k\\u00e9y": "é"}, {"key": "value", "k\\u00e9y": "é"}, "aé", "a\\u00e9"]'
    const expected = [{ key: "value", ["kéy"]: "é" }, { key: "value", ["kéy"]: "é" }, "aé", "aé"]
    const p = Compiler.wasm(Parser.named(JsonFast.json, "json"))
    const q = Compiler.wasm(JsonFast.jsonGrammar(Text.utf8))
    const bytes = new TextEncoder().encode(doc)
    Arr.makeBy(3, () => {
      expect(Parser.parseSync(p, doc)).toEqual(expected)
      expect(Parser.parseSync(q, bytes)).toEqual(expected)
    })
    // Slots shared by different strings of the same hash still give each its own text
    const many = Arr.makeBy(5000, (i) => `s${i % 1500}`)
    expect(Parser.parseSync(p, `[${many.map((s) => `"${s}"`).join(",")}]`)).toEqual(many)
  })

  it("converts floats exactly as Number does", () => {
    const random = rng(12)
    const digits = () => Arr.makeBy(1 + Math.floor(random() * 21), () => Math.floor(random() * 10)).join("")
    const texts = [
      "9007199254740993",
      "1.00000000000000011102230246251565404236316680908203125",
      "2.2250738585072011e-308",
      ...Arr.makeBy(20000, () => {
        const d = digits()
        return `${random() < 0.3 ? "-" : ""}${d}.${d.slice(0, 3)}e${Math.floor(random() * 50) - 25}`
      })
    ]
    const string = Compiler.wasm(Parser.named(Ascii.float, "float"))
    const bytes = Compiler.wasm(Parser.named(Text.utf8.float, "float"))
    const utf16 = Compiler.wasm(Parser.named(Text.utf16le.float, "float"))
    texts.forEach((text) => {
      const expected = Number(text)
      expect(Object.is(Parser.parseSync(string, text), expected), text).toBe(true)
      expect(Object.is(Parser.parseSync(bytes, new TextEncoder().encode(text)), expected), text).toBe(true)
      expect(Object.is(Parser.parseSync(utf16, Encoding.utf16le.encode(text)), expected), text).toBe(true)
    })
  })

  it("runs filter, tryMap and filterMap on values built from the trace", () => {
    const even = Parser.filter(Ascii.decUint, (n) => n % 2 === 0)
    const half = Parser.tryMap(Ascii.decUint, (n) => (n % 2 === 0 ? Result.succeed(n / 2) : Result.fail("odd")))
    const third = Parser.filterMap(Ascii.decUint, (n) => (n % 3 === 0 ? Option.some(n / 3) : Option.none()))
    const p = Parser.separated(
      Parser.alt(
        Parser.map(even, (n) => ["even", n]),
        Parser.map(half, () => "never"),
        Parser.map(third, (n) => ["third", n]),
        Parser.map(Ascii.decUint, (n) => ["other", n])
      ),
      Token.literal(",")
    )
    sameAsInterpreted(p, "4,9,7,12,15,1")
    const fast = Compiler.wasm(Parser.named(p, "p"))
    Parser.parse(fast, "4")
    expect(Registry.compiled(fast, 0)?.fallbacks).toEqual([])
  })

  it("copies strings exactly, lone surrogates and U+FFFD included", () => {
    const random = rng(21)
    const pieces = ["a", "é", "日", "😀", "\ud800", "\udc00", "\ufffd", "\u0000", "abcdefghijklmnopq"]
    const units = Parser.repeat(Token.any)
    const codePoints = Parser.repeat(Text.string.any)
    const fastUnits = Compiler.wasm(Parser.named(units, "units"))
    const fastCodePoints = Compiler.wasm(Parser.named(codePoints, "codePoints"))
    Arr.makeBy(2000, () =>
      Arr.makeBy(Math.floor(random() * 50), () => pieces[Math.floor(random() * pieces.length)]).join("")
    ).forEach((input) => {
      expect(Parser.parse(fastUnits, input)).toEqual(Parser.parse(units, input))
      expect(Parser.parse(fastCodePoints, input)).toEqual(Parser.parse(codePoints, input))
    })
    expect(Registry.compiled(fastUnits, 0)?.backend).toBe("wasm")
  })

  it("parses bytes in a SharedArrayBuffer", () => {
    const text = '{"key": ["é", "😀", 1.5, true], "other": "a\\nb"}'
    const encoded = new TextEncoder().encode(text)
    const shared = new Uint8Array(new SharedArrayBuffer(encoded.length))
    shared.set(encoded)
    sameAsInterpreted(JsonFast.jsonGrammar(Text.utf8), shared)
  })

  it("copies the input of every parse that needs it", () => {
    const word = <I extends string | Uint8Array>(T: Text.TextParsers<I>) =>
      Parser.preceded(T.takeWhile(" "), T.takeWhile(Ascii.isAlpha, { min: 1 }))
    // Strings: the latest is kept in memory, and replaced by another
    const text = word(Text.string)
    const fastText = Compiler.wasm(word(Text.string))
    ;["abc", "xyz", "abc", " def"].forEach((input) => {
      expect(Parser.parsePeek(fastText, input)).toEqual(Parser.parsePeek(text, input))
    })
    // Bytes may change in place between parses
    const bytes = word(Text.utf8)
    const fastBytes = Compiler.wasm(word(Text.utf8))
    const buffer = new TextEncoder().encode("hello world")
    expect(Parser.parsePeek(fastBytes, buffer)).toEqual(Parser.parsePeek(bytes, buffer))
    buffer.set(new TextEncoder().encode("howdy"))
    expect(Parser.parsePeek(fastBytes, buffer)).toEqual(Parser.parsePeek(bytes, buffer))
  })

  it("lexes one token at a time, from strings and from large buffers", () => {
    const token = <I extends string | Uint8Array>(T: Text.TextParsers<I>) =>
      Parser.preceded(T.takeWhile(" "), Parser.alt(T.takeWhile(Ascii.isAlphanumeric, { min: 1 }), T.oneOf("{}();,")))
    /** The tokens of `input`, one `parsePeek` from each offset. */
    const lex = <I extends string | Uint8Array>(p: Parser.Parser<string, never, never, I>, input: I) =>
      Arr.unfold(0, (offset) => {
        if (offset >= input.length) return Option.none()
        const r = Parser.parsePeek(p, input, { offset })
        return Result.isFailure(r)
          ? Option.none()
          : Option.some([r.success[1], input.length - r.success[0].length] as const)
      })
    // Longer than the rest that a parse from a later offset copies (beyond it, they run the JIT)
    const text = "foo bar 12 ( baz ; qux ) { 7 } ".repeat(400)
    const expected = lex(token(Text.string), text)
    expect(expected).toHaveLength(4400)
    expect(lex(Compiler.wasm(token(Text.string)), text)).toEqual(expected)
    expect(lex(Compiler.wasm(token(Text.utf8)), new TextEncoder().encode(text))).toEqual(expected)
  })

  it("uses the JIT where WebAssembly is unavailable", () => {
    vi.stubGlobal("WebAssembly", undefined)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const p = Compiler.wasm(Parser.repeat(a))
    expect(Parser.parse(p, "aa")).toEqual(Result.succeed(["a", "a"]))
    expect(Registry.compiled(p, 0)?.backend).toBe("jit")
  })
})
