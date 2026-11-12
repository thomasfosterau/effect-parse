/**
 * Drivers that make many small runs: a lexer reading one token at a time
 * from a buffer, `ParserStream.parseMany` over a stream of rows, and a
 * grammar over the token array a lexer produced.
 *
 * Each case runs many times, interleaved with the others, and the best
 * time is reported.
 *
 * Run with `pnpm build && pnpm bench:drivers`.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { Ascii, Compiler, Input, Parser, ParserStream, Token } from "@thomasfosterau/effect-parse"

/** Runs every case once, in order, keeping each one's best time. */
const round = (cases: Record<string, () => void>, names: ReadonlyArray<string>, best: Map<string, number>) => {
  for (const n of names) {
    const start = performance.now()
    cases[n]()
    best.set(n, Math.min(best.get(n) ?? Infinity, performance.now() - start))
  }
}

const report = (title: string, cases: Record<string, () => void>, rounds = 30): void => {
  const names = Object.keys(cases)
  const orders = [names, [...names].reverse()]
  Array.from({ length: 5 }, () => round(cases, names, new Map()))
  const best = new Map<string, number>()
  Array.from({ length: rounds }, (_, r) => round(cases, orders[r % 2], best))
  console.log(title)
  const base = best.get(names[0]) ?? 1
  best.forEach((t, n) => console.log(`  ${n.padEnd(40)} ${t.toFixed(2).padStart(8)} ms  ${(base / t).toFixed(1)}x`))
}

// -----------------------------------------------------------------------------
// A lexer: one token per run
// -----------------------------------------------------------------------------

const token = () =>
  Parser.preceded(
    Ascii.multispace0,
    Parser.alt(Token.takeWhile(Ascii.isAlphanumeric, { min: 1 }), Ascii.decUint, Token.oneOf("{}();,"))
  )
const interpreted = token()
const compiled = Compiler.jit(token())
const source = "foo bar 12 ( baz ; qux ) { 7 } ".repeat(20_000)
const state = new Input.State(source)

const byStep = (): number => {
  let n = 0
  for (let pos = 0; pos < state.end; n++) {
    state.reset(pos)
    if (interpreted.step(state) === Input.Fail) break
    pos = state.pos
  }
  return n
}

const byRun = (partial: boolean) => (): number => {
  const options = partial ? { partial: true } : undefined
  let n = 0
  for (let pos = 0; pos < state.end; n++) {
    state.reset(pos, options)
    if (Parser.run(compiled, state) === Input.Fail) break
    pos = state.pos
  }
  return n
}

// Its own function literal, so that its call site sees only the runner
const next = Compiler.runner(compiled)
const byRunner = (): number => {
  let n = 0
  for (let pos = 0; pos < state.end; n++) {
    if (next(state.reset(pos)) === Input.Fail) break
    pos = state.pos
  }
  return n
}

const byParsePartial = (): number => {
  let n = 0
  for (let offset = 0; offset < source.length; n++) {
    const r = Parser.parsePartial(compiled, source, { offset })
    if (Result.isFailure(r) || r.success._tag !== "Done") break
    offset = r.success.offset
  }
  return n
}

report(`lexer, ${source.length / 1000} K characters, one token per run`, {
  "step + State.reset (interpreted)": byStep,
  "parsePartial with offset (compiled)": byParsePartial,
  "Parser.run + State.reset (compiled)": byRun(false),
  "Parser.run + State.reset, partial": byRun(true),
  "Compiler.runner + State.reset (compiled)": byRunner
})

// -----------------------------------------------------------------------------
// A lexer whose stop character never occurs (#126)
// -----------------------------------------------------------------------------

