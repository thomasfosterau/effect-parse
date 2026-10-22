/**
 * Differential tests: compiled parsers must give exactly the interpreter's
 * results, values and errors alike, on valid, invalid and truncated input.
 */
import * as Predicate from "effect/Predicate"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { assert, describe, expect, it } from "vite-plus/test"
import * as Arithmetic from "../examples/arithmetic.js"
import * as Http from "../examples/http.js"
import * as Ini from "../examples/ini.js"
import * as Json from "../examples/json.js"
import * as JsonFast from "../examples/json-fast.js"
import { jsonGrammar } from "../examples/json-text.js"
import * as Sexpr from "../examples/sexpr.js"
import type { Input } from "../src/index.js"
import { Ascii, Binary, Compiler, Encoding, Expression, Parser, Text, Token } from "../src/index.js"
import { State } from "../src/Input.js"
import { Fail } from "../src/Input.js"
import * as Registry from "../src/internal/compiler/registry.js"
import { allStrings, mutations, randomJson, rng } from "./generators.js"
import { defined } from "./utils.js"

const backends = ["closure", "jit"] as const
type Backend = (typeof backends)[number]

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

const compiledCopy = new Map<string, Map<Parser.Parser.Any, Parser.Parser.Any>>()
const backendOf = new Map<Parser.Parser.Any, Backend>()

/** A compiled twin of `p` (with the same description), leaving `p` interpreted. */
const twin = <P extends Parser.Parser.Any>(p: P, backend: Backend): P => {
  let byParser = compiledCopy.get(backend)
  if (byParser === undefined) compiledCopy.set(backend, (byParser = new Map()))
  let c = byParser.get(p)
  if (c === undefined) {
    c = Compiler[backend](Parser.named(p, p.name ?? "root"))
    byParser.set(p, c)
    backendOf.set(c, backend)
  }
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
  if (backendOf.get(p) === "jit") assert.strictEqual(compiled.backend, "jit")
  const a = step(state)
  return a === Fail ? undefined : { value: a, pos: state.pos, end: state.end }
}

/**
 * One step on a fresh state, interpreted (`step`) or with a resumable
 * compiled build: the value and position, or the failure mode.
 */
