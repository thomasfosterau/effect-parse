/**
 * Incremental (streaming) parsing: parsing a stream of chunks must give
 * exactly the result of parsing the whole input at once, however it is
 * split, while parsing as the chunks arrive.
 */
import * as Predicate from "effect/Predicate"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { assert, describe, expect, it } from "vite-plus/test"
import * as Arithmetic from "../examples/arithmetic.js"
import * as Http from "../examples/http.js"
import * as Ini from "../examples/ini.js"
import * as Json from "../examples/json.js"
import * as JsonFast from "../examples/json-fast.js"
import { jsonGrammar } from "../examples/json-text.js"
import * as Sexpr from "../examples/sexpr.js"
import type { Input } from "../src/index.js"
import { Ascii, Compiler, Encoding, Expression, Parser, ParserStream, Text, Token } from "../src/index.js"
import * as Registry from "../src/internal/compiler/registry.js"
import { mutations, randomJson, rng } from "./generators.js"

const errorFields = (e: any) => ({
  offset: e.offset,
  kind: e.kind,
  mode: e.mode,
  expected: e.expected,
  context: e.context,
  cause: e.cause,
  message: e.message
})

const outcome = (r: Result.Result<unknown, any>) =>
  Result.isSuccess(r) ? { ok: true, value: r.success } : { ok: false, error: errorFields(r.failure) }

/** Splits an input into chunks of random sizes (at most `max`). */
const split = <I extends string | Uint8Array>(input: I, random: () => number, max: number): Array<I> => {
  const out: Array<I> = []
  const take = (i: number): Array<I> => {
    if (i >= input.length) return out
    const n = 1 + Math.floor(random() * max)
    out.push(input.slice(i, i + n) as I)
    return take(i + n)
  }
  return take(0)
}

const streamed = (
  p: Parser.Parser<any, any, never, any>,
  chunks: ReadonlyArray<string | Uint8Array>,
  empty?: Input.Input
) => Effect.runSync(Effect.result(Stream.fromIterable(chunks).pipe(ParserStream.parseAll(p, { empty: empty as any }))))

let checked = 0

const twins = new Map<Parser.Parser.Any, ReadonlyArray<Parser.Parser.Any>>()

/** The parser itself (interpreted) and compiled twins of it, one per backend. */
const variants = <P extends Parser.Parser.Any>(p: P): ReadonlyArray<P> => {
  let v = twins.get(p)
  if (v === undefined) {
    v = [p, ...(["closure", "jit"] as const).map((backend) => Compiler[backend](Parser.named(p, "twin")))]
    twins.set(p, v)
  }
  return v as ReadonlyArray<P>
}

/** Checks that streaming `input` in chunks gives the result of parsing it whole, interpreted and compiled. */
const same = <I extends string | Uint8Array>(p: Parser.Parser<any, any, never, I>, input: I, seed: number): void => {
  const expected = outcome(Parser.parse(p, input as never))
  const random = rng(seed)
  const empty = Predicate.isString(input) ? "" : new Uint8Array(0)
  ;[1, 3, 17, 4096].forEach((max) => {
    const chunks = split(input, random, max)
    variants(p).forEach((v, i) => {
      expect(outcome(streamed(v, chunks, empty)), `variant ${i}, chunks of up to ${max}`).toEqual(expected)
      checked++
    })
  })
}

const jsonDocs = (() => {
  const random = rng(5)
  const docs = Array.from({ length: 30 }, () => ` ${randomJson(random)} `)
  docs.push("[1,,2]", '{"a": "unterminated}', '"\\x"', "", " ", "[", '{"a" 1}', "[1] x", '"\\ud800\\u0041"')
  return [...docs, ...docs.slice(0, 12).flatMap((d, i) => mutations(d, '{}[],:"\\0123456789.e-tfnul é😀', 10, i))]
})()

