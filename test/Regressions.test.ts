import { Effect, Option, Result, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { Ascii, Expression, Parser, ParserStream, Token } from "../src/index.js"
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
    expect(Parser.parsePartial(Token.takeWhile(() => true), "a\uD83D")).toEqual(incomplete)
    const program = Stream.fromIterable(["a\uD83D", "\uDE00b"]).pipe(ParserStream.parseMany(Token.any), Stream.runCollect)
    expect(Effect.runSync(program)).toEqual(["a", "😀", "b"])
  })

  it("takeUntil checks the range of the first occurrence (winnow semantics)", () => {
    expectFailure(Parser.allConsuming(Token.takeUntil("x", { min: 2 })), "axbx")
    expect(peek(Token.takeUntil("x", { min: 2 }), "abx")).toEqual(Result.succeed(["x", "ab"]))
  })

  it("peek does not leak hints", () => {
    const p = Parser.seq(Parser.peek(Ascii.digit1), Ascii.digit1, Token.literal(";"))
    expect(expectFailure(p, "1x").expected).toEqual(["digit", "\";\""])
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

describe("furthest failure and commits (#21)", () => {
  const ident = Parser.taken(Parser.seq(
    Token.takeWhile("abcx", { min: 1 }),
    Parser.optional(Parser.seq(Token.literal(":"), Token.takeWhile("abc", { min: 1 })))
  ))
  const item = Parser.seq(Ascii.digit1, Token.literal("!"))

  const errorOf = (p: Parser.Parser<unknown>, input: string) => {
    const e = expectFailure(p, input)
    const compiled = expectFailure(Parser.compile(p), input)
    expect({ offset: compiled.offset, mode: compiled.mode, expected: compiled.expected, message: compiled.message })
      .toEqual({ offset: e.offset, mode: e.mode, expected: e.expected, message: e.message })
    return e
  }

  it("a cut failure after a successful lookahead is reported where it happened", () => {
    const notReserved = Parser.flatMap(Parser.peek(ident), (name) => name === "x" ? Parser.cut(Parser.reject) : ident)
      .pipe(Parser.expected("identifier"))
    const p = Parser.terminated(notReserved, Token.literal(";"))
    const e = errorOf(p, "x;")
    expect(e.offset).toBe(0)
    expect(e.mode).toBe("Cut")
    expect(e.expected).toEqual(["identifier"])
    expect(e.message).toContain("expected identifier, found \"x\"")
    expectSuccess(p, "ab:c;", "ab:c")
  })

  it("failures inside a successful peek are not the furthest failure", () => {
    const e = errorOf(Parser.seq(Parser.peek(ident), Token.literal("y")), "x;")
    expect(e.offset).toBe(0)
    expect(e.expected).toEqual(["\"y\""])
  })

  it("failures inside not are not the furthest failure", () => {
    const p = Parser.preceded(Parser.not(Parser.seq(Token.literal("a"), Token.literal("b"))), Token.literal("c"))
    const e = errorOf(p, "ax")
    expect(e.offset).toBe(0)
    expect(e.expected).toEqual(["\"c\""])
  })

  it("a cut failure outranks deeper failures of abandoned branches", () => {
    const p = Parser.alt(
      Parser.seq(Token.literal("ab"), Token.literal("cd")),
      Parser.preceded(Token.literal("a"), Parser.cut(Token.literal("x")))
    )
    const e = errorOf(p, "abz")
    expect(e.offset).toBe(1)
    expect(e.mode).toBe("Cut")
    expect(e.expected).toEqual(["\"x\""])
  })

  it("a cut failure still reports deeper failures from inside the cut", () => {
    const list = Parser.preceded(
      Token.literal("["),
      Parser.cut(Parser.terminated(Parser.separated(item, Token.literal(",")), Token.literal("]")))
    )
    const e = errorOf(list, "[1!,2]")
    expect(e.offset).toBe(5)
    expect(e.expected).toEqual(["digit", "\"!\""])
  })

  it("backtracking keeps the furthest failure", () => {
    const e = errorOf(Parser.terminated(Parser.separated(item, Token.literal(",")), Token.literal(";")), "1!,2;")
    expect(e.offset).toBe(4)
    expect(e.expected).toEqual(["digit", "\"!\""])
    // Failures inside a successful optional still count
    const f = errorOf(Parser.terminated(Parser.optional(item), Token.literal(";")), "1?")
    expect(f.offset).toBe(1)
    expect(f.expected).toEqual(["digit", "\"!\""])
    // and so do those of a failed lookahead
    const g = errorOf(Parser.terminated(Parser.peek(item), Token.literal(";")), "1?")
    expect(g.offset).toBe(1)
    expect(g.expected).toEqual(["digit", "\"!\""])
  })
})