// Text tokens of an XML-like lexer: each run of text ends at `<` or `&`, and
// ordinary text has no `&`. The search for it runs to the end of the buffer;
// remembered across `State.reset`, it runs once, not once per token.
const textToken = Compiler.jit(Parser.terminated(Token.takeTill("<&", { min: 1 }), Token.literal("<")))
const markup = `${"some ordinary text, long enough to be searched for with indexOf".padEnd(79, ".")}<`.repeat(50_000)
const markupState = new Input.State(markup)
const textTokens = (): number => {
  let n = 0
  for (let pos = 0; pos < markup.length; n++) {
    if (Parser.run(textToken, markupState.reset(pos)) === Input.Fail) break
    pos = markupState.pos
  }
  return n
}

report(
  `text tokens, ${markup.length / 1e6} M characters, one per line, a stop character that never occurs`,
  { "Parser.run + State.reset (compiled)": textTokens },
  5
)

// -----------------------------------------------------------------------------
// A scanner: most runs fail, and why doesn't matter
// -----------------------------------------------------------------------------

const link = Compiler.jit(
  Parser.delimited(Token.literal("[["), Token.takeTill("]|\n", { min: 1 }), Token.literal("]]"))
)
const prose = "plain text with [[a link]] and [single] brackets, [[broken link\n more words ".repeat(5000)
const proseState = new Input.State(prose)

/** Tries `link` at every `[`, skipping a character when it fails. */
const links = (diagnostics: boolean) => (): number => {
  let found = 0
  let pos = prose.indexOf("[")
  while (pos >= 0) {
    if (Parser.run(link, proseState.reset(pos), { diagnostics }) === Input.Fail) pos = prose.indexOf("[", pos + 1)
    else {
      found++
      pos = prose.indexOf("[", proseState.pos)
    }
  }
  return found
}

report(`scanner, ${prose.length / 1000} K characters, a run at every "["`, {
  "Parser.run": links(true),
  "Parser.run, diagnostics: false": links(false)
})

// -----------------------------------------------------------------------------
// ParserStream.parseMany: one row per run
// -----------------------------------------------------------------------------

const field = Parser.alt(
  Parser.delimited(Token.literal('"'), Token.takeTill('"'), Token.literal('"')),
  Token.takeTill(",\n")
)
const row = () => Parser.terminated(Parser.separated(field, Token.literal(","), { min: 1 }), Token.literal("\n"))
const rowInterpreted = row()
const rowCompiled = Compiler.jit(row())
const csv = Array.from({ length: 20_000 }, (_, i) => `${i},"name ${i}",${i * 3.5},x${i % 7}\n`).join("")
const chunks = csv.match(/[\s\S]{1,65536}/g) ?? []
const rows = (p: typeof rowInterpreted) => () =>
  Effect.runSync(Stream.fromIterable(chunks).pipe(ParserStream.parseMany(p), Stream.runCount))

report(`ParserStream.parseMany, 20 K rows in 64 KB chunks`, {
  interpreted: rows(rowInterpreted),
  compiled: rows(rowCompiled)
})

// -----------------------------------------------------------------------------
// A grammar over tokens
// -----------------------------------------------------------------------------

interface Tok {
  readonly kind: string
}
const tokens: ReadonlyArray<Tok> = Array.from({ length: 200_000 }, (_, i) => ({
  kind: ["name", "=", "number", ";"][i % 4]
}))

/** A token of a kind, written as a hand-made step. */
const made = (kind: string): Parser.Parser<Tok, never, never, ReadonlyArray<Tok>> =>
  Parser.make((s: Input.State<ReadonlyArray<Tok>>) => {
    const t = s.input[s.pos]
    if (t === undefined || t.kind !== kind) return s.backtrack("Token", [kind])
    s.pos++
    return t
  })
/** The same, as a token set: compiled code calls the predicate inline. */
const predicate = (kind: string) => Token.oneOf<ReadonlyArray<Tok>>((t) => t.kind === kind)

const statements = (tok: (kind: string) => Parser.Parser<Tok, never, never, ReadonlyArray<Tok>>) =>
  Compiler.jit(
    Parser.repeat(
      Parser.alt(
        Parser.seq(tok("name"), tok("="), Parser.alt(tok("name"), tok("number")), tok(";")),
        Parser.seq(tok("number"), tok(";"))
      )
    )
  )
