import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { describe, expect, it } from "vite-plus/test"
import { Ascii, Compiler, Input, Parser, Token } from "../src/index.js"
import { eagerPermutation } from "./eager.js"
import { allStrings } from "./generators.js"
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

    describe("failAt", () => {
      const tag = (open: string) =>
        Parser.delimited(Token.literal(open), Token.takeWhile("abc", { min: 1 }), Token.literal(">"))
      const element = Parser.seq(tag("<"), Parser.location, tag("</")).pipe(
        Parser.flatMap(([start, at, end]) =>
          start === end ? Parser.succeed(start) : Parser.failAt(at, { start, end })
        )
      )

      it("reports a check's failure where it chooses (#73)", () => {
        expectSuccess(element, "<a></a>", "a")
        const err = expectFailure(element, "<ab></a>")
        expect(err.offset).toBe(4)
        expect(err.cause).toEqual({ start: "ab", end: "a" })
        expect(err.position).toEqual({ line: 1, column: 5 })
      })

      it("wins over alternatives that fail earlier", () => {
        const err = expectFailure(Parser.alt(element, Token.literal("<a>!")), "<a></b>")
        expect(err.offset).toBe(3)
      })

      it("backtracks, and is clamped to the input", () => {
        expectSuccess(Parser.alt(Parser.failAt(1, "e"), a), "a", "a")
        expect(expectFailure(Parser.failAt(99, "e"), "ab").offset).toBe(2)
        expect(expectFailure(Parser.failAt(-1, "e"), "ab").offset).toBe(0)
      })
    })

    it("reject backtracks", () => {
      expect(peek(Parser.alt(Parser.reject, a), "a")).toEqual(Result.succeed(["", "a"]))
    })

    it("seqWith passes one argument per parser (#64)", () => {
      const p = Parser.seqWith(
        [a, Parser.opt(b), Token.literal("c")],
        (x, y, z) => `${x}${Option.getOrElse(y, () => "-")}${z}`
      )
      expectSuccess(p, "abc", "abc")
      expectSuccess(p, "ac", "a-c")
      expectFailure(p, "ab")
      expectSuccess(
        Parser.seqWith([], () => 0),
        "",
        0
      )
      const four = Parser.seqWith([a, a, a, a], (...xs) => xs.length)
      expectSuccess(four, "aaaa", 4)
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
      expectSuccess(
        Parser.map(a, (s) => s.length),
        "a",
        1
      )
      expectSuccess(a.pipe(Parser.as(true)), "a", true)
      expectSuccess(Parser.asVoid(a), "a", undefined)
    })

    it("flatMap", () => {
      const p = Token.oneOf("123").pipe(Parser.flatMap((n) => Token.take(Number(n))))
      expectSuccess(p, "3abc", "abc")
      expectFailure(p, "3ab")
    })

    it("tryMap backtracks with cause", () => {
      const p = Token.take(2).pipe(Parser.tryMap((s) => (s === "ok" ? Result.succeed(1) : Result.fail(`bad: ${s}`))))
      expectSuccess(p, "ok", 1)
      const err = expectFailure(p, "no")
      expect(err.cause).toBe("bad: no")
      expect(err.offset).toBe(0)
      expect(err.message).toContain("bad: no")
    })

    it("mapOrFail rejects with the Fail sentinel (#66)", () => {
      const pair = Token.take(2)
      const p = pair.pipe(
        Parser.mapOrFail(
          (s) => (s === "ok" ? 1 : Input.Fail),
          (s) => `bad: ${s}`
        )
      )
      expectSuccess(p, "ok", 1)
      // `Fail` is not part of the output type
      const typed: Parser.Parser<number, string> = p
      const err = expectFailure(typed, "no")
      expect(err.cause).toBe("bad: no")
      expect(err.offset).toBe(0)
      expect(err.kind).toBe("Verify")
      // Without an error, like filterMap
      const q = Parser.mapOrFail(pair, (s) => (s === "ok" ? s.length : Input.Fail))
      expectSuccess(q, "ok", 2)
      const plain = expectFailure(q, "no")
      expect(plain.cause).toBeUndefined()
      expect(plain.kind).toBe("Verify")
      // It backtracks
      expectSuccess(Parser.alt(q, Parser.as(pair, 0)), "no", 0)
    })

    it("filter / filterMap / filterOrFail", () => {
      const digit = Token.oneOf("0123456789")
      const even = digit.pipe(Parser.filter((d) => Number(d) % 2 === 0))
      expectSuccess(even, "4", "4")
      expectFailure(even, "3")
      const small = digit.pipe(Parser.filterMap((d) => (Number(d) < 5 ? Option.some(Number(d)) : Option.none())))
      expectSuccess(small, "4", 4)
      expectFailure(small, "7")
      const typed = digit.pipe(
        Parser.filterOrFail(
          (d) => d !== "0",
          () => "zero" as const
        )
      )
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

    it("mapSpan passes the output and its offsets (#64)", () => {
      const p = Parser.preceded(
        a,
        Parser.mapSpan(Parser.repeat(b), (bs, start, end) => `${bs.length}@${start}-${end}`)
      )
      expectSuccess(p, "abb", "2@1-3")
      expectSuccess(
        Parser.mapSpan(Parser.empty, (_, start, end) => [start, end]),
        "",
        [0, 0]
      )
      expectFailure(
        Parser.mapSpan(a, () => 1),
        "b"
      )
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
      const p = Parser.gen(function* () {
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
      const p = Parser.gen(function* () {
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
      expect(err.expected).toEqual(['"true"', '"false"', '"null"'])
      expect(err.message).toContain('expected "true", "false" or "null", found "n"')
    })

    it("alt keeps the furthest failure", () => {
      const p = Parser.alt(Parser.seq(a, b, a), Parser.seq(b, b))
      const err = expectFailure(p, "abb")
      expect(err.offset).toBe(2)
      expect(err.expected).toEqual(['"a"'])
    })

    it("alt reports the failure that merging every tie as it happens would", () => {
      // `alt` leaves ties unmerged until they are read (#38). `eagerAlt` is
      // the algorithm it replaced, merging every failure as it happens: both
      // must report the same failure, furthest failure and hint.
      type Alt = (...parsers: Array<Parser.Parser<unknown, unknown>>) => Parser.Parser<unknown, unknown>
      const eagerAlt = <A>(...ps: Array<Parser.Parser<A, unknown>>): Parser.Parser<A, unknown> =>
        Parser.make((state) => {
          const start = state.pos
          const attempt = (i: number, failure: Input.Failure | undefined): A | Input.Fail => {
            if (i === ps.length) return state.failWith("Backtrack", failure ?? state.failure)
            const r = ps[i].step(state)
            if (r !== Input.Fail) {
              if (failure !== undefined && failure.offset === state.pos) state.setHint(failure.offset, failure.expected)
              return r
            }
            if (state.mode !== "Backtrack") return Input.Fail
            const merged = failure === undefined ? state.failure : Input.mergeFailures(failure, state.failure)
            state.rewind(start)
            return attempt(i + 1, merged)
          }
          return attempt(0, undefined)
        })
      const grammar = (alt: Alt) => {
        const c = Token.literal("c")
        const leaves: ReadonlyArray<Parser.Parser<unknown, unknown>> = [
          a,
          ab,
          Parser.context(b, "b"),
          Parser.preceded(c, Parser.failMessage("boom")),
          Parser.preceded(b, Parser.fail({ code: 1 })),
          Parser.preceded(a, Parser.cut(b)),
          Parser.seq(b, a),
          Parser.opt(a)
        ]
        return leaves.flatMap((x, i) =>
          leaves.map((y, j) => {
            const z = leaves[(i + j + 1) % leaves.length]
            return Parser.seq(
              // A swallowed failure further in than the reported one, reported instead of it
              Parser.opt(Parser.seq(Token.literal("x"), alt(x, alt(y, c), z))),
              Parser.context(alt(alt(x, y, c), alt(z, c, b), alt(b, alt(y, a), c, ab), z), "outer"),
              Parser.opt(alt(alt(x, b), c))
            )
          })
        )
      }
      const lazy = grammar(Parser.alt)
      const eager = grammar(eagerAlt)
      // Every input of up to 3 characters
      const alphabet = ["a", "b", "c", "x"]
      const extend = (strings: ReadonlyArray<string>) => strings.flatMap((s) => alphabet.map((ch) => s + ch))
      const one = extend([""])
      const two = extend(one)
      const inputs = ["", ...one, ...two, ...extend(two)]
      lazy.forEach((p, i) =>
        inputs.forEach((input) =>
          expect(Parser.parse(p, input), `grammar ${i} on "${input}"`).toEqual(Parser.parse(eager[i], input))
        )
      )
      // Well under a second on an idle machine; vitest's 5 s default is too tight under load
    }, 30_000)

    it("State keeps an alt's tied failures unmerged until they are read", () => {
      const p = Parser.alt(Parser.alt(a, b, Token.literal("c")), Token.literal("d"))
      const state = new Input.State("x")
      expect(p.step(state)).toBe(Input.Fail)
      expect(state.failureTie1).toBeDefined()
      expect(state.deepest?.expected).toEqual(['"a"', '"b"', '"c"', '"d"'])
      expect(state.failureTie1).toBeUndefined()
      expect(state.deepest).toBe(state.failure)
      expect(state.reportedFailure().expected).toEqual(['"a"', '"b"', '"c"', '"d"'])
      state.reset()
      expect(state.failure.expected).toEqual([])
      expect(state.deepest).toBeUndefined()
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
      const q = Parser.dispatch(Token.any, (c) => (c === "x" ? Parser.succeed("x!") : undefined))
      expectSuccess(q, "x", "x!")
      expectFailure(q, "y")
    })

    it("permutation", () => {
      const p = Parser.permutation(a, b, Token.literal("c"))
      expectSuccess(p, "cab", ["a", "b", "c"])
      expectSuccess(p, "abc", ["a", "b", "c"])
      expectFailure(p, "aac")
    })

    it("permutation reports the failure that merging every tie as it happens would", () => {
      // `permutation` leaves a round's ties unmerged until they are read (#44),
      // as `alt` does (#38); `eagerPermutation` is the algorithm it replaced.
      type Permutation = (...parsers: Array<Parser.Parser<unknown, unknown>>) => Parser.Parser<unknown, unknown>
      const c = Token.literal("c")
      const leaves: ReadonlyArray<Parser.Parser<unknown, unknown>> = [
        a,
        ab,
        Parser.context(b, "b"),
        Parser.alt(Parser.alt(a, b), c),
        Parser.preceded(c, Parser.failMessage("boom")),
        Parser.preceded(b, Parser.fail({ code: 1 })),
        Parser.preceded(a, Parser.cut(b)),
        Parser.opt(c)
      ]
      const grammar = (permutation: Permutation) =>
        leaves.flatMap((x, i) =>
          leaves.map((y, j) => {
            const z = leaves[(i + j + 1) % leaves.length]
            return Parser.seq(
              // A swallowed failure further in than the reported one, reported instead of it
              Parser.opt(Parser.seq(Token.literal("x"), permutation(x, y))),
              Parser.context(permutation(x, Parser.alt(y, c), z), "outer"),
              Parser.opt(permutation(z, b))
            )
          })
        )
      const lazy = grammar(Parser.permutation)
      const eager = grammar(eagerPermutation)
      const inputs = allStrings(["a", "b", "c", "x"], 4)
      lazy.forEach((p, i) =>
        inputs.forEach((input) =>
          expect(Parser.parse(p, input), `grammar ${i} on "${input}"`).toEqual(Parser.parse(eager[i], input))
        )
      )
    }, 60_000)
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
        init: (): Array<string> => [],

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
      expect(err.expected).toEqual(['"ef"', '"ab"'])
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
      expectSuccess(
        Parser.separatedFoldl1(num, minus, (l, _, r) => l - r),
        "9-3-2",
        4
      )
      expectSuccess(
        Parser.separatedFoldr1(num, Token.literal("^"), (l, _, r) => l ** r),
        "2^3^2",
        512
      )
      expectSuccess(
        Parser.separatedFoldr1(num, minus, (l, _, r) => l - r),
        "9",
        9
      )
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
      expect(expectFailure(q, "ac").expected).toEqual(['"b"'])
    })

    it("hints merge expectations of optional parsers", () => {
      const digit = Token.oneOf("0123456789").pipe(Parser.expected("digit"))
      const p = Parser.delimited(Token.literal("("), Parser.repeat(digit), Token.literal(")"))
      const err = expectFailure(p, "(12x")
      expect(err.expected).toEqual(["digit", '")"'])
      const trailing = expectFailure(Parser.repeat(digit), "12x")
      expect(trailing.expected).toEqual(["digit", "end of input"])
    })

    describe("quiet", () => {
      const digit = Token.oneOf("0123456789").pipe(Parser.expected("digit"))
      const comment = Parser.preceded(
        Token.literal("(:"),
        Parser.cut(Parser.terminated(Token.takeTill(":"), Token.literal(":)")))
      )
      const skip = Parser.repeat(Parser.alt(Token.takeWhile(" ", { min: 1 }), comment))

      it("a skipper's hints do not reach later errors", () => {
        const q = Parser.preceded(Parser.quiet(skip), digit)
        expect(expectFailure(q, " (: c :) x").expected).toEqual(["digit"])
        expect(expectFailure(Parser.preceded(skip, digit), " (: c :) x").expected).toEqual(['" "', '"(:"', "digit"])
      })

      it("hints recorded before it are kept", () => {
        const p = Parser.seq(Parser.repeat(digit), Parser.quiet(Parser.opt(Token.literal("!"))), Token.literal(";"))
        expect(expectFailure(p, "1x").expected).toEqual(["digit", '";"'])
      })

      it("a failure without consuming expects nothing", () => {
        const p = Parser.alt(Parser.quiet(Token.literal("a")), digit)
        expect(expectFailure(p, "x").expected).toEqual(["digit"])
        expect(expectFailure(Parser.quiet(Token.literal("a")), "x").expected).toEqual([])
      })

      it("a failure after consuming input is kept", () => {
        const err = expectFailure(Parser.preceded(Parser.quiet(skip), digit), " (: unterminated")
        expect(err.expected).toEqual(['":)"'])
      })

      it("forgets the furthest failure of a run that succeeded", () => {
        // `opt(seq(a, b))` fails after `a`: without `quiet` that failure is reported as the furthest
        const ab = Parser.opt(Parser.seq(Token.literal("a"), Token.literal("b")))
        const p = Parser.alt(Parser.seq(Token.literal("x"), ab, Token.literal("!")), Token.literal("xa?"))
        expect(expectFailure(p, "xa;").offset).toBe(2)
        const q = Parser.alt(Parser.seq(Token.literal("x"), Parser.quiet(ab), Token.literal("!")), Token.literal("xa?"))
        expect(expectFailure(q, "xa;").offset).toBe(1)
      })

      it("keeps values and positions", () => {
        expectSuccess(Parser.seq(Parser.quiet(Token.literal("a")), digit), "a1", ["a", "1"])
      })
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
      expect(err.message).toBe(
        ["Parse error at line 3, column 2:", "3 | xy", "  |  ^", 'expected "\\n" or end of input, found "y"'].join("\n")
      )
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
      const exit = Effect.runSyncExit(Effect.flip(Parser.parseEffect(Token.literal("x"), "y")))
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
      expect(events).toEqual(["Enter:alt:", "Enter:a:", "Exit:a:Backtrack", "Enter:b:", "Exit:b:Ok", "Exit:alt:Ok"])
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

describe("combinator", () => {
  // The doc comment's example, with its loop written as recursion
  const count = <A, B>(item: Parser.Parser<A>, sep: Parser.Parser<B>) =>
    Parser.combinator([item, sep], ([itemStep, sepStep]) => {
      const more = (state: Input.State<string>, n: number): number | Input.Fail => {
        const start = state.pos
        if (sepStep(state) === Input.Fail || itemStep(state) === Input.Fail) {
          if (state.mode !== "Backtrack") return Input.Fail
          state.rewind(start)
          return n
        }
        return more(state, n + 1)
      }
      return (state) => (itemStep(state) === Input.Fail ? Input.Fail : more(state, 1))
    })

  it("runs interpreted and compiled", () => {
    const p = Parser.terminated(count(Ascii.digit1, Token.literal(",")), Parser.eof)
    ;[p, Compiler.closure(Parser.named(p, "closure")), Compiler.jit(Parser.named(p, "jit"))].forEach((v) => {
      expectSuccess(v, "1,22,333", 3)
      expectSuccess(v, "7", 1)
      expect(expectFailure(v, "").offset).toBe(0)
      expect(expectFailure(v, "1,22,").offset).toBe(5)
    })
  })
})
