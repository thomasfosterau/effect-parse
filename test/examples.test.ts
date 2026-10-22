import { Effect, Option, Result, Stream } from "effect"
import { describe, expect, it } from "vite-plus/test"
import * as Arithmetic from "../examples/arithmetic.js"
import * as Http from "../examples/http.js"
import * as Ini from "../examples/ini.js"
import * as Json from "../examples/json.js"
import * as JsonFast from "../examples/json-fast.js"
import { makeJson } from "../examples/json-text.js"
import * as Sexpr from "../examples/sexpr.js"
import { Compiler, Encoding, Parser, ParserStream, Text } from "../src/index.js"
import { expectFailure, expectSuccess } from "./utils.js"

describe("examples/json", () => {
  it("parses documents", () => {
    const input = `{
      "a": 42,
      "b": ["x", "y", 12],
      "c": { "hello": "world" },
      "d": [true, false, null, -1.5e2],
      "e": "esc\\"aped \\u00e9 \\ud83d\\ude00 \\n"
    }`
    expectSuccess(Json.json, input, {
      a: 42,
      b: ["x", "y", 12],
      c: { hello: "world" },
      d: [true, false, null, -150],
      e: "esc\"aped é 😀 \n"
    })
  })

  it("agrees with JSON.parse", () => {
    const docs = ["[]", "{}", "[1,[2,[3]]]", "\"\"", "0", "{\"k\":{\"k\":[{}]}}", " [ 1 , 2 ] "]
    for (const doc of docs) expectSuccess(Json.json, doc, JSON.parse(doc))
  })

  it("reports precise errors", () => {
    const err = expectFailure(Json.json, "[1,,2]")
    expect(err.offset).toBe(3)
    expect(err.message).toBe([
      "Parse error at line 1, column 4:",
      "1 | [1,,2]",
      "  |    ^",
      "while parsing array",
      "expected value, found \",\""
    ].join("\n"))
  })

  it("commits to strings with cut", () => {
    const err = expectFailure(Json.json, "{\"a\": \"unterminated}")
    expect(err.mode).toBe("Cut")
    expect(err.context).toEqual(["string", "object"])
  })

  it("rejects bad escapes", () => {
    const err = expectFailure(Json.json, "\"\\x\"")
    expect(err.expected).toEqual(["escape sequence"])
  })
})

describe("examples/json-text", () => {
  const doc = `{"name": "Zoë 😀", "tags": ["α", "\\u00e9"], "n": -1.5e2, "ok": [true, null]}`
  const expected = JSON.parse(doc)

  it.each([
    ["string", Text.string, (s: string) => s],
    ["utf8", Text.utf8, (s: string) => new TextEncoder().encode(s)],
    ["utf16le", Text.utf16le, Encoding.utf16le.encode],
    ["utf16be", Text.utf16be, Encoding.utf16be.encode]
  ] as const)("parses %s input with one grammar", (_, T, encode) => {
    const json = makeJson<any>(T)
    expectSuccess(json, encode(doc), expected)
    const err = expectFailure(json, encode("{\"é\": [1,,2]}"))
    expect(err.position).toEqual({ line: 1, column: 10 })
    expect(err.message).toContain("expected value, found \",\"")
  })
})

describe("examples/json-fast", () => {
  it("agrees with JSON.parse, compiled or not", () => {
    const docs = [
      "{\"a\": [1, -2.5e3, true, null], \"b\": {\"c\": \"x\\n\\u00e9\\ud83d\\ude00\"}}",
      "{\"__proto__\": {\"toString\": 1}, \"a\": 1, \"a\": 2}",
      "[]", "{}", " [ {} , [ ] ] "
    ]
    const compiled = Compiler.jit(Parser.named(JsonFast.json, "json-fast"))
    for (const doc of docs) {
      expectSuccess(JsonFast.json, doc, JSON.parse(doc))
      expectSuccess(compiled, doc, JSON.parse(doc))
    }
  })

  it("requires a low surrogate after a high one", () => {
    expectSuccess(JsonFast.json, "\"\\udc00\"", "\udc00")
    const err = expectFailure(JsonFast.json, "\"\\ud83d\\u0041\"")
    expect(err.mode).toBe("Cut")
  })
})