const stepOutcome = (
  step: ((state: State<any>) => unknown) | undefined,
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

let checked = 0

/** Checks that `p` gives the same results compiled and interpreted on `input`. */
const same = (p: Parser.Parser.Any, input: Input.Input, context?: Context.Context<any>): void => {
  const options = context === undefined ? undefined : { context }
  const expected = outcome(Parser.parse(p, input as never, options as never))
  const expectedPeek = outcome(Parser.parsePeek(p, input as never, options as never))
  for (const backend of backends) {
    const c = twin(p, backend)
    const label = `${backend} on ${JSON.stringify(Predicate.isString(input) ? input : Array.from(input as any))}`
    expect(outcome(Parser.parse(c, input as never, options as never)), label).toEqual(expected)
    expect(outcome(Parser.parsePeek(c, input as never, options as never)), label).toEqual(expectedPeek)
    // The compiled step on its own succeeds exactly when the interpreter does
    const f = fast(c, input, context)
    expect(f !== undefined, `${label}: compiled success`).toBe(expectedPeek.ok)
    if (f !== undefined && expected.ok) assert.strictEqual(f.pos, f.end, label)
    // The resumable build agrees with the interpreter on partial and on complete input
    const resumable = resumableStep(c, input)
    for (const partial of [true, false]) {
      expect(stepOutcome(resumable, input, partial, context), `${label}, resumable, partial: ${partial}`).toEqual(
        stepOutcome(p.step, input, partial, context)
      )
    }
    checked++
  }
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
    for (const input of jsonInputs) same(Json.json, input)
  })

  it.each([
    ["Text.string", Text.string, (s: string) => s],
    ["Text.utf8", Text.utf8, (s: string) => Encoding.utf8.encode(s)],
    ["Text.utf16le", Text.utf16le, (s: string) => Encoding.utf16le.encode(s)],
    ["Text.utf16be", Text.utf16be, (s: string) => Encoding.utf16be.encode(s)]
  ] as const)("json-text with %s", (_, T, encode) => {
    const p = jsonGrammar(T as Text.TextParsers<any>)
    for (const input of jsonInputs) same(p, (encode as (s: string) => Input.Input)(input))
  })

  it.each([
    ["Text.string", Text.string, (s: string) => s],
    ["Text.utf8", Text.utf8, (s: string) => Encoding.utf8.encode(s)],
    ["Text.utf16le", Text.utf16le, (s: string) => Encoding.utf16le.encode(s)]
  ] as const)("json-fast with %s, accepting what json-text accepts", (_, T, encode) => {
    const fast = JsonFast.jsonGrammar(T as Text.TextParsers<any>)
    const text = jsonGrammar(T as Text.TextParsers<any>)
    const inputs = [
      ...jsonInputs,
      '{"__proto__": 1, "toString": [2], "constructor": {"__proto__": null}}',
      '{"a": 1, "a": 2, "b": {"a": 3, "a": 4}}',
      '"\\ud83d\\ude00\\udc00\\u0041"',
      '"\\ud83d\\u0041"',
      '"\\ud83d"',
      '"\\ud83d\\x"'
    ]
    for (const input of inputs) {
      const bytes = (encode as (s: string) => Input.Input)(input)
      same(fast, bytes)
      const a = Parser.parse(fast, bytes as never)
      const b = Parser.parse(text, bytes as never)
      expect(Result.isSuccess(a), input).toBe(Result.isSuccess(b))
      expect(Result.getSuccess(a), input).toEqual(Result.getSuccess(b))
    }
  })

  it("json-text on malformed bytes", () => {
    const p = jsonGrammar(Text.utf8)
    const random = rng(7)
    const base = Encoding.utf8.encode('["aé😀", {"k": "v"}, 12]')
    for (let i = 0; i < 300; i++) {
      const bytes = base.slice()
      const at = Math.floor(random() * bytes.length)
      bytes[at] = [0x80, 0xc0, 0xe0, 0xed, 0xf0, 0xf5, 0xff, 0x22, 0x5c][i % 9]
      same(p, bytes.subarray(0, i % 3 === 0 ? bytes.length : at + 1))
    }
    const latin = jsonGrammar(Text.latin1)
    for (let b = 0; b < 256; b++) same(latin, new Uint8Array([0x22, b, 0x22]))
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
    for (const input of inputs) {
      same(Arithmetic.evaluate, input)
      same(Arithmetic.ast, input)
      same(Arithmetic.lex, input)
      const lexed = Parser.parse(Arithmetic.lex, input)
      if (Result.isSuccess(lexed)) same(Arithmetic.tokens, lexed.success)
    }
  })

  it("ini", () => {
    const doc = "[owner]\nname=John Doe\norganization=Acme\n\n[database]\nserver=192.0.2.62\nport=143\n"
    const inputs = [
      doc,
      ...mutations(doc, "[]=\n abc", 120, 5),
      ...Array.from({ length: doc.length + 1 }, (_, i) => doc.slice(0, i))
    ]
    for (const input of inputs) same(Ini.ini, input)
  })

  it("sexpr", () => {
    const docs = ["(+ 1 2)", "(if (= 1 1) (* 2 3) 4)", "((lambda x) 1)", "(- 10 #t)", "(+ 1", "  (* (+ 1 2) (- 5 3) ) "]
    const inputs = [...docs, ...docs.flatMap((d, i) => mutations(d, "()+-*/=# 0123456789iftx", 20, 200 + i))]
    for (const input of inputs) {
      same(Sexpr.expr, input)
      same(Sexpr.program, input)
    }
  })

  it("http", () => {
    const doc = "GET /index.html HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n continued\r\n\r\n"
    const inputs = [
      doc,
      ...mutations(doc, "\r\n :/GETHP1.x", 150, 9),
      ...Array.from({ length: doc.length + 1 }, (_, i) => doc.slice(0, i))
    ]
    for (const input of inputs) same(Http.request, new TextEncoder().encode(input))
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
  [
    "opt and optional",
    Parser.seq(
      Parser.opt(a),
      Parser.optional(b),
      Parser.orElseSucceed(ab, () => 0)
    )
  ],
  ["peek and not", Parser.seq(Parser.peek(a), Parser.not(ab), Token.any, Parser.opt(Parser.not(b)))],
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
      digit.pipe(Parser.filterMap((d) => (d === "3" ? Option.none() : Option.some(-d)))),
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
      Parser.repeat(Parser.seq(Parser.opt(a), Parser.opt(b))) as unknown as Parser.Parser<Array<[string, unknown]>>
    )
  ],
  [
    "fromEntries of separated nothing",
    Parser.fromEntries(
      Parser.separated(Parser.seq(Parser.opt(a), Parser.opt(digit)), Parser.opt(b)) as unknown as Parser.Parser<
        Array<[string, unknown]>
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
    for (const input of inputs) same(p, input)
  })

  // In void position (output unused) parsers compile differently
  it.each(grammars)("%s, output unused", (_, p) => {
    const unused = Parser.seq(Parser.taken(p), Parser.asVoid(Parser.opt(p)))
    for (const input of allStrings(alphabet, 3)) same(unused, input)
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

  it.each([
    ["Text.string", Text.string],
    ["Text.utf8", Text.utf8],
    ["Text.utf16le", Text.utf16le],
    ["Text.latin1", Text.latin1]
  ] as const)("%s parsers", (name, T) => {
    const inputs = allStrings(textAlphabet, 3)
    for (const p of textGrammars(T as Text.TextParsers<any>, name === "Text.latin1" ? "þ" : "😀")) {
      for (const input of inputs) {
        if (name === "Text.latin1" && beyondLatin1(input)) continue
        same(p, (T.encoding as Encoding.Encoding<any>).encode(input))
      }
      if (name !== "Text.string") {
        const random = rng(3)
        for (let i = 0; i < 200; i++) {
          same(
            p,
            Uint8Array.from(
              { length: Math.floor(random() * 6) },
              () => [0x61, 0x30, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80, 0xff, 0x00, 0x5c][Math.floor(random() * 11)]
            )
          )
        }
      }
    }
  })

  it("byte inputs", () => {
    const bytes = Token.literal(new Uint8Array([1, 2]))
    const p = Parser.seq(
      Parser.opt(bytes),
      Parser.opt(Token.literal("ab") as any),
      Token.takeWhile<Uint8Array>([Token.range(0x30, 0x39), 1], { max: 3 }),
      Parser.opt(Ascii.caseless(new Uint8Array([0x41]))),
      Parser.opt(Ascii.bytes.decUint),
      Parser.alt(Binary.u8, Parser.eof)
    )
    const random = rng(11)
    for (let i = 0; i < 2000; i++) {
      same(
        p as any,
        Uint8Array.from(
          { length: Math.floor(random() * 7) },
          () => [1, 2, 0x30, 0x39, 0x41, 0x61, 0x62, 0xff][Math.floor(random() * 8)]
        )
      )
    }
  })

  it("Text.taken validates what lenient parsers consumed", () => {
    const str = Parser.seq(Text.string.taken(Token.take(2)), Token.rest)
    for (const input of allStrings(["a", "\ud800", "\udc00", "😀"], 3)) same(str, input)
    const bytes = Parser.seq(Text.utf8.taken(Token.take<Uint8Array>(2)), Token.restOf<Uint8Array>())
    for (const input of allStrings(["a", "\xff", "\xc3", "\xa9"], 3)) {
      same(
        bytes,
        Uint8Array.from(input, (c) => c.charCodeAt(0))
      )
    }
  })

  it("escapes whose normal part can match nothing", () => {
    const p = Parser.seq(
      Parser.opt(Ascii.takeEscaped(Ascii.alpha0, "\\", Token.oneOf("an"))),
      Ascii.escaped(Ascii.alpha0, "\\", Token.literal("n").pipe(Parser.as("\n"))),
      Token.rest
    )
    for (const input of allStrings(["a", "\\", "n", "0"], 4)) same(p, input)
  })

  it("caseless literals with other characters", () => {
    const p = Parser.seq(Parser.opt(Ascii.caseless("+0a")), Parser.opt(Ascii.caseless("@")), Token.rest)
    for (const input of allStrings(["+", "\u000b", "0", "\u0010", "a", "A", "@", "`"], 3)) same(p, input)
  })

  // Sets compile to comparisons on their accepted or rejected ranges, or to a
  // table: every code unit up to 0x103 crosses each boundary
  it("token sets at their boundaries", () => {
    const sets: ReadonlyArray<unknown> = [
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
    for (const set of sets) {
      const token = Parser.seq(
        Parser.opt(Token.oneOf(set as never)),
        Parser.opt(Token.noneOf(set as never)),
        Token.takeWhile(set as never),
        Token.takeTill(set as never, { max: 2 })
      )
      for (const input of inputs) same(token, input)
      const bytes = Parser.seq(Token.takeWhile<Uint8Array>(set as never), Token.takeTill<Uint8Array>(set as never))
      for (let b = 0; b < 256; b++) same(bytes as any, new Uint8Array([b, b, 0x61]))
      for (const T of [Text.string, Text.utf8, Text.latin1] as ReadonlyArray<Text.TextParsers<any>>) {
        const text = Parser.seq(
          Parser.opt(T.oneOf(set as never)),
          Parser.opt(T.noneOf(set as never)),
          T.takeWhile(set as never),
          T.takeTill(set as never, { max: 2 })
        )
        for (const input of inputs) {
          if (T === Text.latin1 && beyondLatin1(input)) continue
          if (T === Text.utf8 && /[\ud800-\udfff]/.test(input.replace("😀", ""))) continue
          same(text, (T.encoding as Encoding.Encoding<any>).encode(input))
        }
      }
    }
  })

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
    const encodings = [
      ["string", Ascii.float, (s: string) => s],
      ["bytes", Ascii.bytes.float, (s: string) => Encoding.utf8.encode(s)],
      ["Text.string", Text.string.float, (s: string) => s],
      ["Text.utf8", Text.utf8.float, (s: string) => Encoding.utf8.encode(s)],
      ["Text.latin1", Text.latin1.float, (s: string) => Encoding.latin1.encode(s)],
      ["Text.utf16le", Text.utf16le.float, (s: string) => Encoding.utf16le.encode(s)]
    ] as const
    for (const [, float, encode] of encodings) {
      const p = Parser.seq(float as Parser.Parser<number, never, never, any>, Token.restLen)
      for (const input of inputs) {
        const bytes = (encode as (s: string) => Input.Input)(input)
        same(p, bytes)
        const expected = Parser.parse(p, bytes as never)
        for (const backend of backends) {
          const actual = Parser.parse(twin(p, backend), bytes as never)
          // `toEqual` does not tell 0 from -0
          const first = (r: typeof actual) => Result.map(r, (values) => Object.is(values[0], -0))
          expect(first(actual), `${backend} on ${input}`).toEqual(first(expected))
        }
      }
    }
  })

  // Compiled parsers assign plain keys and define the others, as
  // Object.fromEntries does
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
      Parser.repeat(Parser.seq(key, Token.oneOf("abc"))) as unknown as Parser.Parser<Array<[string, string]>>
    )
    const describe = (o: any) => ({
      proto: Object.getPrototypeOf(o) === Object.prototype,
      keys: Reflect.ownKeys(o).map(String),
      values: Reflect.ownKeys(o).map((k) => o[k]),
      descriptors: Reflect.ownKeys(o).map((k) => Object.getOwnPropertyDescriptor(o, k))
    })
    for (const input of allStrings(["pa", "tb", "xa", "oc", "sb", "1a", "nb"], 3).map((s) => s)) {
      const expected = describe(Parser.parseSync(entries, input))
      for (const backend of backends) {
        expect(describe(Parser.parseSync(twin(entries, backend), input)), `${backend} on ${input}`).toEqual(expected)
      }
    }
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
    for (const input of allStrings(["x", "a", "b", "c", ":", ";"], 4)) same(p, input)
  })

  it("array inputs", () => {
    const p = Parser.separated(Token.oneOf<ReadonlyArray<string>>(["x", "y"]), Token.literal(["+"]))
    for (const input of allStrings(["x", "y", "+", "z"], 5)) same(p as any, Array.from(input))
  })

  it("services", () => {
    class Limit extends Context.Service<Limit, number>()("Limit") {}
    const p = Parser.service(Limit).pipe(Parser.flatMap((n) => Parser.repeat(a, { max: n })))
    const q = Parser.seq(p, Parser.provideService(p, Limit, 1))
    for (const input of allStrings(["a", "b"], 5)) same(q, input, Context.make(Limit, 2))
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
  if (Predicate.isString(a)) return a + (b as string)
  const out = new Uint8Array(a.length + b.length)
  out.set(a as Uint8Array)
  out.set(b as Uint8Array, a.length)
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
  const runners = {
    parse: (q: Parser.Parser.Any, i: Input.Input, o?: Parser.ParseOptions) => Parser.parse(q, i as never, o as never),
    peek: (q: Parser.Parser.Any, i: Input.Input, o?: Parser.ParseOptions) =>
      Parser.parsePeek(q, i as never, o as never),
    partial: (q: Parser.Parser.Any, i: Input.Input, o?: Parser.ParseOptions) =>
      Parser.parsePartial(q, i as never, o as never)
  }
  const label = JSON.stringify(Predicate.isString(input) ? input : Array.from(input as any))
  for (const [runner, run] of Object.entries(runners)) {
    const expected: any = outcome(run(p, whole, { offset }))
    // Values that are positions (spans, `location`) are positions in the whole input
    if (!options?.positions) {
      assert.deepEqual(
        shifted(expected, 0),
        shifted(outcome(run(p, input)), offset),
        `${runner}, interpreted on ${label}`
      )
    }
    for (const backend of backends) {
      const w = watched(p, backend)
      expect(outcome(run(w.parser, whole, { offset })), `${runner}, ${backend} on ${label}`).toEqual(expected)
      // Unless the root itself runs interpreted (`permutation`, say)
      const kind = new State(whole).inputKind
      const rootFallback = defined(Registry.compiled(w.parser, kind, runner === "partial")).fallbacks.some(
        (f) => f.name === "watched"
      )
      if (rootFallback || (runner === "partial" && options?.leafRoot)) continue
      const rerun = !expected.ok || expected.value?._tag === "Incomplete"
      expect(w.interpreted, `${runner}, ${backend} on ${label}: interpreted runs`).toBe(rerun ? 1 : 0)
    }
  }
}

describe("running from an offset", () => {
  it("json (Token/Ascii)", () => {
    for (const input of jsonInputs) sameAtOffset(Json.json, "[1, 2] ", input)
  })

  it("json-text with Text.utf8", () => {
    const p = jsonGrammar(Text.utf8)
    const prefix = Encoding.utf8.encode("é😀{")
    for (const input of jsonInputs) sameAtOffset(p, prefix, Encoding.utf8.encode(input))
  })

  // Every grammar on every short string, in every runner and backend: about
  // 5 s, which is vitest's default timeout
  it("combinators", () => {
    for (const [name, g] of grammars) {
      const positions = name === "taken and spans" || name === "eof, location, rest"
      for (const input of allStrings(alphabet, 2)) sameAtOffset(g, "ab\n", input, { positions, leafRoot: true })
    }
  }, 30_000)

  it.each(backends)("takes the compiled path with the %s backend, in complete and partial mode", (backend) => {
    const token = Parser.preceded(Ascii.multispace0, Parser.alt(Ascii.alpha1, Ascii.digit1, Token.literal("=")))
    const w = watched(token, backend)
    const buffer = "let x = 10;"
    // A lexer loop: one token at a time, in partial mode, until the buffer runs out
    const tokens: Array<string> = []
    let offset = 0
    for (;;) {
      const r = Parser.parsePartial(w.parser, buffer, { offset })
      if (Result.isFailure(r)) break
      if (r.success._tag === "Incomplete") break
      tokens.push(r.success.value)
      offset = r.success.offset
    }
    expect(tokens).toEqual(["let", "x", "=", "10"])
    expect(offset).toBe(10)
    // Only the final failure (at ";") ran interpreted
    expect(w.interpreted).toBe(1)
    w.interpreted = 0
    expect(Parser.parsePartial(w.parser, "let x", { offset: 3 })).toEqual(
      Result.succeed({ _tag: "Incomplete", needed: Option.some(1) })
    )
    expect(w.interpreted).toBe(1)
    w.interpreted = 0
    expect(Parser.parse(w.parser, buffer.slice(0, 10), { offset: 7 })).toEqual(Result.succeed("10"))
    expect(Parser.parsePeek(w.parser, buffer, { offset: 3 })).toEqual(Result.succeed([" = 10;", "x"]))
    expect(Parser.parseSync(w.parser, "let x", { offset: 3 })).toBe("x")
    expect(w.interpreted).toBe(0)
    expect(Registry.compiled(w.parser, 0, false)?.backend).toBe(backend)
    expect(Registry.compiled(w.parser, 0, true)?.backend).toBe(backend)
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
    for (const offset of [-1, 4, 1.5, Number.NaN]) {
      expect(() => Parser.parse(Token.rest, "abc", { offset })).toThrow(RangeError)
    }
    expect(Parser.parse(Token.rest, "abc", { offset: 3 })).toEqual(Result.succeed(""))
  })
})

describe("the JIT", () => {
  it("falls back to the closure compiler where new Function is blocked", () => {
    const original = globalThis.Function
    const blocked = function () {
      throw new EvalError("Refused to evaluate a string as JavaScript")
    } as unknown as FunctionConstructor
    globalThis.Function = blocked
    try {
      const p = Compiler.jit(Parser.repeat(a))
      expect(Parser.parse(p, "aa")).toEqual(Result.succeed(["a", "a"]))
      expect(Registry.compiled(p, 0)?.backend).toBe("closure")
    } finally {
      globalThis.Function = original
    }
    const q = Compiler.jit(Parser.repeat(a))
    Parser.parse(q, "a")
    expect(Registry.compiled(q, 0)?.backend).toBe("jit")
  })
})
