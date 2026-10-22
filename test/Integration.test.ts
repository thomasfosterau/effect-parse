import { Context, Effect, Exit, Option, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { Ascii, Binary, Expression, Nom, Parser, ParserSchema, ParserStream, Token } from "../src/index.js"
import { expectFailure, expectSuccess, peek } from "./utils.js"

describe("Expression", () => {
  const ws = <A, E>(p: Parser.Parser<A, E>) => Parser.delimited(Ascii.space0, p, Ascii.space0)
  const op = (s: string) => ws(Token.literal(s))
  const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1))

  const arithmetic: Parser.Parser<number, string> = Expression.make({
    operand: ws(
      Parser.alt(
        Ascii.decUint,
        Parser.delimited(
          op("("),
          Parser.suspend(() => arithmetic),
          op(")")
        )
      )
    ),
    operators: [
      Expression.prefix(op("-"), 4, (_, x: number) => -x),
      Expression.postfix(op("!"), 5, (x: number) => factorial(x)),
      Expression.infixRight(op("^"), 3, (l: number, _, r: number) => l ** r),
      Expression.infixLeft(op("*"), 2, (l: number, _, r: number) => l * r),
      Expression.infixLeft(op("/"), 2, (l: number, _, r: number) => l / r),
      Expression.infixLeft(op("+"), 1, (l: number, _, r: number) => l + r),
      Expression.infixLeft(op("-"), 1, (l: number, _, r: number) => l - r)
    ]
  })

  it("precedence and associativity", () => {
    expectSuccess(arithmetic, "1 + 2 * 3", 7)
    expectSuccess(arithmetic, "10 - 3 - 2", 5)
    expectSuccess(arithmetic, "2 ^ 3 ^ 2", 512)
    expectSuccess(arithmetic, "(1 + 2) * 3", 9)
    expectSuccess(arithmetic, "1 + 2 * 3 ^ 2", 19)
    expectSuccess(arithmetic, "2 * 3 / 4", 1.5)
  })

  it("prefix and postfix", () => {
    expectSuccess(arithmetic, "-2 ^ 2", 4)
    expectSuccess(arithmetic, "- -3", 3)
    expectSuccess(arithmetic, "3!", 6)
    expectSuccess(arithmetic, "-3! + 1", -5)
    expectSuccess(arithmetic, "2 * 3!", 12)
  })

  it("stops at unknown input", () => {
    expect(peek(arithmetic, "1 + 2 ]")).toEqual(Result.succeed(["]", 3]))
  })

  it("errors", () => {
    const err = expectFailure(arithmetic, "1 + ")
    expect(err.offset).toBe(4)
    const trailing = expectFailure(arithmetic, "1 + 2 3")
    expect(trailing.offset).toBe(6)
    expect(trailing.expected).toContain('"+"')
    expect(trailing.expected).toContain("end of input")
  })

  it("builds trees", () => {
    type Ast = number | { readonly op: string; readonly args: ReadonlyArray<Ast> }
    const tree: Parser.Parser<Ast, string> = Expression.make({
      operand: Ascii.decUint as Parser.Parser<Ast, string>,
      operators: [
        Expression.infixLeft(Token.oneOf("+-"), 1, (l: Ast, op, r: Ast): Ast => ({ op, args: [l, r] })),
        Expression.infixLeft(Token.oneOf("*/"), 2, (l: Ast, op, r: Ast): Ast => ({ op, args: [l, r] }))
      ]
    })
    expectSuccess(tree, "1+2*3-4", {
      op: "-",
      args: [{ op: "+", args: [1, { op: "*", args: [2, 3] }] }, 4]
    })
  })
})

describe("ParserStream", () => {
  const line = Parser.terminated(Ascii.decInt, Token.literal("\n"))

  it("parseMany across chunk boundaries", () => {
    const program = Stream.make("1\n2", "3\n", "4", "5\n-6\n").pipe(ParserStream.parseMany(line), Stream.runCollect)
    expect(Effect.runSync(program)).toEqual([1, 23, 45, -6])
  })

  it("parseMany parses trailing input in complete mode", () => {
    const word = Parser.terminated(Ascii.alpha1, Ascii.space0)
    const program = Stream.make("ab", "c d", "ef").pipe(ParserStream.parseMany(word), Stream.runCollect)
    expect(Effect.runSync(program)).toEqual(["abc", "def"])
  })

  it("parseMany fails with a ParseError", () => {
    const program = Stream.make("1\n", "x\n").pipe(ParserStream.parseMany(line), Stream.runCollect)
    const exit = Effect.runSyncExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Effect.runSync(Effect.flip(program))
    expect(error._tag).toBe("ParseError")
    expect(error.expected).toContain("digit")
  })

  it("parseMany over bytes", () => {
    const frame = Binary.lengthTake(Binary.u8)
    const program = Stream.make(new Uint8Array([2, 1]), new Uint8Array([2, 1, 9]), new Uint8Array([0])).pipe(
      ParserStream.parseMany(frame),
      Stream.runCollect
    )
    expect(Effect.runSync(program)).toEqual([new Uint8Array([1, 2]), new Uint8Array([9]), new Uint8Array([])])
  })

  it("parseMany requires progress", () => {
    const program = Stream.make("abc").pipe(ParserStream.parseMany(Parser.succeed(1)), Stream.runCollect)
    const error = Effect.runSync(Effect.flip(program))
    expect(error.kind).toBe("Assert")
  })

  it("parseMany uses services from the stream context", () => {
    class Sep extends Context.Service<Sep, string>()("Sep") {}
    const item = Parser.service(Sep).pipe(Parser.flatMap((sep) => Parser.terminated(Ascii.alpha1, Token.literal(sep))))
    const program = Stream.make("a;b", ";").pipe(
      ParserStream.parseMany(item),
      Stream.runCollect,
      Effect.provideService(Sep, ";")
    )
    expect(Effect.runSync(program)).toEqual(["a", "b"])
  })

  it("parseAll", () => {
    const list = Parser.separated(Ascii.decInt, Token.literal(","))
    const program = Stream.make("1,2", "3,4").pipe(ParserStream.parseAll(list))
    expect(Effect.runSync(program)).toEqual([1, 23, 4])
  })
})

