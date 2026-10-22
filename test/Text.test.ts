import { Effect, Option, Result, Stream } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { Encoding, Parser, ParserStream, Text, Token } from "../src/index.js"
import { expectFailure, expectSuccess, peek } from "./utils.js"

const encoders = {
  string: (s: string) => s,
  utf8: (s: string) => new TextEncoder().encode(s),
  utf16le: Encoding.utf16le.encode,
  utf16be: Encoding.utf16be.encode
}

const sets: ReadonlyArray<readonly [string, Text.TextParsers<any>, (s: string) => string | Uint8Array]> = [
  ["string", Text.string, encoders.string],
  ["utf8", Text.utf8, encoders.utf8],
  ["utf16le", Text.utf16le, encoders.utf16le],
  ["utf16be", Text.utf16be, encoders.utf16be]
]

const partial = <A, E>(p: Parser.Parser<A, E, never, any>, input: any) => {
  const r = Parser.parsePartial(p, input)
  return Result.isSuccess(r) ? r.success : { _tag: "Error", offset: r.failure.offset }
}

describe("Text predicates", () => {
  it("follow Unicode properties", () => {
    expect(Text.isAlphabetic("Ω")).toBe(true)
    expect(Text.isAlphabetic("1")).toBe(false)
    expect(Text.isLetter("ß")).toBe(true)
    expect(Text.isUppercase("Σ")).toBe(true)
    expect(Text.isLowercase("σ")).toBe(true)
    expect(Text.isDecimalDigit("٣")).toBe(true)
    expect(Text.isDecimalDigit("½")).toBe(false)
    expect(Text.isNumeric("½")).toBe(true)
    expect(Text.isAlphanumeric("Ⅻ")).toBe(true)
    expect(Text.isWhitespace("\u2028")).toBe(true)
    expect(Text.isSpace("\u00a0")).toBe(true)
    expect(Text.isSpace("\n")).toBe(false)
    expect(Text.isIdStart("ü")).toBe(true)
    expect(Text.isIdContinue("\u0301")).toBe(true)
    expect(Text.isPunctuation("¿")).toBe(true)
    expect(Text.isControl("\u0007")).toBe(true)
    // Astral code points, as strings or numbers
    expect(Text.isLetter("𝒜")).toBe(true)
    expect(Text.isLetter(0x1d49c)).toBe(true)
    expect(Text.isLetter("😀")).toBe(false)
    expect(Text.property("Emoji")("😀")).toBe(true)
    expect(Text.property("Script=Greek")("λ")).toBe(true)
    expect(Text.property("Script=Greek")("l")).toBe(false)
  })

  it("work with Token parsers and keep their names", () => {
    expectSuccess(Token.takeWhile(Text.isLetter), "Zoë", "Zoë")
    expect(expectFailure(Token.oneOf(Text.isLetter), "1").expected).toEqual(["isLetter"])
  })
})

