import { Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import { Parser, Token } from "../src/index.js"
import { expectFailure, expectSuccess, peek } from "./utils.js"

const partial = <A, E>(p: Parser.Parser<A, E, never, any>, input: any) => {
  const r = Parser.parsePartial(p, input)
  return Result.isSuccess(r) ? r.success : { _tag: "Error", offset: r.failure.offset }
}
const incomplete = (n?: number) => ({ _tag: "Incomplete", needed: n === undefined ? Option.none() : Option.some(n) })
const done = (value: unknown, offset: number) => ({ _tag: "Done", value, offset })
const bytes = (...xs: Array<number>) => new Uint8Array(xs)

describe("Token", () => {
  describe("any", () => {
    it("string", () => {
      expect(peek(Token.any, "abc")).toEqual(Result.succeed(["bc", "a"]))
      expectFailure(Token.any, "")
    })

    it("handles astral code points", () => {
      expect(peek(Token.any, "😀x")).toEqual(Result.succeed(["x", "😀"]))
    })

    it("bytes and arrays", () => {
      expectSuccess(Token.anyToken<Uint8Array>(), bytes(7), 7)
      expectSuccess(Token.anyToken<ReadonlyArray<{ t: string }>>(), [{ t: "x" }], { t: "x" })
    })

    it("partial", () => {
      expect(partial(Token.any, "")).toEqual(incomplete(1))
    })
  })

  describe("literal", () => {
    it("string", () => {
      expect(peek(Token.literal("Hello"), "Hello, World!")).toEqual(Result.succeed([", World!", "Hello"]))
      expectFailure(Token.literal("Hello"), "Something")
      expectFailure(Token.literal("Hello"), "")
    })

    it("partial (winnow partial_literal tests)", () => {
      expect(partial(Token.literal("Hello"), "Hel")).toEqual(incomplete(2))
      expect(partial(Token.literal("Hello"), "")).toEqual(incomplete(5))
      expect(partial(Token.literal("Hello"), "Help")).toEqual({ _tag: "Error", offset: 0 })
    })

    it("bytes", () => {
      const p = Token.literal(bytes(1, 2))
      expect(peek(p, bytes(1, 2, 3))).toEqual(Result.succeed([bytes(3), bytes(1, 2)]))
      expectFailure(p, bytes(1, 3))
    })

    it("token arrays", () => {
      const p = Token.literal(["let", "x"])
      expectSuccess(p, ["let", "x"], ["let", "x"])
    })

    it("string literals match byte input as UTF-8", () => {
      const p = Token.literal("é") as unknown as Parser.Parser<Uint8Array, never, never, Uint8Array>
      expectSuccess(p, new TextEncoder().encode("é"), new TextEncoder().encode("é"))
    })
  })

  describe("oneOf / noneOf", () => {
    it("character sets", () => {
      expect(peek(Token.oneOf("abc"), "b")).toEqual(Result.succeed(["", "b"]))
      expectFailure(Token.oneOf("a"), "bc")
      expect(peek(Token.noneOf("abc"), "z")).toEqual(Result.succeed(["", "z"]))
      expectFailure(Token.noneOf("ab"), "a")
    })

    it("ranges, predicates and unions", () => {
      const ident = Token.oneOf([Token.range("a", "z"), "_", (c: string) => c === "$"])
      expectSuccess(ident, "q", "q")
      expectSuccess(ident, "_", "_")
      expectSuccess(ident, "$", "$")
      expectFailure(ident, "Q")
    })

    it("non-ASCII sets", () => {
      expectSuccess(Token.oneOf("αβγ😀"), "😀", "😀")
      expectFailure(Token.oneOf("αβγ"), "δ")
    })

    it("bytes", () => {
      const p = Token.oneOf<Uint8Array>([0x01, Token.range(0x30, 0x39), "x"])
      expectSuccess(p, bytes(0x35), 0x35)
      expectSuccess(p, bytes(0x78), 0x78)
      expectFailure(p, bytes(0x02))
    })

    it("arrays", () => {
      type Tok = "(" | ")" | "x"
      const p = Token.oneOf<ReadonlyArray<Tok>>(["(", ")"])
      expectSuccess(p, ["("], "(")
      expectFailure(p, ["x"])
    })

    it("error messages", () => {
      const err = expectFailure(Token.oneOf("abc"), "z")
      expect(err.message).toContain("expected one of \"abc\", found \"z\"")
    })
  })

  describe("take", () => {
    it("string (counts code points)", () => {
      expect(peek(Token.take(3), "😀bcd")).toEqual(Result.succeed(["d", "😀bc"]))
      expectFailure(Token.take(3), "ab")
    })

    it("bytes", () => {
      expect(peek(Token.take<Uint8Array>(2), bytes(1, 2, 3))).toEqual(Result.succeed([bytes(3), bytes(1, 2)]))
    })

    it("partial", () => {
      expect(partial(Token.take(4), "ab")).toEqual(incomplete(2))
    })
  })

  describe("takeWhile / takeTill", () => {
    const alpha = Token.range("a", "z")

    it("zero or more", () => {
      expect(peek(Token.takeWhile(alpha), "abc123")).toEqual(Result.succeed(["123", "abc"]))
      expect(peek(Token.takeWhile(alpha), "123")).toEqual(Result.succeed(["123", ""]))
    })

    it("ranges (winnow take_while_m_n tests)", () => {
      const p = Token.takeWhile(alpha, { min: 3, max: 6 })
      expect(peek(p, "latin123")).toEqual(Result.succeed(["123", "latin"]))
      expect(peek(p, "lengthy")).toEqual(Result.succeed(["y", "length"]))
      expectFailure(p, "ab12")
      expectFailure(p, "")
    })

    it("partial (winnow partial take_while tests)", () => {
      expect(partial(Token.takeWhile(alpha), "abc")).toEqual(incomplete(1))
      expect(partial(Token.takeWhile(alpha), "abc1")).toEqual(done("abc", 3))
      expect(partial(Token.takeWhile(alpha, { max: 2 }), "abc")).toEqual(done("ab", 2))
    })

    it("takeTill", () => {
      expect(peek(Token.takeTill(":"), "key:value")).toEqual(Result.succeed([":value", "key"]))
      expectFailure(Token.takeTill(":", { min: 1 }), ":")
    })

    it("bytes", () => {
      const p = Token.takeWhile<Uint8Array>((b) => b < 10)
      expect(peek(p, bytes(1, 2, 30))).toEqual(Result.succeed([bytes(30), bytes(1, 2)]))
    })

    it("reports the offending position", () => {
      const err = expectFailure(Token.takeWhile(alpha, { min: 3 }), "ab1")
      expect(err.offset).toBe(2)
    })
  })

  describe("codePoints", () => {
    const seen: Array<unknown> = []
    const isNameStart = Token.codePoints("name start", (c) => {
      seen.push(c)
      return c === 0x5f || (c >= 0x61 && c <= 0x7a) || c >= 0xc0
    })
    const isAstral = Token.codePoints("astral", (c) => c > 0xffff, [[0x10000, 0x10ffff]])

    it("receives code points, for BMP and astral characters", () => {
      seen.length = 0
      expectSuccess(Token.takeWhile(isNameStart), "a_é😀", "a_é😀")
      expect(seen).toEqual([0x61, 0x5f, 0xe9, 0x1f600])
      expectSuccess(Token.oneOf(isAstral), "😀", "😀")
      expectFailure(Token.oneOf(isAstral), "é")
      expectSuccess(Token.noneOf(isAstral), "é", "é")
      expectFailure(Token.noneOf(isAstral), "😀")
    })

    it("inside arrays, next to strings, ranges and string predicates", () => {
      const name = Token.takeWhile([isNameStart, Token.range("0", "9"), (c: string) => c === "-"], { min: 1 })
      expect(peek(name, "x-1😀 y")).toEqual(Result.succeed([" y", "x-1😀"]))
      expect(peek(Token.takeTill([isAstral, " "]), "ab😀")).toEqual(Result.succeed(["😀", "ab"]))
      expectFailure(name, " ")
    })

    it("names the set in errors", () => {
      expect(expectFailure(Token.oneOf(isNameStart), "1").message).toContain("expected name start, found \"1\"")
      expect(expectFailure(Token.oneOf([isAstral, "a"]), "1").message).toContain("expected astral or \"a\"")
    })

    it("bytes", () => {
      expectSuccess(Token.takeWhile<Uint8Array>(isNameStart), bytes(0x61, 0xff), bytes(0x61, 0xff))
      expectFailure(Token.oneOf<Uint8Array>(isNameStart), bytes(0x30))
    })

    it("leaves the given function unmarked", () => {
      const f = (c: string) => c === "a"
      Token.codePoints("a", f as unknown as (c: number) => boolean)
      expectSuccess(Token.oneOf(f), "a", "a")
    })
  })

  describe("string predicates", () => {
    it("receive whole characters, astral ones included", () => {
      const seen: Array<string> = []
      expectSuccess(Token.takeWhile((c: string) => (seen.push(c), true)), "aé😀\ud800", "aé😀\ud800")
      expect(seen).toEqual(["a", "é", "😀", "\ud800"])
    })
  })

  describe("takeUntil", () => {
    it("string", () => {
      expect(peek(Token.takeUntil("world"), "Hello world")).toEqual(Result.succeed(["world", "Hello "]))
      expectFailure(Token.takeUntil("world"), "Hello")
    })

    it("ranges", () => {
      expectFailure(Token.takeUntil("x", { min: 1 }), "x")
      expect(Result.isFailure(Parser.parsePeek(Token.takeUntil("x", { min: 1 }), "xx"))).toBe(true)
      expect(peek(Token.takeUntil("x", { min: 1 }), "ax")).toEqual(Result.succeed(["x", "a"]))
      expectFailure(Token.takeUntil("x", { max: 2 }), "abcx")
    })

    it("bytes", () => {
      const p = Token.takeUntil(bytes(0, 0))
      expect(peek(p, bytes(1, 0, 2, 0, 0))).toEqual(Result.succeed([bytes(0, 0), bytes(1, 0, 2)]))
    })

    it("partial", () => {
      expect(partial(Token.takeUntil("--"), "abc-")).toEqual(incomplete())
      expect(partial(Token.takeUntil("--"), "abc--")).toEqual(done("abc", 3))
    })
  })

  describe("rest", () => {
    it("rest / restLen", () => {
      expectSuccess(Parser.preceded(Token.literal("a"), Token.rest), "abc", "bc")
      expect(peek(Token.restLen, "abc")).toEqual(Result.succeed(["abc", 3]))
      expectSuccess(Token.restOf<Uint8Array>(), bytes(1, 2), bytes(1, 2))
    })
  })

  describe("built on every run", () => {
    const message = (p: Parser.Parser<any, any, never, any>, input: any) => {
      const r = Parser.parse(p, input)
      return Result.isFailure(r) ? r.failure.message : r.success
    }

    it("parsers built inside Parser.gen behave like hoisted ones", () => {
      const inline = Parser.gen(function*() {
        const sign = yield* Parser.opt(Token.oneOf("+-"))
        const digits = yield* Token.takeWhile("0123456789", { min: 1 })
        yield* Token.literal(";")
        return [sign, digits]
      })
      const sign = Parser.opt(Token.oneOf("+-"))
      const digits = Token.takeWhile("0123456789", { min: 1 })
      const semi = Token.literal(";")
      const reference = Parser.map(Parser.seq(sign, digits, semi), ([s, d]) => [s, d])
      for (let i = 0; i < 3; i++) {
        for (const input of ["-12;", "12;", "+;", "12,", "x"]) {
          expect(message(inline, input)).toEqual(message(reference, input))
        }
      }
      expect(message(inline, "12,")).toMatch(/expected ";", found ","$/)
    })

    it("describes literals and sets the same way each time", () => {
      for (let i = 0; i < 2; i++) {
        expect(String(Token.literal("a\"\n"))).toBe("Parser(\"a\\\"\\n\")")
        expect(String(Token.literal(bytes(0x47, 0x0a)))).toBe("Parser(b\"G\\n\")")
        expect(String(Token.literal(["a", 1]))).toBe("Parser([\"a\", 1])")
        expect(String(Token.oneOf("+-"))).toBe("Parser(one of \"+-\")")
        expect(String(Token.noneOf("x"))).toBe("Parser(anything but \"x\")")
        expect(message(Token.takeUntil("a\"b"), "xyz")).toMatch(/expected "a\\"b", found end of input$/)
      }
    })

    it("returns a new parser each time", () => {
      expect(Token.literal("x")).not.toBe(Token.literal("x"))
      expect(Token.oneOf("xy")).not.toBe(Token.oneOf("xy"))
    })

    it("shares nothing that changes behaviour across input kinds", () => {
      const p = Token.oneOf("ab")
      expectSuccess(p, "b", "b")
      expectSuccess(Token.oneOf<Uint8Array>("ab"), bytes(0x61), 0x61)
      expectSuccess(Token.literal("é"), "é", "é")
      expectSuccess(Parser.preceded(Token.literal("é"), Token.rest), new TextEncoder().encode("éx") as any, bytes(0x78) as any)
    })

    it("stays correct with many distinct literals and sets", () => {
      const first = Token.takeWhile("ab")
      for (let i = 0; i < 3000; i++) {
        const s = `k${i}`
        expectSuccess(Token.literal(s), s, s)
        expect(String(Token.literal(s))).toBe(`Parser("${s}")`)
        expect(peek(Token.takeWhile(s), `${s}${s}!`)).toEqual(Result.succeed(["!", `${s}${s}`]))
        expect(String(Token.oneOf(s))).toBe(`Parser(one of "${s}")`)
      }
      expect(peek(first, "abbac")).toEqual(Result.succeed(["c", "abba"]))
    })
  })
})
