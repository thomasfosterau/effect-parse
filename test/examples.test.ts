import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { describe, expect, it } from "vite-plus/test"
import * as Allocator from "@thomasfosterau/effect-ext/Allocator"
import * as Arithmetic from "../examples/arithmetic.js"
import * as Http from "../examples/http.js"
import * as Ini from "../examples/ini.js"
import * as Jq from "../examples/jq.js"
import * as Json from "../examples/json.js"
import * as JsonFast from "../examples/json-fast.js"
import * as JsonTape from "../examples/json-tape.js"
import { jsonGrammar } from "../examples/json-text.js"
import * as Sexpr from "../examples/sexpr.js"
import { Compiler, Encoding, type ParseError, Parser, ParserStream, Text } from "../src/index.js"
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
      e: 'esc"aped é 😀 \n'
    })
  })

  it("agrees with JSON.parse", () => {
    const docs = ["[]", "{}", "[1,[2,[3]]]", '""', "0", '{"k":{"k":[{}]}}', " [ 1 , 2 ] "]
    docs.forEach((doc) => expectSuccess(Json.json, doc, JSON.parse(doc)))
  })

  it("reports precise errors", () => {
    const err = expectFailure(Json.json, "[1,,2]")
    expect(err.offset).toBe(3)
    expect(err.message).toBe(
      [
        "Parse error at line 1, column 4:",
        "1 | [1,,2]",
        "  |    ^",
        "while parsing array",
        'expected value, found ","'
      ].join("\n")
    )
  })

  it("commits to strings with cut", () => {
    const err = expectFailure(Json.json, '{"a": "unterminated}')
    expect(err.mode).toBe("Cut")
    expect(err.context).toEqual(["string", "object"])
  })

  it("rejects bad escapes", () => {
    const err = expectFailure(Json.json, '"\\x"')
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
    const json = jsonGrammar<any>(T)
    expectSuccess(json, encode(doc), expected)
    const err = expectFailure(json, encode('{"é": [1,,2]}'))
    expect(err.position).toEqual({ line: 1, column: 10 })
    expect(err.message).toContain('expected value, found ","')
  })
})

describe("examples/json-fast", () => {
  it("agrees with JSON.parse, compiled or not", () => {
    const docs = [
      '{"a": [1, -2.5e3, true, null], "b": {"c": "x\\n\\u00e9\\ud83d\\ude00"}}',
      '{"__proto__": {"toString": 1}, "a": 1, "a": 2}',
      "[]",
      "{}",
      " [ {} , [ ] ] "
    ]
    const compiled = Compiler.jit(Parser.named(JsonFast.json, "json-fast"))
    docs.forEach((doc) => {
      expectSuccess(JsonFast.json, doc, JSON.parse(doc))
      expectSuccess(compiled, doc, JSON.parse(doc))
    })
  })

  it("requires a low surrogate after a high one", () => {
    expectSuccess(JsonFast.json, '"\\udc00"', "\udc00")
    const err = expectFailure(JsonFast.json, '"\\ud83d\\u0041"')
    expect(err.mode).toBe("Cut")
  })
})