describe.each(sets)("Text.%s", (_, T, enc) => {
  const ok = <A>(p: Parser.Parser<A, any, never, any>, input: string, expected: A) =>
    expectSuccess(p, enc(input), expected)
  const fails = (p: Parser.Parser<any, any, never, any>, input: string) => expectFailure(p, enc(input))
  const rest = <A>(p: Parser.Parser<A, any, never, any>, input: string) => {
    const r = peek(p, enc(input))
    return Result.map(r, ([remaining, a]) => [T.encoding.text(remaining as any, 0, remaining.length), a])
  }

  it("any", () => {
    ok(Parser.repeat(T.any), "aé😀", ["a", "é", "😀"])
    expect(fails(T.any, "").expected).toEqual(["any character"])
  })

  it("literal and caseless", () => {
    ok(T.literal("¡hola!"), "¡hola!", "¡hola!")
    expect(rest(T.literal("π"), "π=3")).toEqual(Result.succeed(["=3", "π"]))
    expect(fails(T.literal("πr"), "πR").expected).toEqual(['"πr"'])
    ok(T.caseless("ΣΟΦΊΑ"), "σοφία", "σοφία")
    ok(T.caseless("straße"), "STRAẞE", "STRAẞE")
    ok(T.caseless("kelvin"), "KELVIN", "KELVIN")
    fails(T.caseless("straße"), "STRASSE")
  })

  it("oneOf / noneOf", () => {
    ok(T.oneOf(Token.range("α", "ω")), "λ", "λ")
    ok(T.oneOf("😀😎"), "😎", "😎")
    expect(fails(T.oneOf("😀😎"), "x").expected).toEqual(['one of "😀😎"'])
    ok(T.noneOf('"\\'), "ü", "ü")
    fails(T.noneOf('"\\'), "\\")
  })

  it("take / takeWhile / takeTill / takeUntil / rest", () => {
    expect(rest(T.take(2), "😀é😀")).toEqual(Result.succeed(["😀", "😀é"]))
    fails(T.take(3), "😀é")
    expect(rest(T.takeWhile(Text.isLetter), "Ελλάδα!")).toEqual(Result.succeed(["!", "Ελλάδα"]))
    expect(rest(T.takeWhile(Text.isLetter, 2), "Ελλάδα!")).toEqual(Result.succeed(["λάδα!", "Ελ"]))
    expect(rest(T.takeTill("→"), "a😀→b")).toEqual(Result.succeed(["→b", "a😀"]))
    expect(rest(T.takeUntil("→"), "a😀→b")).toEqual(Result.succeed(["→b", "a😀"]))
    fails(T.takeUntil("→", { max: 1 }), "a😀→b")
    fails(T.takeUntil("→"), "abc")
    ok(T.rest, "naïve 😀", "naïve 😀")
    ok(T.taken(Parser.seq(T.alpha1, T.literal("-"), T.digit1)), "ab-٣4", "ab-٣4")
  })

  it("character classes", () => {
    expect(rest(T.alpha1, "Ωμέγα rest")).toEqual(Result.succeed([" rest", "Ωμέγα"]))
    expect(rest(T.digit1, "١٢٣x")).toEqual(Result.succeed(["x", "١٢٣"]))
    expect(rest(T.alphanumeric1, "abc٣½ x")).toEqual(Result.succeed([" x", "abc٣½"]))
    expect(rest(T.space1, " \t\u00a0\u3000\nx")).toEqual(Result.succeed(["\nx", " \t\u00a0\u3000"]))
    expect(rest(T.multispace1, " \n\u2028x")).toEqual(Result.succeed(["x", " \n\u2028"]))
    ok(T.alpha0, "", "")
    const err = fails(T.alpha1, "123")
    expect(err.kind).toBe("Alpha")
    expect(err.expected).toEqual(["letter"])
  })

  it("identifier", () => {
    expect(rest(T.identifier, "_über1 x")).toEqual(Result.succeed([" x", "_über1"]))
    ok(T.identifier, "日本語", "日本語")
    ok(T.identifier, "e\u0301", "e\u0301")
    expect(fails(T.identifier, "1abc").expected).toEqual(["identifier"])
  })

  it("line endings", () => {
    ok(Parser.terminated(T.tillLineEnding, T.lineEnding), "héllo wörld\r\n", "héllo wörld")
    ok(T.tillLineEnding, "no newline ✓", "no newline ✓")
    fails(T.tillLineEnding, "bad\rcr")
    ok(Parser.seq(T.tab, T.newline, T.crlf), "\t\n\r\n", ["\t", "\n", "\r\n"])
  })

  it("numbers", () => {
    ok(T.decUint, "42", 42)
    ok(T.decInt, "-17", -17)
    ok(T.decBigInt, "+12345678901234567890", 12345678901234567890n)
    ok(T.decBigUint, "9", 9n)
    ok(T.hexUint, "fF", 255)
    ok(T.float, "-1.5e3", -1500)
    ok(T.float, "INF", Infinity)
    expect(Number.isNaN(Parser.parseSync(T.float, enc("nan")))).toBe(true)
    // Only ASCII digits are numbers
    fails(T.decUint, "١٢")
  })

  it("escapes", () => {
    const esc = T.escaped(
      T.takeTill('\\"'),
      "\\",
      Parser.alt(T.literal("n").pipe(Parser.as("\n")), T.literal('"'), T.literal("\\"))
    )
    ok(esc, 'a→\\nb\\"😀', 'a→\nb"😀')
    ok(T.takeEscaped(T.alpha1, "\\", T.oneOf('"n')), 'äb\\"cd', 'äb\\"cd')
  })

  it("bom", () => {
    ok(Parser.preceded(T.bom, T.alpha1), "\ufeffabc", "abc")
    ok(Parser.zip(T.bom, T.alpha1), "abc", [false, "abc"])
    expect(partial(T.bom, enc(""))).toMatchObject({ _tag: "Incomplete" })
  })

  it("partial input split inside a character is Incomplete", () => {
    const full = enc("é😀")
    // Cut each input in the middle of the emoji
    const cut = typeof full === "string" ? full.slice(0, 2) : full.subarray(0, full.length - 1)
    expect(partial(T.alpha0, cut)).toMatchObject({ _tag: "Incomplete" })
    expect(partial(Parser.seq(T.any, T.any), cut)).toMatchObject({ _tag: "Incomplete" })
    expect(
      partial(
        T.takeWhile(() => true),
        cut
      )
    ).toMatchObject({ _tag: "Incomplete" })
    expect(partial(T.literal("é😀"), cut)).toMatchObject({ _tag: "Incomplete" })
    // ...but the same truncated input in complete mode is malformed
    fails(T.any.pipe(Parser.zipRight(T.any)), typeof full === "string" ? full.slice(0, 2) : "x")
    expect(partial(T.alpha1, enc("abc!"))).toEqual({ _tag: "Done", value: "abc", offset: enc("abc").length })
  })
})