describe("examples/arithmetic", () => {
  it("evaluates (winnow test_parser.rs)", () => {
    expectSuccess(Arithmetic.evaluate, "3", 3)
    expectSuccess(Arithmetic.evaluate, " 12", 12)
    expectSuccess(Arithmetic.evaluate, "537 ", 537)
    expectSuccess(Arithmetic.evaluate, " 24 / 2 ", 12)
    expectSuccess(Arithmetic.evaluate, " 2* 3  *2 *2 / 3", 8)
    expectSuccess(Arithmetic.evaluate, " 1 +  2 ", 3)
    expectSuccess(Arithmetic.evaluate, "12 + 6 - 4+  3", 17)
    expectSuccess(Arithmetic.evaluate, "1 + 2*3 + 4", 11)
    expectSuccess(Arithmetic.evaluate, " (  2 )", 2)
    expectSuccess(Arithmetic.evaluate, " 2* (  3 + 4 ) ", 14)
    expectSuccess(Arithmetic.evaluate, "  2*2 / ( 5 - 1) + 3", 4)
  })

  it("builds an AST (winnow test_parser_ast.rs)", () => {
    const show = (input: string) => Arithmetic.show(Parser.parseSync(Arithmetic.ast, input))
    expect(show(" 1 + 2 ")).toBe("+ 1 2")
    expect(show("12 + 6 - 4+  3")).toBe("+ - + 12 6 4 3")
    expect(show("1 + 2*3 + 4")).toBe("+ + 1 * 2 3 4")
    expect(show(" 2* (  3 + 4 ) ")).toBe("* 2 (+ 3 4)")
    expect(show("  2*2 / ( 5 - 1) + 3")).toBe("+ / * 2 2 (- 5 1) 3")
    expect(show("-1 + 2")).toBe("+ -1 2")
  })

  it("lexes and parses tokens (winnow test_parser_lexer.rs)", () => {
    const lexed = Parser.parseSync(Arithmetic.lex, " 2* (  3 + 4 ) ")
    expect(lexed).toEqual([
      { kind: "Value", value: 2 },
      { kind: "Oper", op: "*" },
      { kind: "OpenParen" },
      { kind: "Value", value: 3 },
      { kind: "Oper", op: "+" },
      { kind: "Value", value: 4 },
      { kind: "CloseParen" }
    ])
    expect(Parser.parseSync(Arithmetic.tokens, lexed)).toBe(14)
    const evaluate = (s: string) => Parser.parseSync(Arithmetic.tokens, Parser.parseSync(Arithmetic.lex, s))
    expect(evaluate("  2*2 / ( 5 - 1) + 3")).toBe(4)
  })

  it("reports token-level errors", () => {
    const lexed = Parser.parseSync(Arithmetic.lex, "(1 + 2")
    const err = expectFailure(Arithmetic.tokens, lexed)
    expect(err.offset).toBe(4)
    expect(err.expected).toContain("CloseParen")
  })
})

describe("examples/ini", () => {
  it("parses sections (winnow ini tests)", () => {
    const input = `; comment
[owner]
name = John Doe
organization = Acme Widgets Inc. ; trailing comment

[database]
server = 192.0.2.62
port = 143
file = payroll.dat
`
    const result = Parser.parseSync(Ini.ini, input)
    expect(result).toEqual(new Map([
      ["owner", new Map([["name", "John Doe"], ["organization", "Acme Widgets Inc."]])],
      ["database", new Map([["server", "192.0.2.62"], ["port", "143"], ["file", "payroll.dat"]])]
    ]))
  })

  it("errors inside key-value pairs", () => {
    const err = expectFailure(Ini.ini, "[a]\nkey value\n")
    expect(err.context).toEqual(["key-value pair"])
    expect(err.expected).toContain("\"=\"")
  })
})

describe("examples/http", () => {
  const raw = [
    "GET /pub/WWW/TheProject.html HTTP/1.1\r\n",
    "Host: www.w3.org\r\n",
    "Accept: text/html\r\n",
    "\r\n"
  ].join("")
  const encode = (s: string) => new TextEncoder().encode(s)

  const expected = [
    { method: "GET", uri: "/pub/WWW/TheProject.html", version: "1.1" },
    [{ name: "Host", value: ["www.w3.org"] }, { name: "Accept", value: ["text/html"] }]
  ]

  it("parses a request", () => {
    expectSuccess(Http.request, encode(raw), expected as any)
  })

  it("reports incomplete input in partial mode", () => {
    const r = Parser.parsePartial(Http.request, encode(raw.slice(0, 30)))
    expect(Result.isSuccess(r) && r.success._tag).toBe("Incomplete")
  })

  it("parses a stream of requests split at arbitrary points", () => {
    const bytes = encode(raw + raw + raw)
    const chunks: Array<Uint8Array> = []
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7))
    const program = Stream.fromIterable(chunks).pipe(ParserStream.parseMany(Http.request), Stream.runCollect)
    expect(Effect.runSync(program)).toEqual([expected, expected, expected])
  })
})

describe("examples/sexpr", () => {
  const run = (input: string) => Parser.parse(Sexpr.program, input)

  it("evaluates (winnow s_expression tests)", () => {
    expect(run("((if (= (+ 3 (/ 9 3)) (* 2 3)) * /) 456 123)")).toEqual(
      Result.succeed({ _tag: "Num", value: 56088 })
    )
    expect(run("(+ 1 2 3)")).toEqual(Result.succeed({ _tag: "Num", value: 6 }))
    expect(run("(not #f)")).toEqual(Result.succeed({ _tag: "Bool", value: true }))
    expect(run("(if #f 1 2)")).toEqual(Result.succeed({ _tag: "Num", value: 2 }))
  })

  it("parses quotes and keywords", () => {
    const r = Parser.parse(Sexpr.expr, "'(1 :key #t)")
    expect(Result.isSuccess(r)).toBe(true)
  })

  it("surfaces typed evaluation errors", () => {
    const err = expectFailure(Sexpr.program, "(/ 1 0)")
    expect(err.cause).toBeInstanceOf(Sexpr.EvalError)
    expect(err.message).toContain("division by zero")
  })

  it("reports unbalanced parentheses", () => {
    const err = expectFailure(Sexpr.program, "(+ 1 2")
    expect(err.mode).toBe("Cut")
    expect(err.expected).toContain("\")\"")
    expect(Option.isNone(Option.fromNullishOr(err.cause))).toBe(true)
  })
})