describe("ParserSchema", () => {
  const Version = ParserSchema.make(
    Parser.struct({
      major: Ascii.decUint,
      minor: Parser.preceded(Token.literal("."), Ascii.decUint)
    }),
    { encode: ({ major, minor }) => `${major}.${minor}` }
  )

  it("decodes", () => {
    expect(Schema.decodeUnknownSync(Version)("1.2")).toEqual({ major: 1, minor: 2 })
  })

  it("encodes", () => {
    expect(Schema.encodeSync(Version)({ major: 3, minor: 4 })).toBe("3.4")
  })

  it("reports parse errors as issues", () => {
    expect(() => Schema.decodeUnknownSync(Version)("1.x")).toThrow(/expected digit/)
    expect(() => Schema.decodeUnknownSync(Version)(12)).toThrow()
  })

  it("forbids encoding without a printer", () => {
    const S = ParserSchema.make(Ascii.decUint)
    expect(Schema.decodeUnknownSync(S)("7")).toBe(7)
    expect(() => Schema.encodeSync(S)(7)).toThrow(/Encoding is not supported/)
  })

  it("composes with other schemas", () => {
    const Point = Schema.Struct({ at: Version })
    expect(Schema.decodeUnknownSync(Point)({ at: "0.1" })).toEqual({ at: { major: 0, minor: 1 } })
  })
})

describe("Nom", () => {
  it("hex color (nom README example)", () => {
    const hexPrimary = Nom.mapRes(
      Nom.takeWhileMN(2, 2, (c: string) => Ascii.isHexDigit(c)),
      (s) => Result.succeed(parseInt(s, 16))
    )
    const hexColor = Nom.preceded(Nom.tag("#"), Nom.tuple(hexPrimary, hexPrimary, hexPrimary))
    expectSuccess(hexColor, "#2F14DF", [47, 20, 223])
  })

  it("multi combinators", () => {
    const abc = Nom.tag("abc")
    expectSuccess(Nom.many0(abc), "abcabc", ["abc", "abc"])
    expectFailure(Nom.many1(abc), "")
    expectSuccess(Nom.manyMN(1, 2, abc), "abcabc", ["abc", "abc"])
    expectSuccess(Nom.count(abc, 2), "abcabc", ["abc", "abc"])
    expectSuccess(Nom.separatedList1(Nom.char(","), abc), "abc,abc", ["abc", "abc"])
    expectSuccess(Nom.separatedList0(Nom.char(","), abc), "", [])
    expectSuccess(Nom.manyTill(abc, Nom.tag("end")), "abcend", [["abc"], "end"])
    expectSuccess(
      Nom.foldMany0(
        abc,
        () => 0,
        (n) => n + 1
      ),
      "abcabcabc",
      3
    )
    expectSuccess(
      Nom.foldMany1(
        abc,
        () => 0,
        (n) => n + 1
      ),
      "abc",
      1
    )
    expectSuccess(
      Nom.foldManyMN(
        1,
        2,
        abc,
        () => 0,
        (n) => n + 1
      ),
      "abcabc",
      2
    )
  })

  it("combinators", () => {
    expectSuccess(Nom.value(42, Nom.tag("x")), "x", 42)
    expectSuccess(Nom.recognize(Nom.pair(Nom.alpha1, Nom.digit1)), "ab12", "ab12")
    expectSuccess(Nom.consumed(Nom.map(Nom.digit1, Number)), "12", ["12", 12])
    expectSuccess(
      Nom.verify(Nom.alpha1, (s) => s.length === 2),
      "ab",
      "ab"
    )
    expectSuccess(
      Nom.mapOpt(Nom.digit1, (s) => (s === "1" ? Option.some(1) : Option.none())),
      "1",
      1
    )
    expectSuccess(Nom.isA("ab"), "abba", "abba")
    expectSuccess(Nom.isNot(";"), "abc", "abc")
    expectSuccess(Nom.takeWhile1(Ascii.isAlpha), "abc", "abc")
    expectSuccess(
      Nom.takeTill1((c: string) => c === ";"),
      "abc",
      "abc"
    )
    expectSuccess(Nom.tagNoCase("hello"), "HELLO", "HELLO")
    expectSuccess(Nom.double, "1e2", 100)
    expectSuccess(Nom.recognizeFloat, "-1.5", "-1.5")
    expectSuccess(Nom.consumed(Nom.success(1)), "", ["", 1])
    expectFailure(Nom.fail, "")
    expect(expectFailure(Nom.context("thing", Nom.tag("x")), "y").context).toEqual(["thing"])
  })
})