describe("Token.codePoints in Text parsers", () => {
  const isNameStart = Token.codePoints("name start", (c) => c === 0x5f || (c >= 0x61 && c <= 0x7a) || c >= 0xc0)
  const isAstral = Token.codePoints("astral", (c) => c > 0xffff, [[0x10000, 0x10ffff]])

  it.each(sets)("%s", (_, T, encode) => {
    const seen: Array<unknown> = []
    const spy = Token.codePoints("spy", (c) => (seen.push(c), c !== 0x20))
    expectSuccess(T.takeWhile(spy), encode("aé😀"), "aé😀")
    expect(seen).toEqual([0x61, 0xe9, 0x1f600])
    expect(peek(T.takeWhile([isNameStart, Token.range("0", "9")], { min: 1 }), encode("x1é😀 y"))).toEqual(
      Result.succeed([encode(" y"), "x1é😀"])
    )
    expectSuccess(T.oneOf(isAstral), encode("😀"), "😀")
    expectFailure(T.oneOf(isAstral), encode("é"))
    expectSuccess(T.noneOf([isAstral, "b"]), encode("é"), "é")
    expectFailure(T.noneOf([isAstral, "b"]), encode("😀"))
    expect(expectFailure(T.oneOf([isNameStart, "1"]), encode("2")).message).toContain('expected name start or "1"')
  })
})

