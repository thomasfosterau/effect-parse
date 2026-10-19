import { Context, Data, Effect, Option, Result, Stream } from "effect"
import { expect, it } from "vitest"
import { Ascii, Encoding, Parser, ParserStream, Syntax, Text, Token } from "../src/index.js"

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

it("Syntax examples behave as documented", () => {
  const name = Syntax.node(Ascii.alpha1, "name")
  const number = Syntax.node(Ascii.decInt, "number")
  const pair = Syntax.node(
    Parser.separatedPair(Syntax.field(name, "key"), Syntax.token(Token.literal("=")), Syntax.field(number, "value")),
    "pair"
  )
  const config = Parser.separated(pair, Token.literal("\n"))

  const tree = Syntax.parse(config, "width=80\nheight=24")
  expect(String(tree.root)).toBe("(document (pair key: (name) value: (number)) (pair key: (name) value: (number)))")
  const node = tree.descendantAt(16)
  expect([node.kind, node.text, node.value]).toEqual(["number", "24", 24])
  expect(node.parent?.childByField("key")?.text).toBe("height")
  expect(tree.lineColumn(node.start)).toEqual({ line: 2, column: 8 })
  expect(tree.value).toEqual(Option.some([["width", 80], ["height", 24]]))

  const edited = Syntax.replace(tree, 6, 8, "100")
  expect(edited.value).toEqual(Option.some([["width", 100], ["height", 24]]))
  expect(edited.reused).toBe(2)

  // The module's own example
  const ws = Ascii.multispace0
  const n = Syntax.node(Ascii.decInt, "number")
  const list = Syntax.node(
    Parser.delimited(Token.literal("["), Parser.separated(Parser.delimited(ws, n, ws), Token.literal(",")), Token.literal("]")),
    "list"
  )
  const t = Syntax.parse(list, "[1, 2, 3]")
  expect(String(t.root)).toBe("(list (number) (number) (number))")
  expect(t.root.descendantAt(4).text).toBe("2")
  const e = Syntax.replace(t, 4, 5, "20")
  expect(e.root.namedChild(1)?.value).toBe(20)
  expect(e.reused).toBe(2)
  expect(Syntax.reparse(Syntax.parse(n, "12"), "123", [{ start: 2, oldEnd: 2, newEnd: 3 }]).root.value).toBe(123)
  const comma = Syntax.token(Token.literal(","))
  expect(Syntax.parse(comma, ",").root.child(0)?.kind).toBe(",")
})
