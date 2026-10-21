/**
 * The compiled JSON parser against the native `JSON.parse`, on documents of
 * different shapes and sizes.
 *
 * Each document is parsed from a string, and from its UTF-8 bytes: natively
 * with `TextDecoder` then `JSON.parse` (what `Response.json()` does), and
 * with `Text.utf8`, which parses the bytes without decoding them first.
 * `json-fast.ts` is the same grammar written for compiled parsers (objects
 * built with `Parser.fromEntries`). Every case runs many times, interleaved
 * with the others, and the best time is reported.
 *
 * Run with `pnpm build && pnpm bench:native`.
 */
import { Compiler, Parser, Text } from "@thomasfosterau/effect-parse"
import { json } from "../examples/json.ts"
import { makeJson as makeFastJson } from "../examples/json-fast.ts"
import { makeJson } from "../examples/json-text.ts"

/** A deterministic PRNG (mulberry32), so every run parses the same documents. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const random = rng(2026)
const word = () => ["alpha", "beta", "gamma", "delta", "epsilon"][Math.floor(random() * 5)]!

const records = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `item ${i}`,
    label: `élément nº${i} — 項目 😀`,
    tags: ["a", "b", "c"],
    price: i * 1.25,
    active: i % 2 === 0,
    nested: { x: i, y: [1, 2, 3], z: null }
  }))

interface Doc {
  readonly name: string
  readonly text: string
  /** How many times one timed run parses the document (small documents are parsed in batches). */
  readonly batch: number
}

const docs: Array<Doc> = [
  { name: "records, 1 KB", text: JSON.stringify(records(5)), batch: 500 },
  { name: "records, 600 KB (pretty)", text: JSON.stringify(records(2000), null, 2), batch: 1 },
  { name: "records, 4 MB", text: JSON.stringify(records(25000)), batch: 1 },
  {
    name: "numbers, 1 MB",
    text: JSON.stringify(Array.from({ length: 60000 }, () => (random() - 0.5) * 10 ** Math.floor(random() * 12))),
    batch: 1
  },
  {
    name: "ASCII strings, 1 MB",
    text: JSON.stringify(Array.from({ length: 20000 }, () => Array.from({ length: 8 }, word).join(" "))),
    batch: 1
  },
  {
    name: "escaped strings, 1 MB",
    text: JSON.stringify(Array.from({ length: 15000 }, (_, i) => `line ${i}\n\t"quoted" \\ back\u0001 é 😀 ${word()}`)),
    batch: 1
  },
  {
    name: "deep nesting, 100 KB",
    text: JSON.stringify(Array.from({ length: 200 }, () => {
      let v: unknown = 1
      for (let d = 0; d < 100; d++) v = d % 2 === 0 ? [v, d] : { k: v }
      return v
    })),
    batch: 1
  }
]

const decoder = new TextDecoder()
const tokenAscii = Compiler.jit(json)
const textString = Compiler.jit(makeJson(Text.string))
const textUtf8 = Compiler.jit(makeJson(Text.utf8))
const fastString = Compiler.jit(makeFastJson(Text.string))
const fastUtf8 = Compiler.jit(makeFastJson(Text.utf8))

interface Case {
  readonly name: string
  readonly run: () => unknown
}

const casesFor = (doc: Doc): Array<Case> => {
  const bytes = new TextEncoder().encode(doc.text)
  const text = doc.text
  return [
    { name: "JSON.parse(string)", run: () => JSON.parse(text) },
    { name: "Token/Ascii, string", run: () => Parser.parseSync(tokenAscii, text) },
    { name: "Text.string, string", run: () => Parser.parseSync(textString, text) },
    { name: "JSON.parse(TextDecoder(bytes))", run: () => JSON.parse(decoder.decode(bytes)) },
    { name: "Text.utf8, bytes", run: () => Parser.parseSync(textUtf8, bytes) },
    { name: "json-fast, Text.string, string", run: () => Parser.parseSync(fastString, text) },
    { name: "json-fast, Text.utf8, bytes", run: () => Parser.parseSync(fastUtf8, bytes) }
  ]
}

const time = (doc: Doc, run: () => unknown): number => {
  const start = performance.now()
  for (let i = 0; i < doc.batch; i++) run()
  return (performance.now() - start) / doc.batch
}

console.log("Compiled effect-parse JSON parsers vs the native JSON.parse; best of 30 interleaved runs\n")
for (const doc of docs) {
  const cases = casesFor(doc)
  // Check the results before timing them
  const expected = JSON.stringify(JSON.parse(doc.text))
  for (const c of cases) {
    if (JSON.stringify(c.run()) !== expected) throw new Error(`${doc.name} / ${c.name}: wrong result`)
  }
  const best = cases.map(() => Infinity)
  for (let round = 0; round < 30; round++) {
    cases.forEach((c, i) => {
      best[i] = Math.min(best[i]!, time(doc, c.run))
    })
  }
  const mb = new TextEncoder().encode(doc.text).length / 1e6
  console.log(`${doc.name} (${mb >= 0.01 ? `${mb.toFixed(2)} MB` : `${(mb * 1000).toFixed(1)} KB`})`)
  cases.forEach((c, i) => {
    const ms = best[i]!
    // Compare each parser with the native parse of the same input kind
    const native = best[c.name.includes("bytes") ? 3 : 0]!
    const ratio = i === 0 || i === 3 ? "" : `  ${(ms / native).toFixed(1)}x native`
    const timing = ms < 0.1 ? `${(ms * 1000).toFixed(1).padStart(7)} µs` : `${ms.toFixed(2).padStart(7)} ms`
    console.log(`  ${c.name.padEnd(32)} ${timing}  ${(mb / (ms / 1000)).toFixed(0).padStart(5)} MB/s${ratio}`)
  })
  console.log()
}
