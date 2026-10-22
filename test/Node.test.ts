import { describe, expect, it } from "vite-plus/test"
import * as Arithmetic from "../examples/arithmetic.js"
import * as Json from "../examples/json.js"
import { jsonGrammar } from "../examples/json-text.js"
import { Ascii, Encoding, Parser, Text, Token } from "../src/index.js"
import type { Node, ParserLike } from "../src/internal/node.js"
import { children, nodeOf } from "../src/internal/node.js"

/** Counts the description nodes reachable from a parser, by tag. */
const tags = (root: ParserLike): Record<string, number> => {
  const seen = new Set<ParserLike>()
  const out: Record<string, number> = {}
  const visit = (p: ParserLike) => {
    if (seen.has(p)) return
    seen.add(p)
    const node = nodeOf(p)
    out[node._tag] = (out[node._tag] ?? 0) + 1
    for (const c of children(node)) visit(c)
  }
  visit(root)
  return out
}

const tagOf = (p: ParserLike): Node["_tag"] => nodeOf(p)._tag

describe("parser descriptions", () => {
  it("describes the JSON grammars completely", () => {
    for (const root of [Json.json, jsonGrammar(Text.string), jsonGrammar(Text.utf8)]) {
      const t = tags(root)
      expect(t.Opaque).toBeUndefined()
      expect(t.Dispatch).toBe(2)
      expect(t.Suspend).toBeGreaterThan(0)
    }
  })

  it("marks undescribable parsers as opaque", () => {
    expect(tagOf(Parser.make(() => 1))).toBe("Opaque")
    expect(
      tagOf(
        Parser.gen(function* () {
          return yield* Token.any
        })
      )
    ).toBe("Opaque")
    expect(tags(Arithmetic.ast).Opaque).toBe(1)
  })

  it("keeps the description through named and pipe", () => {
    const p = Token.literal("a").pipe(Parser.named("a"))
    expect(nodeOf(p)).toEqual({ _tag: "Literal", literal: "a", caseless: false, encoding: undefined })
    expect(tagOf(Ascii.decUint)).toBe("TryMap")
  })

  it("records sequencing outputs", () => {
    const a = Token.literal("a")
    const b = Token.literal("b")
    expect(nodeOf(Parser.preceded(a, b))).toMatchObject({ _tag: "Seq", output: 1 })
    expect(nodeOf(Parser.terminated(a, b))).toMatchObject({ _tag: "Seq", output: 0 })
    expect(nodeOf(Parser.separatedPair(a, b, a))).toMatchObject({ _tag: "Seq", output: [0, 2] })
    expect(nodeOf(Parser.repeat(a, { min: 1 }))).toMatchObject({ _tag: "Repeat", min: 1, max: Infinity })
  })

  it("records the encoding of Text parsers", () => {
    expect(nodeOf(Text.utf8.literal("x"))).toMatchObject({ _tag: "Literal", encoding: Encoding.utf8 })
    expect(nodeOf(Text.utf16le.alpha1)).toMatchObject({ _tag: "TakeWhile", min: 1, encoding: Encoding.utf16le })
    expect(nodeOf(Text.string.taken(Text.string.any))).toMatchObject({ _tag: "Taken", encoding: Encoding.string })
    expect(nodeOf(Ascii.alpha1)).toMatchObject({ _tag: "TakeWhile", min: 1, encoding: undefined })
  })
})
