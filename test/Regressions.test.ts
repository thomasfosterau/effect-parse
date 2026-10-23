import * as Predicate from "effect/Predicate"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import type { ParseError } from "../src/index.js"
import { assert, describe, expect, it } from "vite-plus/test"
import { Ascii, Compiler, Expression, Parser, ParserStream, Syntax, Text, Token } from "../src/index.js"
import { expectFailure, expectSuccess, peek } from "./utils.js"

describe("regressions", () => {
  it("separated and repeatTill work data-last", () => {
    expectSuccess(Ascii.decInt.pipe(Parser.separated(Token.literal(","))), "1,2", [1, 2])
    expectSuccess(Ascii.decInt.pipe(Parser.separated(Token.literal(","), { min: 1 })), "1", [1])
    expectSuccess(Token.literal("a").pipe(Parser.repeatTill(Token.literal("b"))), "aab", [["a", "a"], "b"])
  })

  it("Expression rejects zero-width prefix/postfix operators", () => {
    const p = Expression.make({
      operand: Ascii.decInt,
      operators: [Expression.postfix(Parser.opt(Token.literal("!")), 2, (x: number) => x + 1)]
    })
    expect(expectFailure(p, "1").kind).toBe("Assert")
    const q = Expression.make({
      operand: Ascii.decInt,
      operators: [Expression.prefix(Parser.empty, 2, (_, x: number) => x)]
    })
    expect(expectFailure(q, "1").kind).toBe("Assert")
  })

  it("tillLineEnding rejects a trailing lone carriage return", () => {
    expect(Result.isFailure(Parser.parsePeek(Ascii.tillLineEnding, "ab\r"))).toBe(true)
  })

  it("surrogate pairs split across partial chunks are incomplete", () => {
    const incomplete = Result.succeed({ _tag: "Incomplete", needed: Option.some(1) })
    expect(Parser.parsePartial(Token.any, "\uD83D")).toEqual(incomplete)
    expect(Parser.parsePartial(Token.take(1), "\uD83D")).toEqual(incomplete)
    expect(Parser.parsePartial(Token.oneOf("😀"), "\uD83D")).toEqual(incomplete)
    expect(
      Parser.parsePartial(
        Token.takeWhile(() => true),
        "a\uD83D"
      )
    ).toEqual(incomplete)
    const program = Stream.fromIterable(["a\uD83D", "\uDE00b"]).pipe(
      ParserStream.parseMany(Token.any),
      Stream.runCollect
    )
    expect(Effect.runSync(program)).toEqual(["a", "😀", "b"])
  })

  it("takeUntil checks the range of the first occurrence (winnow semantics)", () => {
    expectFailure(Parser.allConsuming(Token.takeUntil("x", { min: 2 })), "axbx")
    expect(peek(Token.takeUntil("x", { min: 2 }), "abx")).toEqual(Result.succeed(["x", "ab"]))
  })

  it("peek does not leak hints", () => {
    const p = Parser.seq(Parser.peek(Ascii.digit1), Ascii.digit1, Token.literal(";"))
    expect(expectFailure(p, "1x").expected).toEqual(["digit", '";"'])
  })

  it("mapParser translates offsets for slices that start after skipped input", () => {
    const p = Parser.preceded(Ascii.space0, Token.take(3)).pipe(Parser.mapParser(Parser.allConsuming(Ascii.digit1)))
    expect(expectFailure(p, "  12x").offset).toBe(4)
  })

  it("byte digits of any length", () => {
    const digits = new TextEncoder().encode("1".repeat(200_000))
    expect(Parser.parseSync(Ascii.bytes.decBigUint, digits) > 0n).toBe(true)
  })
})