describe("Text over bytes", () => {
  it("rejects malformed UTF-8", () => {
    for (const bad of [
      [0xff],
      [0xc0, 0x80], // overlong
      [0xe0, 0x80, 0x80], // overlong
      [0xed, 0xa0, 0x80], // surrogate
      [0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
      [0xc3], // truncated
      [0xe2, 0x82] // truncated
    ]) {
      expectFailure(Text.utf8.any, new Uint8Array(bad))
    }
  })

  it("rejects unpaired UTF-16 surrogates", () => {
    expectFailure(Text.utf16le.any, new Uint8Array([0x00, 0xdc]))
    expectFailure(Text.utf16le.any, new Uint8Array([0x3d, 0xd8, 0x41, 0x00]))
    expectFailure(Text.string.any, "\udc00")
    expectFailure(Text.string.rest, "ab\ud800")
  })

  it("stops classes at malformed input and reports it", () => {
    const input = new Uint8Array([0x61, 0x62, 0xff, 0x63])
    const err = expectFailure(Text.utf8.alpha1, input)
    expect(err.offset).toBe(2)
    expect(err.message).toBe(
      [
        "Parse error at line 1, column 3 (byte 2):",
        "1 | ab�c",
        "  |   ^",
        "expected letter or end of input, found invalid UTF-8 0xff"
      ].join("\n")
    )
    expect(Parser.parse(Parser.taken(Text.utf8.alpha1), new Uint8Array([0x61, 0x62]))).toEqual(
      Result.succeed(new Uint8Array([0x61, 0x62]))
    )
  })

  it("renders errors as text with line and column", () => {
    const p = Parser.separated(Text.utf8.alpha1, Text.utf8.lineEnding)
    const err = expectFailure(p, encoders.utf8("héllo\nwörld!"))
    expect(err.position).toEqual({ line: 2, column: 6 })
    expect(err.message).toBe(
      [
        "Parse error at line 2, column 6 (byte 13):",
        "2 | wörld!",
        "  |      ^",
        'expected letter, line ending or end of input, found "!"'
      ].join("\n")
    )

    const err16 = expectFailure(Parser.separated(Text.utf16be.alpha1, Text.utf16be.lineEnding), encoders.utf16be("😀"))
    expect(err16.message).toContain("1 | 😀\n  | ^")
    expect(err16.message).toContain('found "😀"')
  })

  it("latin1", () => {
    expectSuccess(Text.latin1.alpha1, new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "café")
    expectSuccess(Text.latin1.literal("é"), new Uint8Array([0xe9]), "é")
    expect(() => Text.latin1.literal("€")).toThrow(RangeError)
  })

  it("custom encodings with make", () => {
    // UTF-32LE
    const utf32: Encoding.Encoding<Uint8Array> = {
      name: "UTF-32LE",
      unit: 4,
      asciiCompatible: false,
      decode: (b, i, end) => {
        if (i + 3 >= end) return -2
        const cp = (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0
        return cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? -1 : cp
      },
      width: () => 4,
      encode: (s) => new Uint8Array(new Uint32Array(Array.from(s, (c) => c.codePointAt(0)!)).buffer),
      text: (b, start, end) => String.fromCodePoint(...new Uint32Array(b.slice(start, end).buffer))
    }
    const T = Text.make(utf32)
    expectSuccess(
      Parser.separatedPair(T.alpha1, T.literal("→"), T.decUint),
      utf32.encode("é😀x→42".replace("😀", "")),
      ["éx", 42]
    )
    expect(expectFailure(T.alpha1, utf32.encode("😀")).message).toContain('found "😀"')
  })

  it("Encoding.sniff", () => {
    expect(Encoding.sniff(new Uint8Array([0xef, 0xbb, 0xbf]))).toEqual(Option.some(Encoding.utf8))
    expect(Encoding.sniff(new Uint8Array([0xff, 0xfe]))).toEqual(Option.some(Encoding.utf16le))
    expect(Encoding.sniff(new Uint8Array([0xfe, 0xff]))).toEqual(Option.some(Encoding.utf16be))
    expect(Encoding.sniff(new Uint8Array([0x41]))).toEqual(Option.none())
  })

  it("streams bytes split inside characters", () => {
    const bytes = encoders.utf8("αβγ\nδεζ\nηθ")
    // One byte per chunk: every multi-byte character is split
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]))
    const word = Parser.terminated(Text.utf8.alpha1, Text.utf8.multispace0)
    const program = Stream.fromIterable(chunks).pipe(ParserStream.parseMany(word), Stream.runCollect)
    expect(Effect.runSync(program)).toEqual(["αβγ", "δεζ", "ηθ"])
  })
})
