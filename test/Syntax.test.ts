import { Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Json from "../examples/json-syntax.js"
import type { Input } from "../src/index.js"
import { Ascii, Expression, Parser, Syntax, Text, Token } from "../src/index.js"
import { randomJson, rng } from "./generators.js"

const ws = Ascii.multispace0
const number = Syntax.node(Ascii.decInt, "number")
const name = Syntax.node(Ascii.alpha1, "name")
const list = Syntax.node(
  Parser.delimited(
    Syntax.token(Token.literal("[")),
    Parser.separated(Parser.delimited(ws, number, ws), Syntax.token(Token.literal(","))),
    Syntax.token(Token.literal("]"))
  ),
  "list"
)

/** Everything observable about a tree, for comparisons. */
const snapshot = <I extends Input.Input>(tree: Syntax.Tree<unknown, unknown, I>) => {
  const shape = (n: Syntax.SyntaxNode<I>): unknown => ({
    kind: n.kind,
    named: n.named,
    field: n.field,
    start: n.start,
    end: n.end,
    value: n.value,
    children: n.children.map(shape)
  })
  return {
    value: tree.value,
    errors: tree.errors.map((e) => ({ offset: e.offset, mode: e.mode, message: e.message })),
    root: shape(tree.root)
  }
}

describe("Syntax", () => {
  describe("trees", () => {
    it("builds nodes with spans, values and children", () => {
      const tree = Syntax.parse(list, "[1, 22,3]")
      expect(tree.value).toEqual(Option.some([1, 22, 3]))
      expect(tree.hasErrors).toBe(false)
      const root = tree.root
      expect([root.kind, root.start, root.end]).toEqual(["list", 0, 9])
      expect(root.children.map((c) => [c.kind, c.named, c.text])).toEqual([
        ["[", false, "["],
        ["number", true, "1"],
        [",", false, ","],
        ["number", true, "22"],
        [",", false, ","],
        ["number", true, "3"],
        ["]", false, "]"]
      ])
      expect(root.namedChildren.map((c) => c.value)).toEqual([1, 22, 3])
      expect(String(tree)).toBe("(list (number) (number) (number))")
    })

    it("wraps a grammar that is not a node in a root", () => {
      const tree = Syntax.parse(Parser.preceded(ws, list), "  [1]")
      expect(String(tree)).toBe("(document (list (number)))")
      expect(Syntax.parse(Parser.preceded(ws, list), "[1]", { kind: "file" }).root.kind).toBe("file")
      expect(tree.root.value).toEqual([1])
    })

    it("names fields", () => {
      const pair = Syntax.node(
        Parser.separatedPair(Syntax.field(name, "key"), Token.literal("="), Syntax.field(number, "value")),
        "pair"
      )
      const tree = Syntax.parse(Parser.separated(pair, Token.literal(";")), "a=1;b=2")
      expect(String(tree)).toBe("(document (pair key: (name) value: (number)) (pair key: (name) value: (number)))")
      const second = tree.root.child(1)!
      expect(second.childByField("key")?.text).toBe("b")
      expect(second.childByField("value")?.value).toBe(2)
      expect(second.childByField("other")).toBeUndefined()
      expect(second.childrenByField("key").map((n) => n.text)).toEqual(["b"])
      expect(second.child(0)?.field).toBe("key")
    })

    it("navigates parents and siblings", () => {
      const tree = Syntax.parse(list, "[1,2,3]")
      const two = tree.descendantAt(3)
      expect([two.kind, two.text]).toEqual(["number", "2"])
      expect(two.parent?.kind).toBe("list")
      expect(two.nextSibling?.kind).toBe(",")
      expect(two.nextNamedSibling?.text).toBe("3")
      expect(two.previousNamedSibling?.text).toBe("1")
      expect(two.previousSibling?.text).toBe(",")
      expect(tree.root.child(-1)?.kind).toBe("]")
      expect(tree.root.child(99)).toBeUndefined()
      expect(tree.root.parent).toBeUndefined()
    })

    it("finds the smallest node containing a range", () => {
      const tree = Syntax.parse(list, "[10,20]")
      expect(tree.descendantAt(4).text).toBe("20")
      expect(tree.descendantAt(4, 6).text).toBe("20")
      expect(tree.descendantAt(2, 5).kind).toBe("list")
      expect(tree.descendantAt(3).kind).toBe(",")
      expect(tree.root.namedDescendantAt(3).kind).toBe("list")
      expect(tree.descendantAt(7).kind).toBe("list")
      expect(tree.root.childAt(3)?.kind).toBe(",")
      expect(tree.root.childIndexAt(100)).toBe(-1)
    })

    it("walks with a cursor and iterates descendants", () => {
      const tree = Syntax.parse(list, "[1,2]")
      const cursor = tree.walk()
      expect(cursor.gotoFirstChild()).toBe(true)
      expect(cursor.node.kind).toBe("[")
      expect(cursor.gotoNextSibling()).toBe(true)
      expect(cursor.node.text).toBe("1")
      expect(cursor.gotoFirstChild()).toBe(false)
      expect(cursor.gotoPreviousSibling()).toBe(true)
      expect(cursor.gotoParent()).toBe(true)
      expect(cursor.gotoParent()).toBe(false)
      expect(cursor.gotoLastChild()).toBe(true)
      expect(cursor.node.kind).toBe("]")
      cursor.reset(tree.root)
      cursor.gotoDescendantAt(3)
      expect(cursor.node.text).toBe("2")
      expect([...tree.root.descendants()].map((n) => n.kind)).toEqual(["list", "[", "number", ",", "number", "]"])
      expect([...tree.root.descendantsOfKind("number")].map((n) => n.value)).toEqual([1, 2])
      // A cursor started at a node stays inside it
      const sub = tree.root.child(1)!.walk()
      expect(sub.gotoNextSibling()).toBe(false)
      expect(sub.gotoParent()).toBe(false)
    })

    it("reports line and column positions", () => {
      const tree = Syntax.parse(Parser.preceded(ws, list), "\n\n  [1,\n 😀2]".replace("😀", ""))
      expect(tree.lineColumn(0)).toEqual({ line: 1, column: 1 })
      expect(tree.lineColumn(4)).toEqual({ line: 3, column: 3 })
      expect(tree.lineColumn(9)).toEqual({ line: 4, column: 2 })
      const text = "a\n😀b"
      const t2 = Syntax.parse(Parser.preceded(Token.takeWhile((c: string) => c !== "b"), Syntax.node(Token.literal("b"), "b")), text)
      expect(t2.lineColumn(4)).toEqual({ line: 2, column: 2 })
    })

    it("parses byte and array inputs", () => {
      const bytes = Syntax.node(Text.utf8.literal("é"), "e")
      const tree = Syntax.parse(Parser.repeat(bytes), new TextEncoder().encode("éé"))
      expect(tree.root.children.map((c) => [c.start, c.end])).toEqual([[0, 2], [2, 4]])
      expect(tree.root.child(0)?.text).toEqual(new Uint8Array([0xc3, 0xa9]))
      const tokens = Syntax.node(Token.any as unknown as Parser.Parser<number, never, never, ReadonlyArray<number>>, "t")
      expect(Syntax.parse(Parser.repeat(tokens), [1, 2, 3]).root.namedChildren.map((n) => n.value)).toEqual([1, 2, 3])
    })
  })

  describe("backtracking", () => {
    it("drops the nodes of abandoned alternatives", () => {
      const call = Syntax.node(Parser.seq(name, Token.literal("(")), "call")
      const p = Parser.alt(call, Parser.seq(name, Token.literal("!")))
      expect(String(Syntax.parse(p, "ab!"))).toBe("(document (name))")
      // An alternative that consumed the same input without nodes
      const q = Parser.alt(Parser.seq(name, Token.literal("(")), Parser.seq(Ascii.alpha1, Token.literal("!")))
      expect(String(Syntax.parse(q, "ab!"))).toBe("(document)")
    })

    it("drops the nodes built by lookahead", () => {
      const p = Parser.preceded(Parser.peek(name), Ascii.alpha1)
      expect(String(Syntax.parse(p, "ab"))).toBe("(document)")
      const q = Parser.preceded(Parser.not(number), name)
      expect(String(Syntax.parse(q, "ab"))).toBe("(document (name))")
    })

    it("drops the nodes of a repetition's failed last attempt", () => {
      const item = Syntax.node(Parser.seq(number, Token.literal(";")), "item")
      const p = Parser.terminated(Parser.repeat(item), Parser.seq(Ascii.digit1, Token.literal(".")))
      expect(String(Syntax.parse(p, "1;2;3."))).toBe("(document (item (number)) (item (number)))")
    })

    it("adds no node for an empty match", () => {
      const empty = Syntax.node(Ascii.digit0, "digits")
      expect(String(Syntax.parse(Parser.seq(empty, name), "ab"))).toBe("(document (name))")
    })
  })

  describe("errors", () => {
    it("turns recovered failures into ERROR nodes", () => {
      const tree = Syntax.parse(Json.json, "[1, tru, 3, {\"a\" 1, \"b\": 2}]")
      expect(String(tree)).toBe("(document (array (number) (ERROR) (number) (object (ERROR) (pair key: (string) value: (number)))))")
      expect(tree.value).toEqual(Option.some([1, 3, { b: 2 }]))
      expect(tree.errors.map((e) => e.offset)).toEqual([4, 17])
      const errorNode = tree.root.descendantAt(5)
      expect([errorNode.kind, errorNode.isError, errorNode.text]).toEqual([Syntax.ERROR, true, "tru"])
      expect(errorNode.error?.message).toContain("expected")
      expect(tree.root.hasError).toBe(true)
      expect(tree.root.child(0)?.child(1)?.hasError).toBe(false)
    })

    it("covers the rest of the input after a fatal failure", () => {
      const tree = Syntax.parse(list, "[1,2;3]")
      expect(tree.value).toEqual(Option.none())
      expect(String(tree)).toBe("(list (number) (number) (ERROR))")
      const error = tree.root.child(-1)!
      expect([error.start, error.end]).toEqual([4, 7])
      expect(tree.errors).toHaveLength(1)
      const fresh = Parser.parse(list, "[1,2;3]")
      expect(Result.isFailure(fresh) && fresh.failure.message).toBe(tree.errors[0]!.message)
    })

    it("covers trailing input", () => {
      const tree = Syntax.parse(list, "[1] x")
      expect(String(tree)).toBe("(list (number) (ERROR))")
      expect(tree.errors[0]?.offset).toBe(3)
      expect(tree.value).toEqual(Option.none())
    })
  })

  describe("annotations outside Syntax", () => {
    it("change nothing, interpreted or compiled", () => {
      const docs = ["[1, tru, 3]", "{\"a\": [1, {\"b\": null}], \"c\": \"x\"}", "[1,,2]", "[", " 12 "]
      for (const backend of ["closure", "auto"] as const) {
        const compiled = Parser.compile(Parser.named(Json.json, "json"), { backend })
        for (const doc of docs) {
          const interpreted = Parser.parse(Json.json, doc)
          const fast = Parser.parse(compiled, doc)
          expect(Result.isSuccess(fast)).toBe(Result.isSuccess(interpreted))
          if (Result.isSuccess(fast) && Result.isSuccess(interpreted)) expect(fast.success).toEqual(interpreted.success)
          if (Result.isFailure(fast) && Result.isFailure(interpreted)) {
            expect(fast.failure.message).toBe(interpreted.failure.message)
          }
        }
      }
      expect(Parser.parse(list, "[1,2]")).toEqual(Result.succeed([1, 2]))
    })
  })

  describe("incremental parsing", () => {
    it("reuses the nodes an edit doesn't touch", () => {
      let parsed = 0
      const counted = Syntax.node(Ascii.decInt.pipe(Parser.tap(() => parsed++)), "number")
      const items = Syntax.node(Parser.separated(counted, Token.literal(",")), "items")
      const text = Array.from({ length: 1000 }, (_, i) => String(i)).join(",")
      const tree = Syntax.parse(items, text)
      expect(parsed).toBe(1000)
      parsed = 0
      const at = text.indexOf(",500,") + 1
      const edited = Syntax.replace(tree, at, at + 3, "-5")
      expect(parsed).toBe(1)
      expect(edited.reused).toBe(999)
      expect(Option.getOrThrow(edited.value)[500]).toBe(-5)
      expect(snapshot(edited)).toEqual(snapshot(Syntax.parse(items, edited.input)))
    })

    it("keeps the values of reused nodes", () => {
      const tree = Syntax.parse(Json.json, "[{\"a\": 1}, {\"b\": 2}]")
      const edited = Syntax.reparse(tree, "[{\"a\": 1}, {\"b\": 3}]")
      expect(edited.root.child(0)?.child(1)?.value).toBe(tree.root.child(0)?.child(1)?.value)
      expect(edited.root.child(0)?.child(3)?.value).toEqual({ b: 3 })
    })

    it("re-parses nodes whose lookahead reached the edit", () => {
      // `alpha1` read the "c" after "ab" to know that the name ended
      const names = Parser.separated(name, Token.literal(" "))
      const tree = Syntax.parse(names, "ab cd")
      const joined = Syntax.reparse(tree, "abcd", { start: 2, oldEnd: 3, newEnd: 2 })
      expect(joined.root.children.map((c) => c.text)).toEqual(["abcd"])
      const appended = Syntax.replace(Syntax.parse(names, "ab"), 2, 2, "c")
      expect(appended.root.children.map((c) => c.text)).toEqual(["abc"])
      expect(appended.reused).toBe(0)
    })

    it("re-parses nodes whose tokens read past where they stopped", () => {
      const T = Text.string
      // [grammar, input, edit start, replacement]: each node's parse read the edited unit without consuming it
      const cases: ReadonlyArray<readonly [Parser.Parser<unknown>, string, number, string]> = [
        // A literal that failed part way, before a shorter alternative matched
        [Parser.alt(Token.literal("abcd"), Token.literal("ab")), "abcz", 3, "d"],
        [Parser.alt(T.literal("abcd"), T.literal("ab")), "abcz", 3, "d"],
        [Parser.alt(Ascii.caseless("abcd"), Token.literal("ab")), "abcz", 3, "D"],
        [Parser.alt(T.caseless("abcd"), T.literal("ab")), "abcz", 3, "D"],
        // `takeUntil` reads the delimiter it stops at
        [Token.takeUntil("ab"), "xxab", 3, "c"],
        [T.takeUntil("ab"), "xxab", 3, "c"],
        // `tillLineEnding` reads the line feed after a carriage return
        [Ascii.tillLineEnding, "ab\r\n", 3, "x"],
        [T.tillLineEnding, "ab\r\n", 3, "x"]
      ]
      for (const [p, input, at, text] of cases) {
        const grammar = Parser.seq(Syntax.node(p, "x"), Token.rest)
        const edited = Syntax.replace(Syntax.parse(grammar, input), at, at + 1, text)
        expect(snapshot(edited), `${p.name} on ${JSON.stringify(input)}`).toEqual(snapshot(Syntax.parse(grammar, edited.input)))
        expect(edited.reused).toBe(0)
      }
    })

    it("applies several edits in order", () => {
      const tree = Syntax.parse(list, "[1,2,3]")
      // "[1,2,3]" -> "[1,2,3,4]" -> "[0,1,2,3,4]"
      const edited = Syntax.reparse(tree, "[0,1,2,3,4]", [
        { start: 6, oldEnd: 6, newEnd: 8 },
        { start: 1, oldEnd: 1, newEnd: 3 }
      ])
      expect(edited.value).toEqual(Option.some([0, 1, 2, 3, 4]))
      // "1", ",", "2", "," and "]"; not "[", whose lookahead reached the second edit, nor "3"
      expect(edited.reused).toBe(5)
      expect(snapshot(edited)).toEqual(snapshot(Syntax.parse(list, "[0,1,2,3,4]")))
    })

    it("finds the edit by comparing inputs", () => {
      expect(Syntax.diff("abcdef", "abXYef")).toEqual({ start: 2, oldEnd: 4, newEnd: 4 })
      expect(Syntax.diff("aaa", "aaaa")).toEqual({ start: 3, oldEnd: 3, newEnd: 4 })
      expect(Syntax.diff("abc", "abc")).toBeUndefined()
      expect(Syntax.diff(new Uint8Array([1, 2, 3]), new Uint8Array([1, 3]))).toEqual({ start: 1, oldEnd: 2, newEnd: 1 })
      const tree = Syntax.parse(list, "[1,2]")
      expect(Syntax.reparse(tree, "[1,2]").reused).toBe(5)
    })

    it("rejects edits that don't match the inputs", () => {
      const tree = Syntax.parse(list, "[1,2]")
      expect(() => Syntax.reparse(tree, "[1,2,3]", { start: 4, oldEnd: 4, newEnd: 5 })).toThrow(RangeError)
      expect(() => Syntax.reparse(tree, "[1]", { start: 4, oldEnd: 9, newEnd: 4 })).toThrow(RangeError)
      expect(() => Syntax.replace(tree, 3, 1, "")).toThrow(RangeError)
    })

    it("re-parses ERROR nodes and the errors they hold", () => {
      const tree = Syntax.parse(Json.json, "[1, tru, 3]")
      const fixed = Syntax.replace(tree, 7, 7, "e")
      expect(fixed.hasErrors).toBe(false)
      expect(fixed.value).toEqual(Option.some([1, true, 3]))
      const broken = Syntax.replace(fixed, 1, 2, "x")
      expect(broken.errors.map((e) => e.offset)).toEqual([1])
      expect(snapshot(broken)).toEqual(snapshot(Syntax.parse(Json.json, broken.input)))
    })

    it("respects the lookahead option", () => {
      // "[", "1", ",", "2" and "]"; the "," after "2" was followed by the edit
      expect(Syntax.replace(Syntax.parse(list, "[1,2,3]"), 5, 6, "4").reused).toBe(5)
      // Only "]", after the edit
      expect(Syntax.replace(Syntax.parse(list, "[1,2,3]", { lookahead: 100 }), 5, 6, "4").reused).toBe(1)
    })

    /** Random edits of random documents: every reparse must equal a fresh parse. */
    const differential = <A, E>(
      grammar: Parser.Parser<A, E>,
      docs: ReadonlyArray<string>,
      alphabet: ReadonlyArray<string>,
      seed: number
    ) => {
      const random = rng(seed)
      let reused = 0
      for (const doc of docs) {
        let tree = Syntax.parse(grammar, doc)
        expect(snapshot(tree)).toEqual(snapshot(Syntax.parse(grammar, doc)))
        for (let i = 0; i < 12; i++) {
          const text = tree.input
          const start = Math.floor(random() * (text.length + 1))
          const end = Math.min(text.length, start + Math.floor(random() * 4) * Math.floor(random() * 2))
          const insert = Array.from(
            { length: Math.floor(random() * 3) },
            () => alphabet[Math.floor(random() * alphabet.length)]
          ).join("")
          // Alternate between explicit edits and edits found by comparing the inputs
          const next = i % 2 === 0
            ? Syntax.replace(tree, start, end, insert)
            : Syntax.reparse(tree, text.slice(0, start) + insert + text.slice(end))
          const fresh = Syntax.parse(grammar, next.input)
          expect(snapshot(next), JSON.stringify({ before: text, after: next.input })).toEqual(snapshot(fresh))
          // Parse the old text again from the edited tree, too
          if (i % 3 === 0) expect(snapshot(Syntax.reparse(next, text))).toEqual(snapshot(Syntax.parse(grammar, text)))
          reused += next.reused
          tree = next
        }
      }
      return reused
    }

    it("agrees with fresh parses: JSON", () => {
      const random = rng(7)
      const docs = Array.from({ length: 60 }, () => randomJson(random))
      const reused = differential(Json.json, docs, ["[", "]", "{", "}", ",", ":", "\"", "1", "a", " ", "\n", "t", "-", "e", "."], 11)
      expect(reused).toBeGreaterThan(500)
    })

    it("agrees with fresh parses: lookahead", () => {
      // Keywords need a boundary, comments end at a delimiter, and literals share prefixes
      const sp = Token.takeWhile(" ")
      const keyword = (k: string) => Syntax.token(Parser.terminated(Token.literal(k), Parser.not(Ascii.alphanumeric1)), k)
      const ident = Syntax.node(Parser.preceded(Parser.not(Parser.alt(keyword("let"), keyword("fn"))), Ascii.alpha1), "ident")
      const comment = Syntax.node(
        Parser.alt(
          Parser.delimited(Token.literal("/*"), Token.takeUntil("*/"), Token.literal("*/")),
          Parser.delimited(Token.literal("//"), Ascii.tillLineEnding, Ascii.lineEnding)
        ),
        "comment"
      )
      const value = Syntax.node(Parser.alt(Token.literal("function"), Token.literal("func"), Ascii.digit1), "value")
      const binding = Syntax.node(
        Parser.seq(keyword("let"), sp, ident, sp, Token.literal("="), sp, Parser.alt(value, ident), Token.literal(";")),
        "let"
      )
      const program = Parser.repeat(Parser.terminated(Parser.alt(binding, comment), Token.takeWhile(" \n")))
      const docs = [
        "let a = 1; /* x */ let b = function;",
        "// c\r\nlet fn = func;\nlet letter = b;",
        "let x = funct; /* a */ /* b */",
        "/**/let y = 12;"
      ]
      const alphabet = ["/", "*", "\r", "\n", "f", "u", "n", "c", "t", "i", "o", "l", "e", " ", "=", ";", "1", "x"]
      for (let seed = 0; seed < 25; seed++) differential(program, docs, alphabet, seed)
    })

    it("re-parses little of a large document", () => {
      const records = Array.from({ length: 300 }, (_, i) => ({ id: i, name: `n${i}`, tags: ["a", "b"], ok: i % 2 === 0 }))
      const text = JSON.stringify(records, null, 2)
      const tree = Syntax.parse(Json.json, text)
      const total = [...tree.root.descendants()].length
      const at = text.indexOf("\"n150\"")
      const edited = Syntax.replace(tree, at + 1, at + 5, "renamed")
      expect(Option.getOrThrow(edited.value)).toEqual(records.map((r) => r.id === 150 ? { ...r, name: "renamed" } : r))
      // Every record but the edited one is reused whole, as one node
      expect(edited.reused).toBeGreaterThan(299)
      // The nodes built again: those not shared with the old tree
      const old = new Set([...tree.root.descendants()].map((n) => n.green))
      const fresh = [...edited.root.descendants()].filter((n) => !old.has(n.green)).length
      expect(fresh).toBeLessThan(total / 100)
      expect(snapshot(edited)).toEqual(snapshot(Syntax.parse(Json.json, edited.input)))
    })

    it("agrees with fresh parses: arithmetic", () => {
      const num = Syntax.node(Ascii.decInt, "number")
      const atom: Parser.Parser<number, unknown> = Parser.alt(
        num,
        Syntax.node(Parser.delimited(Token.literal("("), Parser.suspend(() => sum), Token.literal(")")), "group")
      )
      const product = Syntax.node(
        Parser.separatedFoldl1(atom, Syntax.token(Token.oneOf("*/"), "op"), (l, op, r) => op === "*" ? l * r : l / r),
        "product"
      )
      const sum: Parser.Parser<number, unknown> = Syntax.node(
        Parser.separatedFoldl1(product, Syntax.token(Token.oneOf("+-"), "op"), (l, op, r) => op === "+" ? l + r : l - r),
        "sum"
      )
      const docs = ["1+2*3", "(1+2)*(3-4)/5", "((((1))))+2", "10*20*30-40", "1"]
      differential(sum, docs, ["1", "2", "+", "*", "(", ")", "-"], 3)
      // Pratt parsing (Expression.make) around nodes
      const pratt: Parser.Parser<number, unknown> = Expression.make({
        operand: Parser.alt(
          Syntax.node(Parser.delimited(Ascii.space0, Ascii.decInt, Ascii.space0), "number"),
          Syntax.node(Parser.delimited(Token.literal("("), Parser.suspend(() => pratt), Token.literal(")")), "group")
        ),
        operators: [
          Expression.prefix(Token.literal("-"), 3, (_, x) => -x),
          Expression.infixLeft(Token.literal("*"), 2, (l, _, r) => l * r),
          Expression.infixLeft(Token.literal("+"), 1, (l, _, r) => l + r)
        ]
      })
      differential(pratt, ["1 + 2 * 3", "(1)*-(2+3)", " 4 "], ["1", "+", " ", "(", ")", "*", "-"], 5)
    })
  })
})