describe("takeUntil stops at State.end (#30)", () => {
  // Runs `p` over the next `n` units only
  const within = <A>(n: number, p: Parser.Parser<A, never, never, any>) =>
    Parser.make((state) => {
      const saved = state.end
      state.end = state.pos + n
      const a = p.step(state)
      const out = { result: Predicate.isSymbol(a) ? "Fail" : a, pos: state.pos }
      state.end = saved
      return out
    })

  const expectWithin = <A>(p: Parser.Parser<A, never, never, any>, input: any, expected: unknown) =>
    expect(Result.map(peek(p, input), ([, a]) => a)).toEqual(Result.succeed(expected))

  it("does not match a literal past the end of a narrowed region", () => {
    const fail = { result: "Fail", pos: 0 }
    expectWithin(within(3, Token.takeUntil("-->")), "abcdefg-->h", fail)
    expectWithin(within(3, Text.string.takeUntil("-->")), "abcdefg-->h", fail)
    expectWithin(within(3, Text.utf8.takeUntil("-->")), new TextEncoder().encode("abcdefg-->h"), fail)
    expectWithin(within(3, Token.takeUntil(Uint8Array.of(9))), Uint8Array.of(1, 2, 3, 9), fail)
    expectWithin(within(3, Token.takeUntil([9])), [1, 2, 3, 9], fail)
  })

  it("does not match a literal straddling the end", () => {
    expectWithin(within(4, Token.takeUntil("-->")), "abc-->", { result: "Fail", pos: 0 })
    expectWithin(within(4, Token.takeUntil(Uint8Array.of(8, 9))), Uint8Array.of(1, 2, 3, 8, 9), {
      result: "Fail",
      pos: 0
    })
    expectWithin(within(4, Token.takeUntil([8, 9])), [1, 2, 3, 8, 9], { result: "Fail", pos: 0 })
  })

  it("matches a literal ending exactly at the end", () => {
    expectWithin(within(6, Token.takeUntil("-->")), "abc-->h", { result: "abc", pos: 3 })
    expectWithin(within(6, Text.string.takeUntil("-->")), "abc-->h", { result: "abc", pos: 3 })
    expectWithin(within(5, Token.takeUntil([8, 9])), [1, 2, 3, 8, 9, 0], { result: [1, 2, 3], pos: 3 })
  })
})

describe("furthest failure and commits (#21)", () => {
  const ident = Parser.taken(
    Parser.seq(
      Token.takeWhile("abcx", { min: 1 }),
      Parser.optional(Parser.seq(Token.literal(":"), Token.takeWhile("abc", { min: 1 })))
    )
  )
  const item = Parser.seq(Ascii.digit1, Token.literal("!"))

  const errorOf = (p: Parser.Parser<unknown>, input: string) => {
    const e = expectFailure(p, input)
    const compiled = expectFailure(Compiler.jit(p), input)
    expect({
      offset: compiled.offset,
      mode: compiled.mode,
      expected: compiled.expected,
      message: compiled.message
    }).toEqual({ offset: e.offset, mode: e.mode, expected: e.expected, message: e.message })
    return e
  }

  it("a cut failure after a successful lookahead is reported where it happened", () => {
    const notReserved = Parser.flatMap(Parser.peek(ident), (name) =>
      name === "x" ? Parser.cut(Parser.reject) : ident
    ).pipe(Parser.expected("identifier"))
    const p = Parser.terminated(notReserved, Token.literal(";"))
    const e = errorOf(p, "x;")
    expect(e.offset).toBe(0)
    expect(e.mode).toBe("Cut")
    expect(e.expected).toEqual(["identifier"])
    expect(e.message).toContain('expected identifier, found "x"')
    expectSuccess(p, "ab:c;", "ab:c")
  })

  it("failures inside a successful peek are not the furthest failure", () => {
    const e = errorOf(Parser.seq(Parser.peek(ident), Token.literal("y")), "x;")
    expect(e.offset).toBe(0)
    expect(e.expected).toEqual(['"y"'])
  })

  it("failures inside not are not the furthest failure", () => {
    const p = Parser.preceded(Parser.not(Parser.seq(Token.literal("a"), Token.literal("b"))), Token.literal("c"))
    const e = errorOf(p, "ax")
    expect(e.offset).toBe(0)
    expect(e.expected).toEqual(['"c"'])
  })

  it("a cut failure outranks deeper failures of abandoned branches", () => {
    const p = Parser.alt(
      Parser.seq(Token.literal("ab"), Token.literal("cd")),
      Parser.preceded(Token.literal("a"), Parser.cut(Token.literal("x")))
    )
    const e = errorOf(p, "abz")
    expect(e.offset).toBe(1)
    expect(e.mode).toBe("Cut")
    expect(e.expected).toEqual(['"x"'])
  })

  it("a cut failure still reports deeper failures from inside the cut", () => {
    const list = Parser.preceded(
      Token.literal("["),
      Parser.cut(Parser.terminated(Parser.separated(item, Token.literal(",")), Token.literal("]")))
    )
    const e = errorOf(list, "[1!,2]")
    expect(e.offset).toBe(5)
    expect(e.expected).toEqual(["digit", '"!"'])
  })

  it("backtracking keeps the furthest failure", () => {
    const e = errorOf(Parser.terminated(Parser.separated(item, Token.literal(",")), Token.literal(";")), "1!,2;")
    expect(e.offset).toBe(4)
    expect(e.expected).toEqual(["digit", '"!"'])
    // Failures inside a successful optional still count
    const f = errorOf(Parser.terminated(Parser.optional(item), Token.literal(";")), "1?")
    expect(f.offset).toBe(1)
    expect(f.expected).toEqual(["digit", '"!"'])
    // and so do those of a failed lookahead
    const g = errorOf(Parser.terminated(Parser.peek(item), Token.literal(";")), "1?")
    expect(g.offset).toBe(1)
    expect(g.expected).toEqual(["digit", '"!"'])
  })
})

