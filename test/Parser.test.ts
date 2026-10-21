import { Context, Effect, Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import { Parser, Token } from "../src/index.js"
import { expectFailure, expectSuccess, peek } from "./utils.js"

const a = Token.literal("a")
const b = Token.literal("b")
const ab = Token.literal("ab")

describe("Parser", () => {
  describe("constructors", () => {
    it("succeed / empty", () => {
      expectSuccess(Parser.succeed(1), "", 1)
      expectSuccess(Parser.empty, "", undefined)
    })

    it("fail carries a typed cause", () => {
      const err = expectFailure(Parser.fail({ code: 42 }), "")
      expect(err.cause).toEqual({ code: 42 })
      expect(err.kind).toBe("Fail")
    })

    it("reject backtracks", () => {
      expect(peek(Parser.alt(Parser.reject, a), "a")).toEqual(Result.succeed(["", "a"]))
    })

    it("suspend allows recursion", () => {
      type Nested = ReadonlyArray<Nested>
      const nested: Parser.Parser<Nested> = Parser.delimited(
        Token.literal("["),
        Parser.repeat(Parser.suspend(() => nested)),
        Token.literal("]")
      )
      expectSuccess(nested, "[[][[]]]", [[], [[]]])
    })

    it("location", () => {
      expectSuccess(Parser.preceded(ab, Parser.location), "ab", 2)
    })

    it("todo is unrecoverable", () => {
      const err = expectFailure(Parser.alt(Parser.todo, a), "a")
      expect(err.mode).toBe("Cut")
    })
  })

  describe("mapping", () => {
    it("map / as / asVoid", () => {
      expectSuccess(a.pipe(Parser.map((s) => s.toUpperCase())), "a", "A")
      expectSuccess(Parser.map(a, (s) => s.length), "a", 1)
      expectSuccess(a.pipe(Parser.as(true)), "a", true)
      expectSuccess(Parser.asVoid(a), "a", undefined)
    })

    it("flatMap", () => {
      const p = Token.oneOf("123").pipe(Parser.flatMap((n) => Token.take(Number(n))))
      expectSuccess(p, "3abc", "abc")
      expectFailure(p, "3ab")
    })

    it("tryMap backtracks with cause", () => {
      const p = Token.take(2).pipe(
        Parser.tryMap((s) => s === "ok" ? Result.succeed(1) : Result.fail(`bad: ${s}`))
      )
      expectSuccess(p, "ok", 1)
      const err = expectFailure(p, "no")
      expect(err.cause).toBe("bad: no")
      expect(err.offset).toBe(0)
      expect(err.message).toContain("bad: no")
    })

    it("filter / filterMap / filterOrFail", () => {
      const digit = Token.oneOf("0123456789")
      const even = digit.pipe(Parser.filter((d) => Number(d) % 2 === 0))
      expectSuccess(even, "4", "4")
      expectFailure(even, "3")
      const small = digit.pipe(Parser.filterMap((d) => Number(d) < 5 ? Option.some(Number(d)) : Option.none()))
      expectSuccess(small, "4", 4)
      expectFailure(small, "7")
      const typed = digit.pipe(Parser.filterOrFail((d) => d !== "0", () => "zero" as const))
      expect(expectFailure(typed, "0").cause).toBe("zero")
    })

    it("mapParser", () => {
      const p = Token.take(3).pipe(Parser.mapParser(Parser.allConsuming(Parser.repeat(a))))
      expectSuccess(p, "aaa", ["a", "a", "a"])
      const err = expectFailure(Parser.preceded(b, p), "baab")
      expect(err.offset).toBe(3)
    })
  })

  describe("consumed input", () => {
    it("taken / withTaken / span / withSpan", () => {
      const p = Parser.seq(a, b)
      expectSuccess(Parser.taken(p), "ab", "ab")
      expectSuccess(Parser.withTaken(p), "ab", [["a", "b"], "ab"])
      expectSuccess(Parser.preceded(a, Parser.span(b)), "ab", { start: 1, end: 2 })
      expectSuccess(Parser.withSpan(ab), "ab", ["ab", { start: 0, end: 2 }])
    })
  })

  describe("control", () => {
    it("opt", () => {
      expectSuccess(Parser.opt(a), "a", Option.some("a"))
      expect(peek(Parser.opt(a), "b")).toEqual(Result.succeed(["b", Option.none()]))
      expectSuccess(Parser.optional(a), "", undefined)
    })

    it("opt propagates cut", () => {
      const p = Parser.opt(Parser.preceded(a, Parser.cut(b)))
      expect(expectFailure(p, "ac").mode).toBe("Cut")
      expect(peek(p, "c")).toEqual(Result.succeed(["c", Option.none()]))
    })

    it("cond", () => {
      expectSuccess(Parser.cond(true, a), "a", Option.some("a"))
      expectSuccess(Parser.cond(false, a), "", Option.none())
    })

    it("peek / not", () => {
      expect(peek(Parser.peek(ab), "abc")).toEqual(Result.succeed(["abc", "ab"]))
      expect(peek(Parser.not(a), "b")).toEqual(Result.succeed(["b", undefined]))
      expectFailure(Parser.not(a), "a")
    })

    it("eof / allConsuming", () => {
      expectSuccess(Parser.eof, "", undefined)
      expectFailure(Parser.eof, "x")
      expect(Result.isFailure(Parser.parsePeek(Parser.allConsuming(a), "ab"))).toBe(true)
    })

    it("backtrack undoes cut", () => {
      const p = Parser.alt(Parser.backtrack(Parser.preceded(a, Parser.cut(b))), ab)
      expectSuccess(p, "ab", "b")
      expectSuccess(Parser.alt(Parser.backtrack(Parser.preceded(a, Parser.cut(Token.literal("c")))), ab), "ab", "ab")
    })
  })

  describe("sequencing", () => {
    it("seq / struct", () => {
      expectSuccess(Parser.seq(a, b, a), "aba", ["a", "b", "a"])
      expectSuccess(Parser.struct({ x: a, y: b }), "ab", { x: "a", y: "b" })
    })

    it("preceded / terminated / delimited / separatedPair", () => {
      expectSuccess(Parser.preceded(a, b), "ab", "b")
      expectSuccess(Parser.terminated(a, b), "ab", "a")
      expectSuccess(Parser.delimited(a, b, a), "aba", "b")
      expectSuccess(Parser.separatedPair(a, Token.literal(","), b), "a,b", ["a", "b"])
    })

    it("zip / zipWith / zipLeft / zipRight", () => {
      expectSuccess(a.pipe(Parser.zip(b)), "ab", ["a", "b"])
      expectSuccess(a.pipe(Parser.zipWith(b, (x, y) => y + x)), "ab", "ba")
      expectSuccess(a.pipe(Parser.zipLeft(b)), "ab", "a")
      expectSuccess(a.pipe(Parser.zipRight(b)), "ab", "b")
    })

    it("gen", () => {
      const p = Parser.gen(function*() {
        const x = yield* a
        const y = yield* Parser.opt(b)
        return { x, y }
      })
      expectSuccess(p, "ab", { x: "a", y: Option.some("b") })
      expectSuccess(p, "a", { x: "a", y: Option.none() })
      expectFailure(p, "b")
    })

    it("gen runs finally blocks on failure", () => {
      let cleaned = false
      const p = Parser.gen(function*() {
        try {
          yield* a
          yield* b
        } finally {
          cleaned = true
        }
      })
      expectFailure(p, "aa")
      expect(cleaned).toBe(true)
    })

    it("Do notation", () => {
      const p = Parser.Do.pipe(
        Parser.bind("x", () => a),
        Parser.bind("y", ({ x }) => Token.literal(x === "a" ? "b" : "c")),
        Parser.let("z", ({ x, y }) => x + y)
      )
      expectSuccess(p, "ab", { x: "a", y: "b", z: "ab" })
      expectSuccess(a.pipe(Parser.bindTo("value")), "a", { value: "a" })
    })
  })

  describe("choice", () => {
    it("alt returns first success", () => {
      const p = Parser.alt(ab, a, b)
      expectSuccess(p, "ab", "ab")
      expect(peek(p, "ac")).toEqual(Result.succeed(["c", "a"]))
      expectSuccess(p, "b", "b")
    })

    it("alt merges expectations", () => {
      const p = Parser.alt(Token.literal("true"), Token.literal("false"), Token.literal("null"))
      const err = expectFailure(p, "nope")
      expect(err.expected).toEqual(["\"true\"", "\"false\"", "\"null\""])
      expect(err.message).toContain("expected \"true\", \"false\" or \"null\", found \"n\"")
    })

    it("alt keeps the furthest failure", () => {
      const p = Parser.alt(Parser.seq(a, b, a), Parser.seq(b, b))
      const err = expectFailure(p, "abb")
      expect(err.offset).toBe(2)
      expect(err.expected).toEqual(["\"a\""])
    })

    it("alt stops at cut", () => {
      const p = Parser.alt(Parser.preceded(a, Parser.cut(b)), ab)
      expect(expectFailure(p, "ac").mode).toBe("Cut")
    })

    it("dispatch", () => {
      const p = Parser.dispatch(Token.any, {
        a: Parser.succeed(1),
        b: Token.literal("!").pipe(Parser.as(2))
      })
      expectSuccess(p, "a", 1)
      expectSuccess(p, "b!", 2)
      expect(expectFailure(p, "c").offset).toBe(0)
      const withDefault = Parser.dispatch(Token.any, { a: Parser.succeed(1) }, Parser.succeed(0))
      expectSuccess(withDefault, "z", 0)
      const q = Parser.dispatch(Token.any, (c) => c === "x" ? Parser.succeed("x!") : undefined)
      expectSuccess(q, "x", "x!")
      expectFailure(q, "y")
    })

    it("permutation", () => {
      const p = Parser.permutation(a, b, Token.literal("c"))
      expectSuccess(p, "cab", ["a", "b", "c"])
      expectSuccess(p, "abc", ["a", "b", "c"])
      expectFailure(p, "aac")
    })
  })

  describe("repetition", () => {
    it("repeat", () => {
      expectSuccess(Parser.repeat(ab), "ababab", ["ab", "ab", "ab"])
      expectSuccess(Parser.repeat(ab), "", [])
      expect(peek(Parser.repeat(ab), "abac")).toEqual(Result.succeed(["ac", ["ab"]]))
    })

    it("repeat with ranges (winnow repeat tests)", () => {
      const p = Parser.repeat(ab, { min: 2, max: 4 })
      expectFailure(p, "ab")
      expect(peek(p, "ababc")).toEqual(Result.succeed(["c", ["ab", "ab"]]))
      expect(peek(p, "abababababab")).toEqual(Result.succeed(["abab", ["ab", "ab", "ab", "ab"]]))
      const exact = Parser.repeat(ab, 2)
      expect(peek(exact, "ababab")).toEqual(Result.succeed(["ab", ["ab", "ab"]]))
      expectFailure(exact, "abc")
    })

    it("repeat requires progress", () => {
      const err = expectFailure(Parser.repeat(Parser.opt(a)), "aab")
      expect(err.kind).toBe("Assert")
      expect(err.mode).toBe("Cut")
    })

    it("repeat propagates cut", () => {
      const p = Parser.repeat(Parser.preceded(a, Parser.cut(b)))
      expect(expectFailure(p, "abac").mode).toBe("Cut")
    })

    it("fold", () => {
      const p = Token.oneOf("0123456789").pipe(
        Parser.fold({ init: () => 0, f: (acc, d) => acc * 10 + Number(d), range: { min: 1 } })
      )
      expectSuccess(p, "1234", 1234)
      expectFailure(p, "")
    })

    it("fold with while", () => {
      const digit = Token.oneOf("0123456789")
      const kept = Parser.fold(Parser.alt(digit, Token.literal("-")), {
        init: () => [] as Array<string>,
        f: (acc, x) => {
          if (x !== "-") acc.push(x)
          return acc
        },
        while: (acc) => acc.length < 2
      })
      // Stops after the second kept item, without consuming more
      expect(peek(kept, "1-2-34")).toEqual(Result.succeed(["-34", ["1", "2"]]))
      expect(peek(kept, "--1")).toEqual(Result.succeed(["", ["1"]]))
      // Checked before the first element too
      const none = Parser.fold(digit, { init: () => 0, f: (n) => n + 1, while: () => false })
      expect(peek(none, "12")).toEqual(Result.succeed(["12", 0]))
      // `min` elements are always folded
      const atLeast = Parser.fold(digit, { init: () => 0, f: (n) => n + 1, range: { min: 2 }, while: () => false })
      expect(peek(atLeast, "123")).toEqual(Result.succeed(["3", 2]))
      expectFailure(atLeast, "1")
      // `max` still bounds the repetition
      const capped = Parser.fold(digit, { init: () => 0, f: (n) => n + 1, range: { max: 2 }, while: (n) => n < 5 })
      expect(peek(capped, "1234")).toEqual(Result.succeed(["34", 2]))
    })

    it("repeatTill", () => {
      const p = Parser.repeatTill(ab, Token.literal("ef"))
      expect(peek(p, "ababefg")).toEqual(Result.succeed(["g", [["ab", "ab"], "ef"]]))
      expectSuccess(p, "ef", [[], "ef"])
      const err = expectFailure(p, "abx")
      expect(err.expected).toEqual(["\"ef\"", "\"ab\""])
      expectFailure(Parser.repeatTill(ab, Token.literal("ef"), { min: 1 }), "ef")
      expectFailure(Parser.repeatTill(ab, Token.literal("ef"), { max: 1 }), "ababef")
    })

    it("separated", () => {
      const p = Parser.separated(ab, Token.literal(","))
      expectSuccess(p, "ab,ab,ab", ["ab", "ab", "ab"])
      expectSuccess(p, "", [])
      expect(peek(p, "ab,ab,c")).toEqual(Result.succeed([",c", ["ab", "ab"]]))
      const p1 = Parser.separated(ab, Token.literal(","), { min: 1, max: 2 })
      expectFailure(p1, "")
      expect(peek(p1, "ab,ab,ab")).toEqual(Result.succeed([",ab", ["ab", "ab"]]))
    })

    it("separatedFoldl1 / separatedFoldr1", () => {
      const num = Token.oneOf("0123456789").pipe(Parser.map(Number))
      const minus = Token.literal("-")
      expectSuccess(Parser.separatedFoldl1(num, minus, (l, _, r) => l - r), "9-3-2", 4)
      expectSuccess(Parser.separatedFoldr1(num, Token.literal("^"), (l, _, r) => l ** r), "2^3^2", 512)
      expectSuccess(Parser.separatedFoldr1(num, minus, (l, _, r) => l - r), "9", 9)
    })
  })

  describe("errors", () => {
    it("context labels", () => {
      const p = Parser.preceded(a, b).pipe(Parser.context("pair"), Parser.context("document"))
      const err = expectFailure(p, "ax")
      expect(err.context).toEqual(["pair", "document"])
      expect(err.message).toContain("while parsing document\nwhile parsing pair")
    })

    it("expected replaces expectations when nothing was consumed", () => {
      const p = Parser.alt(a, b).pipe(Parser.expected("letter"))
      expect(expectFailure(p, "c").expected).toEqual(["letter"])
      const q = Parser.seq(a, b).pipe(Parser.expected("pair"))
      expect(expectFailure(q, "ac").expected).toEqual(["\"b\""])
    })

    it("hints merge expectations of optional parsers", () => {
      const digit = Token.oneOf("0123456789").pipe(Parser.expected("digit"))
      const p = Parser.delimited(Token.literal("("), Parser.repeat(digit), Token.literal(")"))
      const err = expectFailure(p, "(12x")
      expect(err.expected).toEqual(["digit", "\")\""])
      const trailing = expectFailure(Parser.repeat(digit), "12x")
      expect(trailing.expected).toEqual(["digit", "end of input"])
    })

    it("mapError / orFail", () => {
      const p = Parser.fail("x").pipe(Parser.mapError((e) => e.length))
      expect(expectFailure(p, "").cause).toBe(1)
      const q = a.pipe(Parser.orFail(() => "custom"))
      expect(expectFailure(q, "b").cause).toBe("custom")
    })

    it("orElse / orElseSucceed", () => {
      expectSuccess(a.pipe(Parser.orElse(() => b)), "b", "b")
      expectSuccess(a.pipe(Parser.orElseSucceed(() => "default")), "", "default")
    })

    it("renders a caret", () => {
      const p = Parser.separated(Token.literal("x"), Token.literal("\n"))
      const err = expectFailure(Parser.allConsuming(p), "x\nx\nxy")
      expect(err.position).toEqual({ line: 3, column: 2 })
      expect(err.message).toBe([
        "Parse error at line 3, column 2:",
        "3 | xy",
        "  |  ^",
        "expected \"\\n\" or end of input, found \"y\""
      ].join("\n"))
    })
  })

  describe("services", () => {
    class Radix extends Context.Service<Radix, number>()("Radix") {}
    const number = Parser.service(Radix).pipe(
      Parser.flatMap((radix) =>
        Token.takeWhile(Token.range("0", "z"), { min: 1 }).pipe(Parser.map((d) => parseInt(d, radix)))
      )
    )

    it("provideService", () => {
      expectSuccess(Parser.provideService(number, Radix, 16), "ff", 255)
    })

    it("context option", () => {
      expect(Parser.parse(number, "11", { context: Context.make(Radix, 2) })).toEqual(Result.succeed(3))
    })

    it("parseEffect takes services from the Effect context", () => {
      const program = Parser.parseEffect(number, "777").pipe(Effect.provideService(Radix, 8))
      expect(Effect.runSync(program)).toBe(511)
    })

    it("ParseError is yieldable", () => {
      const program = Effect.gen(function*() {
        return yield* Parser.parseEffect(Token.literal("x"), "y")
      })
      const exit = Effect.runSyncExit(Effect.flip(program))
      expect(exit._tag).toBe("Success")
    })
  })

  describe("running", () => {
    it("parse requires full consumption", () => {
      const err = expectFailure(a, "ab")
      expect(err.offset).toBe(1)
      expect(err.kind).toBe("Eof")
    })

    it("parseSync throws", () => {
      expect(Parser.parseSync(a, "a")).toBe("a")
      expect(() => Parser.parseSync(a, "b")).toThrow(/expected "a"/)
    })

    it("parsePartial", () => {
      const p = Token.literal("hello")
      expect(Parser.parsePartial(p, "hel")).toEqual(Result.succeed({ _tag: "Incomplete", needed: Option.some(2) }))
      expect(Parser.parsePartial(p, "hello!")).toEqual(Result.succeed({ _tag: "Done", value: "hello", offset: 5 }))
      expect(Result.isFailure(Parser.parsePartial(p, "help"))).toBe(true)
    })

    it("trace", () => {
      const events: Array<string> = []
      const p = Parser.trace(Parser.alt(Parser.trace(a, "a"), Parser.trace(b, "b")), "alt")
      Parser.parse(p, "b", { trace: (e) => events.push(`${e._tag}:${e.name}:${e.result ?? ""}`) })
      expect(events).toEqual([
        "Enter:alt:",
        "Enter:a:",
        "Exit:a:Backtrack",
        "Enter:b:",
        "Exit:b:Ok",
        "Exit:alt:Ok"
      ])
    })
  })

  describe("recovery", () => {
    const stmt = Parser.terminated(Token.takeWhile(Token.range("a", "z"), { min: 1 }), Token.literal(";"))
    const skip = Parser.terminated(Token.takeTill(";"), Token.literal(";"))

    it("resumeAfter collects errors", () => {
      const program = Parser.repeat(Parser.resumeAfter(stmt, skip))
      const result = Parser.parseRecoverable(program, "ab;12;cd;")
      expect(result.value).toEqual(Option.some([Option.some("ab"), Option.none(), Option.some("cd")]))
      expect(result.errors.map((e) => e.offset)).toEqual([3])
    })

    it("resumeAfter is inert outside parseRecoverable", () => {
      const program = Parser.repeat(Parser.resumeAfter(stmt, skip))
      expectFailure(Parser.allConsuming(program), "ab;12;cd;")
    })

    it("retryAfter", () => {
      const word = Token.takeWhile(Token.range("a", "z"), { min: 1 })
      const junk = Token.takeWhile(Token.range("0", "9"), { min: 1 })
      const p = Parser.retryAfter(word, junk)
      const result = Parser.parseRecoverable(p, "12abc")
      expect(result.value).toEqual(Option.some("abc"))
      expect(result.errors).toHaveLength(1)
    })
  })
})