const viaMake = statements(made)
const viaPredicate = statements(predicate)

report(`token array, ${tokens.length / 1000} K tokens`, {
  "Parser.make tokens": () => Parser.parseSync(viaMake, tokens),
  "Token.oneOf(predicate)": () => Parser.parseSync(viaPredicate, tokens)
})

// -----------------------------------------------------------------------------
// A check on every token: tryMap / filterMap against mapOrFail (#66)
// -----------------------------------------------------------------------------

const word = Token.takeWhile(Ascii.isAlpha, { min: 1 })
const words = <E>(check: Parser.Parser<string, E>) => Compiler.jit(Parser.separated(check, Token.literal(" ")))

/**
 * A check like a markup lexer's (is every character allowed here?). Here
 * V8 inlines the callbacks and removes the `Result` / `Option` they return,
 * so the three forms cost the same. In a large grammar, which exhausts
 * V8's inlining budget, the wrapper is really allocated: run with
 * `node --no-turbo-escape` to see that case, where `mapOrFail` is about
 * 1.3x faster than `tryMap` (15.5 ms, 16.6 ms and 11.8 ms on the machine
 * that wrote this).
 */
/** Whether a unit is a control character, `&` or `<`. */
const isMarkup = (c: number): boolean => c < 0x20 || c === 0x26 || c === 0x3c || (c >= 0x80 && c <= 0x9f)
/** Whether a unit is a surrogate or a noncharacter. */
const isNonText = (c: number): boolean =>
  (c >= 0xd800 && c <= 0xdfff) || c === 0xfffe || c === 0xffff || (c >= 0xfdd0 && c <= 0xfdef)
/** Whether a word containing the unit may not appear in XML text. */
const isBadUnit = (c: number): boolean => isMarkup(c) || isNonText(c)
const check =
  <B>(ok: (w: string) => B, bad: (w: string) => B) =>
  (w: string): B => {
    for (let i = 0; i < w.length; i++) if (isBadUnit(w.charCodeAt(i))) return bad(w)
    return ok(w)
  }
const viaTryMap = words(
  word.pipe(
    Parser.tryMap(
      check<Result.Result<string, number>>(
        (w) => Result.succeed(w),
        (w) => Result.fail(w.length)
      )
    )
  )
)
const viaFilterMap = words(
  word.pipe(
    Parser.filterMap(
      check<Option.Option<string>>(
        (w) => Option.some(w),
        () => Option.none()
      )
    )
  )
)
const viaMapOrFail = words(
  word.pipe(
    Parser.mapOrFail(
      check(
        (w): string | Input.Fail => w,
        () => Input.Fail
      ),
      (w) => w.length
    )
  )
)
const prose2 = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do ".repeat(20_000).trimEnd()

report(`a check on every word, ${prose2.length / 1000} K characters`, {
  tryMap: () => Parser.parseSync(viaTryMap, prose2),
  filterMap: () => Parser.parseSync(viaFilterMap, prose2),
  mapOrFail: () => Parser.parseSync(viaMapOrFail, prose2)
})

// -----------------------------------------------------------------------------
// A lexer that records spans: withSpan against mapSpan (#64)
// -----------------------------------------------------------------------------

const text = Parser.terminated(Token.takeTill("<"), Token.literal("<"))
const runs = "hello world<".repeat(100_000)
const runsState = new Input.State(runs)
/** One token per `Parser.run`, as a markup lexer reads text runs. */
const lex = (p: Parser.Parser<number>) => (): number => {
  let n = 0
  for (let pos = 0; pos < runsState.end; n++) {
    if (Parser.run(p, runsState.reset(pos, { partial: true })) === Input.Fail) break
    pos = runsState.pos
  }
  return n
}