describe("deeply nested input reports TooDeep instead of throwing (#14)", () => {
  const braced = () => {
    const text = Token.takeTill("{}", { min: 1 })
    const p: Parser.Parser<unknown> = Parser.seq(
      Token.literal("{"),
      Parser.repeat(
        Parser.alt(
          text,
          Parser.suspend(() => p)
        )
      ),
      Token.literal("}")
    )
    return p
  }
  const deep = "{".repeat(100_000)
  const expectTooDeep = (result: Result.Result<unknown, ParseError.ParseError<unknown>>) => {
    if (Result.isSuccess(result)) return assert.fail("expected failure")
    expect(result.failure.kind).toBe("TooDeep")
    expect(result.failure.mode).toBe("Cut")
    expect(result.failure.offset).toBeGreaterThan(0)
    expect(result.failure.offset).toBeLessThanOrEqual(deep.length)
    expect(result.failure.message).toContain("nested too deeply")
  }

  it("interpreted", () => {
    const p = braced()
    expect(Result.isSuccess(Parser.parse(p, "{".repeat(500) + "}".repeat(500)))).toBe(true)
    expectTooDeep(Parser.parse(p, deep))
    expectTooDeep(Parser.parse(p, deep + "}".repeat(100_000)))
    expectTooDeep(Parser.parsePeek(p, deep))
    expectTooDeep(Parser.parsePartial(p, deep))
    expect(() => Parser.parseSync(p, deep)).toThrow(/nested too deeply/)
    expectTooDeep(Effect.runSync(Effect.result(Parser.parseEffect(p, deep))))
    const recoverable = Parser.parseRecoverable(p, deep)
    expect(Option.isNone(recoverable.value)).toBe(true)
    expect(recoverable.errors.at(-1)?.kind).toBe("TooDeep")
  })

  ;(["closure", "jit"] as const).forEach((backend) => {
    it(`compiled (${backend})`, () => {
      const p = Compiler[backend](braced())
      expect(Result.isSuccess(Parser.parse(p, "{".repeat(500) + "}".repeat(500)))).toBe(true)
      expectTooDeep(Parser.parse(p, deep))
      expectTooDeep(Parser.parsePeek(p, deep))
      expectTooDeep(Parser.parsePartial(p, deep))
    })
  })

  it("streaming", () => {
    const p = Compiler.jit(braced())
    const chunks = Array.from({ length: 10 }, () => "{".repeat(10_000))
    expectTooDeep(Effect.runSync(Effect.result(Stream.fromIterable(chunks).pipe(ParserStream.parseAll(p)))))
    expectTooDeep(
      Effect.runSync(Effect.result(Stream.runCollect(Stream.make(deep).pipe(ParserStream.parseMany(braced())))))
    )
  })

  it("syntax trees", () => {
    const tree = Syntax.parse(Syntax.node(braced(), "braced"), deep)
    expect(Option.isNone(tree.value)).toBe(true)
    expect(tree.errors.at(-1)?.kind).toBe("TooDeep")
  })

  it("tryMapUnknown does not swallow the overflow", () => {
    const p: Parser.Parser<unknown, unknown> = Parser.delimited(
      Token.literal("("),
      Parser.opt(Parser.suspend(() => p)).pipe(Parser.tryMapUnknown((x) => x)),
      Token.literal(")")
    )
    expectTooDeep(Parser.parse(p, "(".repeat(100_000)))
  })
})
