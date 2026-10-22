import { Option, Result } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { Ascii, Parser, Token } from "../src/index.js"
import { expectFailure, expectSuccess, peek } from "./utils.js"

const partial = <A, E>(p: Parser.Parser<A, E, never, any>, input: any) => {
  const r = Parser.parsePartial(p, input)
  return Result.isSuccess(r) ? r.success : { _tag: "Error", offset: r.failure.offset }
}
const incomplete = (n?: number) => ({ _tag: "Incomplete", needed: n === undefined ? Option.none() : Option.some(n) })
const done = (value: unknown, offset: number) => ({ _tag: "Done", value, offset })
const encode = (s: string) => new TextEncoder().encode(s)

describe("Ascii", () => {
  it("predicates", () => {
    expect(Ascii.isAlpha("a")).toBe(true)
    expect(Ascii.isAlpha("1")).toBe(false)
    expect(Ascii.isDigit(0x35)).toBe(true)
    expect(Ascii.isHexDigit("F")).toBe(true)
    expect(Ascii.isOctDigit("8")).toBe(false)
    expect(Ascii.isAlphanumeric("Z")).toBe(true)
    expect(Ascii.isSpace("\t")).toBe(true)
    expect(Ascii.isMultispace("\n")).toBe(true)
  })

  describe("character classes (nom character tests)", () => {
    it("alpha", () => {
      expect(peek(Ascii.alpha1, "abcd123")).toEqual(Result.succeed(["123", "abcd"]))
      expect(peek(Ascii.alpha0, "123")).toEqual(Result.succeed(["123", ""]))
      const err = expectFailure(Ascii.alpha1, "123")
      expect(err.kind).toBe("Alpha")
      expect(err.expected).toEqual(["letter"])
    })

    it("digit", () => {
      expect(peek(Ascii.digit1, "123abc")).toEqual(Result.succeed(["abc", "123"]))
      expectFailure(Ascii.digit1, "abc")
    })

    it("hex / oct / alphanumeric", () => {
      expect(peek(Ascii.hexDigit1, "12aFg")).toEqual(Result.succeed(["g", "12aF"]))
      expect(peek(Ascii.octDigit1, "1238")).toEqual(Result.succeed(["8", "123"]))
      expect(peek(Ascii.alphanumeric1, "ab12-")).toEqual(Result.succeed(["-", "ab12"]))
    })

    it("space / multispace", () => {
      expect(peek(Ascii.space1, " \t\nx")).toEqual(Result.succeed(["\nx", " \t"]))
      expect(peek(Ascii.multispace1, " \t\r\nx")).toEqual(Result.succeed(["x", " \t\r\n"]))
      expectFailure(Ascii.multispace1, "x")
    })

    it("partial", () => {
      expect(partial(Ascii.digit1, "123")).toEqual(incomplete(1))
      expect(partial(Ascii.digit1, "123;")).toEqual(done("123", 3))
      expect(partial(Ascii.digit1, "")).toEqual(incomplete(1))
    })

    it("bytes", () => {
      expectSuccess(Ascii.bytes.digit1, encode("42"), encode("42"))
      expectSuccess(Ascii.bytes.decUint, encode("42"), 42)
    })
  })

  describe("line endings", () => {
    it("crlf / newline / lineEnding", () => {
      expectSuccess(Ascii.crlf, "\r\n", "\r\n")
      expectSuccess(Ascii.newline, "\n", "\n")
      expectSuccess(Ascii.lineEnding, "\r\n", "\r\n")
      expectSuccess(Ascii.lineEnding, "\n", "\n")
      expect(expectFailure(Ascii.lineEnding, "\r").expected).toEqual(["line ending"])
      expect(partial(Ascii.lineEnding, "\r")).toEqual(incomplete(1))
    })

    it("tillLineEnding (winnow till_line_ending tests)", () => {
      expect(peek(Ascii.tillLineEnding, "ab12cd\nefgh")).toEqual(Result.succeed(["\nefgh", "ab12cd"]))
      expect(peek(Ascii.tillLineEnding, "ab12cd\r\nefgh")).toEqual(Result.succeed(["\r\nefgh", "ab12cd"]))
      expect(peek(Ascii.tillLineEnding, "abc")).toEqual(Result.succeed(["", "abc"]))
      expectFailure(Ascii.tillLineEnding, "ab\rcd")
      expect(partial(Ascii.tillLineEnding, "abc")).toEqual(incomplete(1))
    })
  })

  describe("numbers", () => {
    it("decUint", () => {
      expectSuccess(Ascii.decUint, "12345", 12345)
      expectFailure(Ascii.decUint, "-1")
      const err = expectFailure(Ascii.decUint, "99999999999999999999")
      expect(err.cause).toBe("integer overflow")
    })

    it("decInt", () => {
      expectSuccess(Ascii.decInt, "-12", -12)
      expectSuccess(Ascii.decInt, "+12", 12)
      const err = expectFailure(Ascii.decInt, "x")
      expect(err.expected).toEqual(['one of "+-"', "digit"])
    })

    it("big integers", () => {
      expectSuccess(Ascii.decBigUint, "123456789012345678901234567890", 123456789012345678901234567890n)
      expectSuccess(Ascii.decBigInt, "-5", -5n)
      expectSuccess(Ascii.decBigInt, "+5", 5n)
    })

    it("hexUint", () => {
      expectSuccess(Ascii.hexUint, "ff", 255)
      expectSuccess(Ascii.hexUint, "DEADbeef", 0xdeadbeef)
      expectFailure(Ascii.hexUint, "g")
    })

    it("float (winnow float tests)", () => {
      const cases: Array<[string, number]> = [
        ["1", 1],
        ["1.", 1],
        ["1.5", 1.5],
        [".5", 0.5],
        ["-1.5", -1.5],
        ["+1.5", 1.5],
        ["1e3", 1000],
        ["1.5E-3", 0.0015],
        ["-1.5e+3", -1500],
        ["inf", Infinity],
        ["-Infinity", -Infinity],
        ["INF", Infinity]
      ]
      for (const [input, expected] of cases) expectSuccess(Ascii.float, input, expected)
      expect(Number.isNaN(Parser.parseSync(Ascii.float, "NaN"))).toBe(true)
      expectFailure(Ascii.float, "abc")
      expectFailure(Ascii.float, ".")
      expect(peek(Ascii.float, "1.5e")).toEqual(Result.succeed(["e", 1.5]))
      expect(expectFailure(Ascii.float, "x").expected).toEqual(["number"])
    })

    it("float partial", () => {
      expect(partial(Ascii.float, "1.5")).toEqual(incomplete(1))
      expect(partial(Ascii.float, "1.5;")).toEqual(done(1.5, 3))
    })

    it("float on bytes", () => {
      expectSuccess(Ascii.bytes.float, encode("-2.5e1"), -25)
    })
  })

  describe("caseless", () => {
    it("matches regardless of ASCII case", () => {
      expect(peek(Ascii.caseless("hello"), "HeLLo world")).toEqual(Result.succeed([" world", "HeLLo"]))
      expectFailure(Ascii.caseless("hello"), "help!")
      expectSuccess(Ascii.caseless(encode("get")), encode("GET"), encode("GET"))
    })
  })

  describe("escapes", () => {
    it("takeEscaped (winnow take_escaped tests)", () => {
      const esc = Ascii.takeEscaped(Ascii.alpha1, "\\", Token.oneOf('"n\\'))
      expect(peek(esc, "abcd;")).toEqual(Result.succeed([";", "abcd"]))
      expect(peek(esc, 'ab\\"cd;')).toEqual(Result.succeed([";", 'ab\\"cd']))
      expect(peek(esc, '\\"abcd;')).toEqual(Result.succeed([";", '\\"abcd']))
      expect(peek(esc, "\\n;")).toEqual(Result.succeed([";", "\\n"]))
      expect(peek(esc, 'ab\\"12')).toEqual(Result.succeed(["12", 'ab\\"']))
      expectFailure(Parser.allConsuming(esc), "AB\\")
      expectFailure(Parser.allConsuming(esc), "AB\\A")
    })

    it("escaped (winnow escaped / nom escaped_transform tests)", () => {
      const esc = Ascii.escaped(
        Ascii.alpha1,
        "\\",
        Parser.alt(
          Token.literal("\\"),
          Token.literal('"').pipe(Parser.as('"')),
          Token.literal("n").pipe(Parser.as("\n"))
        )
      )
      expect(peek(esc, "abcd;")).toEqual(Result.succeed([";", "abcd"]))
      expect(peek(esc, 'ab\\"cd;')).toEqual(Result.succeed([";", 'ab"cd']))
      expect(peek(esc, '\\"abcd;')).toEqual(Result.succeed([";", '"abcd']))
      expect(peek(esc, "\\n;")).toEqual(Result.succeed([";", "\n"]))
      expect(peek(esc, 'ab\\"12')).toEqual(Result.succeed(["12", 'ab"']))
      expectFailure(Parser.allConsuming(esc), "AB\\")
      expectFailure(Parser.allConsuming(esc), "AB\\A")
    })

    it("escaped with a normal parser that may match nothing", () => {
      const str = Parser.delimited(
        Token.literal('"'),
        Ascii.escaped(
          Token.takeTill('"\\'),
          "\\",
          Parser.alt(Token.literal("\\"), Token.literal('"'), Token.literal("n").pipe(Parser.as("\n")))
        ),
        Token.literal('"')
      )
      expectSuccess(str, '""', "")
      expectSuccess(str, '"a\\"b\\nc"', 'a"b\nc')
    })
  })
})
