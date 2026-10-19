import { Context, Data, Effect, Option, Result, Stream } from "effect"
import { expect, it } from "vitest"
import { Ascii, Encoding, Input, Parser, ParseError, ParserStream, Text, Token } from "../src/index.js"

it("README examples behave as documented", () => {
  const point = Parser.gen(function*() {
    yield* Token.literal("(")
    const x = yield* Ascii.decInt
    yield* Token.literal(",")
    const y = yield* Ascii.decInt
    yield* Token.literal(")")
    return { x, y }
  })
  expect(Parser.parse(point, "(1,-2)")).toEqual(Result.succeed({ x: 1, y: -2 }))
  const r = Parser.parse(point, "(1;-2)")
  expect(Result.isFailure(r) && r.failure.message).toBe([
    "Parse error at line 1, column 3:",
    "1 | (1;-2)",
    "  |   ^",
    "expected digit or \",\", found \";\""
  ].join("\n"))

  expect(Parser.parsePartial(Ascii.digit1, "123")).toEqual(Result.succeed({ _tag: "Incomplete", needed: Option.some(1) }))

  class Radix extends Context.Service<Radix, number>()("Radix") {}
  const number = Parser.service(Radix).pipe(
    Parser.flatMap((radix) => Ascii.alphanumeric1.pipe(Parser.map((s) => parseInt(s, radix))))
  )
  expect(Parser.parseSync(Parser.provideService(number, Radix, 16), "ff")).toBe(255)
  expect(Effect.runSync(Parser.parseEffect(number, "777").pipe(Effect.provideService(Radix, 8)))).toBe(511)

  class OutOfRange extends Data.TaggedError("OutOfRange")<{ value: number }> {}
  const port: Parser.Parser<number, string | OutOfRange> = Ascii.decUint.pipe(
    Parser.filterOrFail((n) => n < 65536, (value) => new OutOfRange({ value }))
  )
  const e = Parser.parse(port, "70000")
  expect(Result.isFailure(e) && e.failure.cause).toBeInstanceOf(OutOfRange)

  const line = Parser.terminated(Ascii.decInt, Token.literal("\n"))
  expect(Effect.runSync(Stream.make("1\n2", "3\n", "4\n").pipe(ParserStream.parseMany(line), Stream.runCollect))).toEqual([1, 23, 4])

  type Tree = ReadonlyArray<Tree>
  const tree: Parser.Parser<Tree> = Parser.delimited(
    Token.literal("["),
    Parser.separated(Parser.suspend(() => tree), Token.literal(",")),
    Token.literal("]")
  )
  expect(Parser.parseSync(tree, "[[],[[]]]")).toEqual([[], [[]]])
  const upper = Parser.make<string>((state) => {
    const c = state.input.charCodeAt(state.pos)
    if (c >= 65 && c <= 90) {
      state.pos++
      return String.fromCharCode(c)
    }
    return state.atEnd() ? state.eoi("Token", ["uppercase letter"], 1) : state.backtrack("Token", ["uppercase letter"])
  })
  expect(Parser.parseSync(Parser.repeat(upper), "AB")).toEqual(["A", "B"])
})

it("README Unicode examples behave as documented", () => {
  const assignment = <I extends string | Uint8Array>(T: Text.TextParsers<I>) =>
    Parser.separatedPair(T.identifier, Parser.delimited(T.space0, T.literal("≔"), T.space0), T.decInt)
  const text = "größe ≔ 42"
  expect(Parser.parse(assignment(Text.string), text)).toEqual(Result.succeed(["größe", 42]))
  expect(Parser.parse(assignment(Text.utf8), new TextEncoder().encode(text))).toEqual(Result.succeed(["größe", 42]))
  expect(Parser.parse(assignment(Text.utf16le), Encoding.utf16le.encode(text))).toEqual(Result.succeed(["größe", 42]))

  const r = Parser.parse(Text.utf8.alpha1, new Uint8Array([0x61, 0x62, 0xff, 0x63]))
  expect(Result.isFailure(r) && r.failure.message).toBe([
    "Parse error at line 1, column 3 (byte 2):",
    "1 | ab\ufffdc",
    "  |   ^",
    "expected letter or end of input, found invalid UTF-8 0xff"
  ].join("\n"))
})

it("Text and Encoding doc examples behave as documented", () => {
  const greeting = <I extends string | Uint8Array>(T: Text.TextParsers<I>) =>
    Parser.preceded(T.literal("¡hola "), T.identifier)
  expect(Parser.parse(greeting(Text.string), "¡hola mundo")).toEqual(Result.succeed("mundo"))
  expect(Parser.parse(greeting(Text.utf8), new TextEncoder().encode("¡hola Zoë"))).toEqual(Result.succeed("Zoë"))

  const bytes = new TextEncoder().encode("naïve café")
  expect(Parser.parse(Parser.separatedPair(Text.utf8.alpha1, Text.utf8.space1, Text.utf8.alpha1), bytes))
    .toEqual(Result.succeed(["naïve", "café"]))

  const T = Text.make(Encoding.latin1)
  expect(Parser.parse(T.alpha1, new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toEqual(Result.succeed("café"))

  const greek = Text.string.takeWhile(Text.property("Script=Greek"), { min: 1 })
  expect(Parser.parse(greek, "λόγος")).toEqual(Result.succeed("λόγος"))

  expect(Encoding.sniff(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toEqual(Option.some(Encoding.utf16le))
  expect(Text.utf8.encoding).toBe(Encoding.utf8)

  const isNameStart = Token.codePoints(
    "name start",
    (c) => c === 0x5f || (c >= 0x61 && c <= 0x7a) || c >= 0xc0,
    [[0x5f, 0x5f], [0x61, 0x7a], [0xc0, 0x10ffff]]
  )
  expect(Parser.parse(Parser.compile(Token.takeWhile(isNameStart)), "_aé😀")).toEqual(Result.succeed("_aé😀"))
})

it("README: reusing a state for one run per token", () => {
  const buffer = "12 abc 34"
  const lexeme = Parser.terminated(Parser.alt(Ascii.digit1, Ascii.alpha1), Token.literal(" "))
  const state = new Input.State(buffer)
  const token = (offset: number) => {
    const value = lexeme.step(state.reset(offset, { partial: true }))
    if (value !== Input.Fail) return { value, end: state.pos }
    if (state.mode === "Incomplete") return undefined // wait for more input
    throw ParseError.fromFailure(state.input, state.reportedFailure(), state.mode, state.encoding)
  }
  expect(token(0)).toEqual({ value: "12", end: 3 })
  expect(token(3)).toEqual({ value: "abc", end: 7 })
  expect(token(7)).toBeUndefined()
  expect(() => token(2)).toThrow("expected digit or letter")
  expect(token(0)).toEqual({ value: "12", end: 3 })
})
