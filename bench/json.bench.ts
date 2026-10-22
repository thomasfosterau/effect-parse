/**
 * A throughput benchmark: the JSON example parsers, interpreted and
 * compiled, against a hand-fused parser and `JSON.parse`.
 *
 * `json.ts` uses the `Token` and `Ascii` parsers on a string. `json-text.ts`
 * is the same grammar written once against `Text.TextParsers`, run on a
 * string and on UTF-8 and UTF-16 encodings of the same document.
 * `json-fast.ts` is that grammar written for compiled parsers.
 *
 * Each case runs many times, interleaved with the others, and the best
 * time is reported: it is the least noisy estimate on a busy machine.
 *
 * Run with `pnpm build && pnpm bench`.
 */
import { Compiler, Encoding, Parser, Text } from "@thomasfosterau/effect-parse"
import { json } from "../examples/json.ts"
import { makeJson as makeFastJson } from "../examples/json-fast.ts"
import { makeJson } from "../examples/json-text.ts"
import { parseFused } from "./json-fused.ts"

const doc = JSON.stringify(
  Array.from({ length: 2000 }, (_, i) => ({
    id: i,
    name: `item ${i}`,
    label: `élément nº${i} — 項目 😀`,
    tags: ["a", "b", "c"],
    price: i * 1.25,
    active: i % 2 === 0,
    nested: { x: i, y: [1, 2, 3], z: null }
  })),
  null,
  2
)
const utf8 = new TextEncoder().encode(doc)
const utf16 = Encoding.utf16le.encode(doc)
const decoder = new TextDecoder()

const backends = ["interpreted", "closure", "jit"] as const
type Backend = (typeof backends)[number]

/** A separate parser object per backend, since compilation is per parser. */
const variant = <P extends Parser.Parser.Any>(p: P, backend: Backend): P => {
  const copy = Parser.named(p, p.name ?? "json") as P
  return backend === "interpreted" ? copy : (Compiler[backend](copy) as P)
}

interface Case {
  readonly group: string
  readonly name: string
  readonly run: () => unknown
}

const cases: Array<Case> = []
const grammars = [
  ["Token/Ascii, string", json, doc],
  ["Text.string", makeJson(Text.string), doc],
  ["Text.utf8", makeJson(Text.utf8), utf8],
  ["Text.utf16le", makeJson(Text.utf16le), utf16],
  ["json-fast.ts, Text.string", makeFastJson(Text.string), doc],
  ["json-fast.ts, Text.utf8", makeFastJson(Text.utf8), utf8]
] as const
for (const [group, grammar, input] of grammars) {
  for (const backend of backends) {
    const p = variant(grammar as Parser.Parser<unknown, never, never, any>, backend)
    cases.push({ group, name: backend, run: () => Parser.parseSync(p, input) })
  }
}
const jsonString = variant(makeJson(Text.string), "jit")
cases.push({
  group: "references",
  name: "TextDecoder + Text.string (jit)",
  run: () => Parser.parseSync(jsonString, decoder.decode(utf8))
})
cases.push({ group: "references", name: "hand-fused, string", run: () => parseFused(doc) })
cases.push({ group: "references", name: "JSON.parse", run: () => JSON.parse(doc) })

// The compiled parsers must agree with JSON.parse before they are timed
const expected = JSON.stringify(JSON.parse(doc))
for (const c of cases) {
  if (JSON.stringify(c.run()) !== expected) throw new Error(`${c.group} / ${c.name}: wrong result`)
}

const best = new Map<Case, number>(cases.map((c) => [c, Infinity]))
for (let round = 0; round < 40; round++) {
  for (const c of cases) {
    const start = performance.now()
    c.run()
    const ms = performance.now() - start
    if (ms < (best.get(c) ?? Infinity)) best.set(c, ms)
  }
}

console.log(`document: ${(doc.length / 1e6).toFixed(2)} M chars, ${(utf8.length / 1e6).toFixed(2)} MB as UTF-8`)
console.log("best of 40 interleaved runs\n")
let group = ""
let interpreted = 0
for (const c of cases) {
  if (c.group !== group) {
    group = c.group
    console.log(group)
  }
  const ms = best.get(c) ?? Infinity
  if (c.name === "interpreted") interpreted = ms
  const speedup = c.group !== "references" && c.name !== "interpreted" ? `  ${(interpreted / ms).toFixed(1)}x` : ""
  const mchars = doc.length / 1e6 / (ms / 1000)
  console.log(
    `  ${c.name.padEnd(32)} ${ms.toFixed(2).padStart(7)} ms  ${mchars.toFixed(1).padStart(6)} M chars/s${speedup}`
  )
}
