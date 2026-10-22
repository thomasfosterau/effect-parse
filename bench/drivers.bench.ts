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
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { Ascii, Compiler, Input, Parser, ParserStream, Token } from "@thomasfosterau/effect-parse"

/** Runs every case once, in order, keeping each one's best time. */
const round = (cases: Record<string, () => unknown>, names: ReadonlyArray<string>, best: Map<string, number>) => {
  for (const n of names) {
    const start = performance.now()
    cases[n]()
    best.set(n, Math.min(best.get(n) ?? Infinity, performance.now() - start))
  }
}

const report = (title: string, cases: Record<string, () => unknown>, rounds = 30): void => {
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
  "Parser.run + State.reset, partial": byRun(true)
})

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