describe("examples/jq", () => {
  const doc = '{"a":[1,2,{"b":"x"}],"c":null,"d":"hi","n":3} {"a":[],"n":-1}'
  // Each filter with what jq 1.7 prints for `doc` with `-c`, one line per output
  const cases: ReadonlyArray<readonly [string, string]> = [
    [".", '{"a":[1,2,{"b":"x"}],"c":null,"d":"hi","n":3}|{"a":[],"n":-1}'],
    [".a[2].b", '"x"|null'],
    [".a[]?", '1|2|{"b":"x"}'],
    [".[]?", '[1,2,{"b":"x"}]|null|"hi"|3|[]|-1'],
    [".a[1:]", '[2,{"b":"x"}]|[]'],
    [".a[:1]", "[1]|[]"],
    ["[.a[] | numbers] | add", "3|null"],
    ["to_entries | map(.key)", '["a","c","d","n"]|["a","n"]'],
    ['{n, d: .d, (.d // "z"): 1}', '{"n":3,"d":"hi","hi":1}|{"n":-1,"d":null,"z":1}'],
    ['if .n > 0 then "pos" elif .n == 0 then "zero" else "neg" end', '"pos"|"neg"'],
    ['try error("x") catch .', '"x"|"x"'],
    ["select(.n > 0) | .d", '"hi"'],
    ["[.[] | type]", '["array","null","string","number"]|["array","number"]'],
    ["[3,1,2] | sort_by(-.)", "[3,2,1]|[3,2,1]"],
    ["[.. | numbers]", "[1,2,3]|[-1]"],
    ["[limit(2; .a[])]", "[1,2]|[]"],
    ['"x" * 0', '""|""'],
    [".end", "null|null"],
    ["{total: .a | length}", '{"total":3}|{"total":0}'],
    [".a[0] == 1 and .n > 1 or false", "true|false"]
  ]

  it("agrees with jq, with every backend", () => {
    const backends = ["interpreted", "closure", "jit", "wasm"] as const
    backends.forEach((backend) =>
      cases.forEach(([filter, expected]) => {
        const { output, errors } = Jq.run(Jq.compile(filter), doc, { compact: true, backend })
        expect(errors, `${filter} (${backend})`).toEqual([])
        expect(output.trimEnd().split("\n").join("|"), `${filter} (${backend})`).toBe(expected)
      })
    )
  })

  it("reads UTF-8 bytes", () => {
    const { output } = Jq.run(Jq.compile(".[]"), new TextEncoder().encode('["é", 1]'), { compact: true })
    expect(output).toBe('"é"\n1\n')
  })

  it("pretty-prints, raw strings and slurps", () => {
    expect(Jq.run(Jq.compile("."), '{"a":[1]}').output).toBe('{\n  "a": [\n    1\n  ]\n}\n')
    expect(Jq.run(Jq.compile(".a"), '{"a":"x\\ny"}', { raw: true }).output).toBe("x\ny\n")
    expect(Jq.run(Jq.compile("add"), "1 2 3", { slurp: true }).output).toBe("6\n")
    expect(Jq.run(Jq.compile("[1, 2]"), "", { nullInput: true, compact: true }).output).toBe("[1,2]\n")
  })

  it("reports runtime errors per input, keeping earlier outputs", () => {
    const { output, errors } = Jq.run(Jq.compile(".a, (.a | ascii_upcase)"), '{"a":1} {"a":"x"}', { compact: true })
    expect(output).toBe('1\n"x"\n"X"\n')
    expect(errors).toEqual(["jq: error: number (1) cannot be uppercased"])
  })

  it("rejects malformed programs and input", () => {
    expect(() => Jq.compile(".a |")).toThrow("found end of input")
    expect(() => Jq.run(Jq.compile("."), '{"a": }')).toThrow("expected value")
    expect(() => Jq.compile("nope")).toThrow("nope/0 is not defined")
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
    expect(result).toEqual(
      new Map([
        [
          "owner",
          new Map([
            ["name", "John Doe"],
            ["organization", "Acme Widgets Inc."]
          ])
        ],
        [
          "database",
          new Map([
            ["server", "192.0.2.62"],
            ["port", "143"],
            ["file", "payroll.dat"]
          ])
        ]
      ])
    )
  })

  it("errors inside key-value pairs", () => {
    const err = expectFailure(Ini.ini, "[a]\nkey value\n")
    expect(err.context).toEqual(["key-value pair"])
    expect(err.expected).toContain('"="')
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

  const expected: Parser.Parser.Success<typeof Http.request> = [
    { method: "GET", uri: "/pub/WWW/TheProject.html", version: "1.1" },
    [
      { name: "Host", value: ["www.w3.org"] },
      { name: "Accept", value: ["text/html"] }
    ]
  ]

  it("parses a request", () => {
    expectSuccess(Http.request, encode(raw), expected)
  })

  it("reports incomplete input in partial mode", () => {
    const r = Parser.parsePartial(Http.request, encode(raw.slice(0, 30)))
    expect(Result.isSuccess(r) && r.success._tag).toBe("Incomplete")
  })

  it("parses a stream of requests split at arbitrary points", () => {
    const bytes = encode(raw + raw + raw)
    const chunks = Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.subarray(i * 7, i * 7 + 7))
    const program = Stream.fromIterable(chunks).pipe(ParserStream.parseMany(Http.request), Stream.runCollect)
    expect(Effect.runSync(program)).toEqual([expected, expected, expected])
  })
})

describe("examples/sexpr", () => {
  const run = (input: string) => Parser.parse(Sexpr.program, input)

  it("evaluates (winnow s_expression tests)", () => {
    expect(run("((if (= (+ 3 (/ 9 3)) (* 2 3)) * /) 456 123)")).toEqual(Result.succeed({ _tag: "Num", value: 56088 }))
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
    expect(err.expected).toContain('")"')
    expect(Option.isNone(Option.fromNullishOr(err.cause))).toBe(true)
  })
})

describe("examples/json-tape", () => {
  const encode = (text: string) => new TextEncoder().encode(text)
  const docs = [
    "[]",
    "{}",
    "[1,[2,[3]]]",
    '""',
    "0",
    "null",
    " true ",
    '{"k":{"k":[{}]}}',
    " [ 1 , 2 ] ",
    '{"a": 42, "b": ["x", "y", 12], "c": {"hello": "wörld 😀"}, "d": [true, false, null, -1.5e2]}',
    '{"e": "esc\\"aped \\u00e9 \\ud83d\\ude00 \\n", "\\u006bey": "", "plain": "tail\\\\"}',
    JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i, name: `nº${i}`, tags: ["a", i], n: null })))
  ]
  /** Where a parse failed, or -1. */
  const failedAt = <A, E>(result: Result.Result<A, ParseError.ParseError<E>>): number =>
    Result.match(result, { onFailure: (error) => error.offset, onSuccess: () => -1 })
  /** The index of the value of a member, or -1. */
  const member = (doc: JsonTape.Document, index: number, key: string): number =>
    Option.getOrElse(JsonTape.get(doc, index, key), () => -1)
  const parsed = (parser: JsonTape.TapeParser, text: string) =>
    Result.map(parser.parseResult(encode(text)), (doc) => JsonTape.toJson(doc, JsonTape.root(doc)))

  it("agrees with JSON.parse", () => {
    const parser = Effect.runSync(JsonTape.makeParser())
    docs.forEach((doc) => expect(parsed(parser, doc)).toEqual(Result.succeed(JSON.parse(doc))))
  })

  it("writes the same tape interpreted and compiled", () => {
    const tapes = [(p: Parser.Parser.Any) => p, Compiler.closure, Compiler.jit, Compiler.wasm].map((compile) => {
      const tape = Effect.runSync(JsonTape.makeTape(4))
      // SAFETY: each compiler returns the parser it is given
      const parser = compile(JsonTape.jsonTape(tape)) as ReturnType<typeof JsonTape.jsonTape>
      return docs.map((doc) => {
        expect(Result.isSuccess(Parser.parse(parser, encode(doc)))).toBe(true)
        return Array.from(tape.words.subarray(0, tape.length * 4))
      })
    })
    tapes.slice(1).forEach((tape) => expect(tape).toEqual(tapes[0]))
  })

  it("rejects what the JSON grammar rejects, where it does", () => {
    const parser = Effect.runSync(JsonTape.makeParser())
    const grammar = JsonFast.jsonGrammar(Text.utf8)
    const bad = ["", "[1,]", '{"a" 1}', '"\\x"', '"\\ud83d"', "[1 2]", '{"a":1}}', '"\u0001"', "nul", "[1"]
    bad.forEach((doc) => {
      const expected = Parser.parse(grammar, encode(doc))
      const actual = parser.parseResult(encode(doc))
      expect(Result.isFailure(expected)).toBe(true)
      expect(failedAt(actual)).toBe(failedAt(expected))
    })
    // A failed parse leaves a parser that parses
    expect(parsed(parser, "[1]")).toEqual(Result.succeed([1]))
  })

  it("reads strings as views of the input", () => {
    const parser = Effect.runSync(JsonTape.makeParser())
    const input = encode('{"name": "Zoë", "note": "a\\tb", "n": 1.5}')
    const doc = Effect.runSync(parser.parse(input))
    const name = member(doc, JsonTape.root(doc), "name")
    expect(JsonTape.kind(doc, name)).toBe(JsonTape.Kind.String)
    expect(String(JsonTape.str(doc, name))).toBe("Zoë")
    // Zero-copy: the bytes are the input's own
    expect(JsonTape.bytes(doc, name).buffer).toBe(input.buffer)
    expect(JsonTape.bytes(doc, name).byteOffset).toBe(input.indexOf(0x5a))
    // An escaped string is decoded on demand
    const note = member(doc, JsonTape.root(doc), "note")
    expect(JsonTape.kind(doc, note)).toBe(JsonTape.Kind.EscapedString)
    expect(String(JsonTape.str(doc, note))).toBe("a\tb")
    expect(JsonTape.number(doc, member(doc, JsonTape.root(doc), "n"))).toBe(1.5)
    expect(JsonTape.get(doc, JsonTape.root(doc), "missing")).toEqual(Option.none())
    expect(JsonTape.get(doc, name, "name")).toEqual(Option.none())
  })

  it("finds members with escaped keys, and steps over subtrees", () => {
    const parser = Effect.runSync(JsonTape.makeParser())
    const doc = Effect.runSync(parser.parse(encode('{"a": {"b": [1, {"b": 2}]}, "\\u0062": 3, "b": 4}')))
    const b = member(doc, JsonTape.root(doc), "b")
    expect(JsonTape.number(doc, b)).toBe(3)
    expect(JsonTape.children(doc, JsonTape.root(doc)).map((key) => JsonTape.text(doc, key))).toEqual(["a", "b", "b"])
  })

  it("exposes a record as a struct over the tape's memory", () => {
    const parser = Effect.runSync(JsonTape.makeParser())
    const doc = Effect.runSync(parser.parse(encode('[ "ab", [] ]')))
    const array = JsonTape.node(doc, 0)
    expect([array.kind, array.next, array.start, array.end]).toEqual([JsonTape.Kind.Array, 3, 0, 12])
    const string = JsonTape.node(doc, 1)
    expect([string.kind, string.next, string.start, string.end]).toEqual([JsonTape.Kind.String, 2, 3, 5])
  })

  it("takes its memory from the current allocator", () => {
    const arena = Allocator.makeArenaUnsafe(64 * 16)
    const parser = Effect.runSync(JsonTape.makeParser(4).pipe(Allocator.withAllocator(arena)))
    expect(arena.used).toBe(4 * 16)
    // Growing the latest block of an arena extends it in place
    expect(parsed(parser, "[1,2,3,4,5,6,7,8,9]")).toEqual(Result.succeed([1, 2, 3, 4, 5, 6, 7, 8, 9]))
    expect(parser.tape.block.buffer).toBe(arena.buffer)
    expect(arena.used).toBe(16 * 16)
    // A document the arena can't hold fails with the allocator's error
    const tooBig = parser.parseResult(encode(JSON.stringify(Array.from({ length: 100 }, (_, i) => i))))
    expect(Result.isFailure(tooBig) && tooBig.failure.message).toContain("arena exhausted")
    // ... and the parser still parses what fits
    expect(parsed(parser, '["ok"]')).toEqual(Result.succeed(["ok"]))
    Effect.runSync(JsonTape.freeTape(parser.tape))
    expect(arena.used).toBe(0)
  })
})