describe("streaming parses", () => {
  it("json (Token/Ascii) on strings", () => {
    jsonDocs.forEach((doc, i) => same(Json.json, doc, i))
  })

  it.each([
    ["Text.string", Text.string],
    ["Text.utf8", Text.utf8],
    ["Text.utf16le", Text.utf16le]
  ] as const)("json-text with %s", (_, T) => {
    const p = jsonGrammar(T as Text.TextParsers<any>)
    jsonDocs.forEach((doc, i) => same(p, (T.encoding as Encoding.Encoding<any>).encode(doc), i))
  })

  it.each([
    ["Text.string", Text.string],
    ["Text.utf8", Text.utf8]
  ] as const)("json-fast with %s (objects built with fromEntries)", (_, T) => {
    const p = JsonFast.jsonGrammar(T as Text.TextParsers<any>)
    jsonDocs.forEach((doc, i) => same(p, (T.encoding as Encoding.Encoding<any>).encode(doc), i))
  })

  it("json-text on malformed bytes", () => {
    const p = jsonGrammar(Text.utf8)
    const random = rng(8)
    const base = Encoding.utf8.encode('["aé😀", {"k": "v\\n"}, 12, [true]]')
    Array.from({ length: 100 }).forEach((_, i) => {
      const bytes = base.slice()
      bytes[Math.floor(random() * bytes.length)] = [0x80, 0xc3, 0xf0, 0xff, 0x22, 0x5c][i % 6]
      same(p, bytes, i)
    })
  })

  it("the other examples", () => {
    const ini = "[owner]\nname=John Doe\norganization=Acme\n\n[database]\nserver=192.0.2.62\nport=143\n"
    ;[ini, ...mutations(ini, "[]=\n ab", 40, 3)].forEach((input, i) => same(Ini.ini, input, i))
    const http = "GET /index.html HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n continued\r\n\r\n"
    ;[http, ...mutations(http, "\r\n :/GE", 40, 4)].forEach((input, i) => {
      same(Http.request, new TextEncoder().encode(input), i)
    })
    const sums = ["1 + 2*3 - 4 / 2", " 2* (  3 + 4 ) ", "1 +", "(1 + 2"]
    ;[...sums, ...sums.flatMap((d, j) => mutations(d, "0123456789+-*/() ", 10, j))].forEach((input, i) => {
      same(Arithmetic.evaluate, input, i)
      same(Sexpr.program, `(+ ${input.replace(/[^0-9 ]/g, " ")})`, i)
    })
  })

  it("repetitions of every kind", () => {
    const a = Token.literal("a")
    const b = Token.literal("b")
    const grammars: ReadonlyArray<Parser.Parser<any, any, never, string>> = [
      Parser.repeat(Parser.alt(Token.literal("ab"), a)),
      Parser.fold(Parser.alt(a, b), { init: () => "", f: (acc, x) => acc + x }),
      Parser.fold(Parser.alt(a, b), { init: () => "", f: (acc, x) => acc + x, while: (acc) => acc.length < 4 }),
      Parser.separated(Parser.repeat(a, { min: 1 }), b, { min: 2, max: 5 }),
      Parser.separatedFoldl1(Ascii.digit1, Token.literal("+"), (l, _, r) => `(${l}+${r})`),
      Parser.terminated(Ascii.escaped(Token.takeTill('\\"'), "\\", Token.oneOf('\\"n')), Token.literal('"')),
      Parser.terminated(Ascii.takeEscaped(Ascii.alpha1, "\\", Token.oneOf("an")), Token.literal(";")),
      Parser.repeat(Parser.separated(a, b), { min: 1, max: 3 }),
      Parser.alt(Parser.seq(Parser.repeat(a), b), Parser.seq(Parser.repeat(a), Token.literal("c"))),
      Parser.repeat(
        Parser.alt(Parser.alt(Token.literal("ab"), b, Token.literal("c")), Token.literal("+"), Ascii.digit1)
      ),
      Parser.repeat(Parser.permutation(Parser.alt(Token.literal("ab"), b), Parser.alt(a, Token.literal("c")))),
      Expression.make({
        operand: Parser.alt(Ascii.digit1, Token.literal("ab")),
        operators: [
          Expression.prefix(Parser.alt(Token.literal("+"), Token.literal("n")), 3, (_, x) => `-${x}`),
          Expression.postfix(Token.literal(";"), 4, (x) => `${x};`),
          Expression.infixLeft(Parser.alt(a, Token.literal("+")), 1, (l, _, r) => `(${l}+${r})`),
          Expression.infixLeft(Parser.alt(b, Token.literal("c")), 2, (l, _, r) => `(${l}*${r})`)
        ]
      })
    ]
    const random = rng(9)
    const alphabet = 'ab+1\\"n;c'
    grammars.forEach((p) => {
      Array.from({ length: 300 }).forEach((_, i) => {
        const input = Array.from(
          { length: Math.floor(random() * 12) },
          () => alphabet[Math.floor(random() * alphabet.length)]
        ).join("")
        same(p, input, i)
      })
    })
  })

  it("checked many splits", () => {
    expect(checked).toBeGreaterThan(15000)
  })
})

