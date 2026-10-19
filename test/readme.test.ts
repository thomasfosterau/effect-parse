import { Context, Data, Effect, Option, Result, Stream } from "effect"
import { expect, it } from "vitest"
import { Ascii, Encoding, Parser, ParserStream, Text, Token } from "../src/index.js"

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
})

it("README hoisted generator example behaves like the inline one", () => {
  const inline = Parser.gen(function*() {
    const name = yield* Token.takeWhile(Ascii.isAlphanumeric, { min: 1 })
    yield* Token.literal(": ")
    const value = yield* Ascii.tillLineEnding
    yield* Ascii.lineEnding
    return { name, value }
  })

  const colon = Token.literal(": ")
  const name = Token.takeWhile(Ascii.isAlphanumeric, { min: 1 })
  const header = Parser.gen(function*() {
    const n = yield* name
    yield* colon
    const value = yield* Ascii.tillLineEnding
    yield* Ascii.lineEnding
    return { name: n, value }
  })

  expect(Parser.parse(header, "Host: example.com\r\n")).toEqual(Result.succeed({ name: "Host", value: "example.com" }))
  for (const input of ["Host: example.com\n", "Host example.com\n", ": x\n"]) {
    expect(Parser.parse(header, input)).toEqual(Parser.parse(inline, input))
  }
})