// With V8's escape analysis the tuple and span are removed and the three
// cost the same; in a grammar past the inlining budget (`node
// --no-turbo-escape`) mapSpan saves the two allocations, about 10%.
report(`text runs with spans, ${runs.length / 1000} K characters, one token per run`, {
  "map(withSpan(p))": lex(Compiler.jit(Parser.map(Parser.withSpan(text), ([v, s]) => v.length + s.end - s.start))),
  "struct of locations": lex(
    Compiler.jit(
      Parser.map(Parser.struct({ s: Parser.location, a: text, e: Parser.location }), (r) => r.a.length + r.e - r.s)
    )
  ),
  mapSpan: lex(Compiler.jit(Parser.mapSpan(text, (v, start, end) => v.length + end - start)))
})

// -----------------------------------------------------------------------------
// Runs up to a stop character: takeTill on CSV-shaped input (#75)
// -----------------------------------------------------------------------------

/** Fields of the given length, quoted (`takeTill('"')`) and unquoted (`takeTill(",\r\n")`). */
const fieldsOf = (length: number) => {
  const field = "x".repeat(length)
  const rows = Array.from({ length: Math.ceil(400_000 / (length + 3)) }, (_, i) => (i % 8 === 7 ? "\r\n" : ","))
  return {
    quoted: rows.map((sep) => `"${field}"${sep}`).join(""),
    plain: rows.map((sep) => `${field}${sep}`).join("")
  }
}
const quotedField = Compiler.jit(
  Parser.repeat(
    Parser.terminated(
      Parser.delimited(Token.literal('"'), Token.takeTill('"'), Token.literal('"')),
      Token.takeWhile(",\r\n", { min: 1 })
    )
  )
)
const plainField = Compiler.jit(
  Parser.repeat(Parser.terminated(Token.takeTill(",\r\n", { min: 1 }), Token.takeWhile(",\r\n", { min: 1 })))
)
for (const length of [4, 16, 32, 64, 256]) {
  const { plain, quoted } = fieldsOf(length)
  report(`fields of ${length} characters, ${(quoted.length / 1000).toFixed(0)} K characters`, {
    "takeTill('\"'), quoted": () => Parser.parseSync(quotedField, quoted),
    'takeTill(",\\r\\n"), unquoted': () => Parser.parseSync(plainField, plain)
  })
}

// -----------------------------------------------------------------------------
// A name-like terminal: a repetition of a shared character alternative (#79)
// -----------------------------------------------------------------------------

const nameChar = Token.oneOf<string>([Token.range("a", "z"), Token.range("0", "9"), "_"])
const escapeSeq = Parser.seq(Token.literal("%"), Token.takeWhile(Ascii.isHexDigit, 2))
const charsShared = Parser.alt(nameChar, escapeSeq)
const nameNatural = Compiler.jit(
  Parser.separated(
    Parser.taken(
      Parser.repeat(
        Parser.alt(
          Parser.repeat(charsShared, { min: 1 }),
          Parser.seq(Token.takeWhile(".", { min: 1 }), Parser.peek(charsShared))
        ),
        { min: 1 }
      )
    ),
    Token.literal(" ")
  )
)
const nameByHand = Compiler.jit(
  Parser.separated(
    Parser.taken(
      Parser.repeat(
        Parser.alt(
          Token.takeWhile([Token.range("a", "z"), Token.range("0", "9"), "_"], { min: 1 }),
          escapeSeq,
          Parser.seq(Token.takeWhile(".", { min: 1 }), Parser.peek(charsShared))
        ),
        { min: 1 }
      )
    ),
    Token.literal(" ")
  )
)
const names = Array.from({ length: 20_000 }, (_, i) => `name_${i}.part%20two.and_some_more_text_${i % 97}`).join(" ")
report(`names of ~45 characters, ${(names.length / 1000).toFixed(0)} K characters`, {
  "repeat(alt(oneOf(set), escape)), shared": () => Parser.parseSync(nameNatural, names),
  "takeWhile(set) by hand": () => Parser.parseSync(nameByHand, names)
})