describe("incremental parsing", () => {
  it.each(["interpreted", "closure", "jit"] as const)(
    "does not parse elements again when more input arrives (%s)",
    (backend) => {
      let parsed = 0
      const element = Ascii.decUint.pipe(Parser.tap(() => parsed++))
      const list = Parser.delimited(
        Token.literal("["),
        Parser.separated(element, Token.literal(",")),
        Token.literal("]")
      )
      if (backend !== "interpreted") Compiler[backend](list)
      const doc = `[${Array.from({ length: 2000 }, (_, i) => i).join(",")}]`
      const chunks = split(doc, rng(1), 16)
      expect(Effect.runSync(Stream.fromIterable(chunks).pipe(ParserStream.parseAll(list)))).toHaveLength(2000)
      // Each element is parsed about once, not once per chunk
      expect(chunks.length).toBeGreaterThan(500)
      expect(parsed).toBeLessThan(2000 * 1.5)
      if (backend !== "interpreted") assert.strictEqual(Registry.compiled(list, 0, true)?.backend, backend)
    }
  )

  it.each(["interpreted", "closure", "jit"] as const)(
    "parses an input that arrives in one chunk once (%s)",
    (backend) => {
      let parsed = 0
      const element = Ascii.decUint.pipe(Parser.tap(() => parsed++))
      // The list completes without resuming, then the trailing spaces run out
      // of input: a partial attempt would keep no checkpoint for the list
      const doc = Parser.terminated(
        Parser.delimited(Token.literal("["), Parser.separated(element, Token.literal(",")), Token.literal("]")),
        Ascii.multispace0
      )
      if (backend !== "interpreted") Compiler[backend](doc)
      const input = `[${Array.from({ length: 100 }, (_, i) => i).join(",")}]  `
      expect(Effect.runSync(Stream.make(input).pipe(ParserStream.parseAll(doc)))).toHaveLength(100)
      expect(parsed).toBe(100)
    }
  )

  it.each(["interpreted", "closure", "jit"] as const)("resumes long strings where they stopped (%s)", (backend) => {
    let segments = 0
    const normal = Text.utf8.takeTill('\\"', { min: 1 }).pipe(Parser.tap(() => segments++))
    const string = Parser.delimited(
      Text.utf8.literal('"'),
      Text.utf8.escaped(normal, "\\", Text.utf8.oneOf('\\"')),
      Text.utf8.literal('"')
    )
    if (backend !== "interpreted") Compiler[backend](string)
    const text = Array.from({ length: 500 }, (_, i) => `segment ${i}\\"`).join("")
    const bytes = new TextEncoder().encode(`"${text}"`)
    const chunks = split(bytes, rng(2), 32)
    const value = Effect.runSync(Stream.fromIterable(chunks).pipe(ParserStream.parseAll(string)))
    expect(value).toBe(text.replaceAll('\\"', '"'))
    expect(segments).toBeLessThan(500 * 1.5 + chunks.length)
  })

  it.each(["interpreted", "closure", "jit"] as const)("resumes long raw escaped text (%s)", (backend) => {
    let segments = 0
    const normal = Text.utf8.takeTill('\\"', { min: 1 }).pipe(Parser.tap(() => segments++))
    const string = Parser.delimited(
      Text.utf8.literal('"'),
      Text.utf8.takeEscaped(normal, "\\", Text.utf8.oneOf('\\"')),
      Text.utf8.literal('"')
    )
    if (backend !== "interpreted") Compiler[backend](string)
    const text = Array.from({ length: 500 }, (_, i) => `segment ${i}\\"`).join("")
    const bytes = new TextEncoder().encode(`"${text}"`)
    const chunks = split(bytes, rng(3), 32)
    const value = Effect.runSync(Stream.fromIterable(chunks).pipe(ParserStream.parseAll(string)))
    expect(value).toBe(text)
    expect(segments).toBeLessThan(500 * 1.5 + chunks.length)
  })

  it("parses chunks as they arrive", async () => {
    let parsed = 0
    const element = Text.utf8.decUint.pipe(Parser.tap(() => parsed++))
    const list = Parser.separated(element, Text.utf8.literal(","))
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
    const result = Effect.runPromise(ParserStream.parseReadable(body, list))
    const encode = (s: string) => new TextEncoder().encode(s)
    controller.enqueue(encode("1,2,3,"))
    controller.enqueue(encode("4,5,6,7"))
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The elements received so far were parsed before the stream ended
    expect(parsed).toBeGreaterThanOrEqual(6)
    controller.enqueue(encode("8,9"))
    controller.close()
    expect(await result).toEqual([1, 2, 3, 4, 5, 6, 78, 9])
  })
})

describe("parseReadable and parseResponse", () => {
  const json = jsonGrammar(Text.utf8)
  const doc = { a: [1, 2.5, "é😀"], b: { c: null, d: true } }

  it("parses a fetch Response body", async () => {
    const response = new Response(JSON.stringify(doc))
    expect(await Effect.runPromise(ParserStream.parseResponse(response, json))).toEqual(doc)
    expect(await Effect.runPromise(ParserStream.parseResponse(json)(new Response("[1]")))).toEqual([1])
  })

  it("parses a response without a body as empty input", async () => {
    const exit = await Effect.runPromise(Effect.result(ParserStream.parseResponse(new Response(null), json)))
    expect(Result.isFailure(exit) && exit.failure._tag).toBe("ParseError")
    expect(await Effect.runPromise(ParserStream.parseResponse(new Response(null), Text.utf8.rest))).toBe("")
  })

  it("reports the same errors as Parser.parse", async () => {
    const text = '{"a": [1,, 2]}'
    const exit = await Effect.runPromise(Effect.result(ParserStream.parseResponse(new Response(text), json)))
    const direct = Parser.parse(json, new TextEncoder().encode(text))
    expect(outcome(exit)).toEqual(outcome(direct))
  })

  it("fails with a ReadError when the stream fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      // How `fetch` reports a dropped connection
      pull: (c) => c.error(new TypeError("connection reset"))
    })
    const exit = await Effect.runPromise(Effect.result(ParserStream.parseReadable(body, json)))
    expect(Result.isFailure(exit) && exit.failure._tag).toBe("ReadError")
  })
})
