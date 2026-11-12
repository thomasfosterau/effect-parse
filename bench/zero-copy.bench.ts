/**
 * A zero-copy benchmark: `examples/json-tape.ts`, which parses UTF-8 bytes
 * into a tape of records in memory from effect-ext's `Allocator`, against
 * the parsers that build JavaScript values from the same bytes.
 *
 * A tape is not a value, so parsing alone is half a comparison. Each group
 * therefore times a parse together with a use of its result:
 *
 * - nothing (the parse alone);
 * - one number of each record (the tape reads it in place, and steps over
 *   the rest of the record);
 * - one string of each record, as text (the tape decodes just those) and as
 *   bytes (it decodes nothing: an effect-ext `Str` over the input);
 * - everything, as JavaScript values (the tape builds what the others built
 *   while parsing, from its records: the worst case for it).
 *
 * The garbage each parse leaves is reported as the collections 200 parses
 * cause. A last section times appending the document's records through
 * effect-ext's containers, whose `push` is an `Effect` per element: why the
 * tape writes to its `Allocator` block through typed arrays instead.
 *
 * Run with `vp run bench:zero-copy`.
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Allocator from "@thomasfosterau/effect-ext/Allocator"
import * as Layout from "@thomasfosterau/effect-ext/Layout"
import * as Str from "@thomasfosterau/effect-ext/Str"
import * as StructOfArrays from "@thomasfosterau/effect-ext/StructOfArrays"
import * as Vec from "@thomasfosterau/effect-ext/Vec"
import { Compiler, Parser, Text } from "@thomasfosterau/effect-parse"
import type { Json } from "../examples/json.ts"
import { jsonGrammar } from "../examples/json-fast.ts"
import * as JsonTape from "../examples/json-tape.ts"
import { bestOf, records } from "./shared.ts"

/** A record of the document: a JSON object, with the members the uses below read. */
interface Item {
  readonly [key: string]: Json
  readonly id: number
  readonly name: string
  readonly label: string
  readonly price: number
}

const doc = JSON.stringify(records(2000), null, 2)
const utf8 = new TextEncoder().encode(doc)
const decoder = new TextDecoder()

// ---- the parsers --------------------------------------------------------------

const heap = Effect.runSync(JsonTape.makeParser())
// One arena holds the tape for every parse: the parser allocates once, here
const arena = Allocator.makeArenaUnsafe(4 << 20)
const inArena = Effect.runSync(JsonTape.makeParser(1 << 16).pipe(Allocator.withAllocator(arena)))

const tape = (parser: JsonTape.TapeParser) => (): JsonTape.Document =>
  Result.getOrThrowWith(parser.parseResult(utf8), (error) => new Error(error.message))
const jit = Compiler.jit(Parser.named(jsonGrammar(Text.utf8), "jit"))
const wasm = Compiler.wasm(Parser.named(jsonGrammar(Text.utf8), "wasm"))
// SAFETY: the document is the array of items stringified above
const values: ReadonlyArray<readonly [string, () => ReadonlyArray<Item>]> = [
  ["json-fast.ts, Text.utf8, jit", () => Parser.parseSync(jit, utf8) as ReadonlyArray<Item>],
  ["json-fast.ts, Text.utf8, wasm", () => Parser.parseSync(wasm, utf8) as ReadonlyArray<Item>],
  ["TextDecoder + JSON.parse", () => JSON.parse(decoder.decode(utf8))]
]
const tapes: ReadonlyArray<readonly [string, () => JsonTape.Document]> = [
  ["json-tape.ts, heap", tape(heap)],
  ["json-tape.ts, arena", tape(inArena)]
]

// ---- the uses -----------------------------------------------------------------

const price = Str.fromString("price")
const name = Str.fromString("name")
const label = Str.fromString("label")

/** Each element of the document's array, on the tape. */
const forEachItem = (d: JsonTape.Document, f: (item: number) => void): void => {
  const end = JsonTape.next(d, JsonTape.root(d))
  for (let item = JsonTape.root(d) + 1; item < end; item = JsonTape.next(d, item)) f(item)
}

const tapeUses = {
  "": (_: JsonTape.Document) => 0,
  "sum of price": (d: JsonTape.Document) => {
    let sum = 0
    forEachItem(d, (item) => {
      sum += JsonTape.number(d, JsonTape.find(d, item, price))
    })
    return sum
  },
  "names, as strings": (d: JsonTape.Document) => {
    let length = 0
    forEachItem(d, (item) => {
      length += JsonTape.text(d, JsonTape.find(d, item, name)).length
    })
    return length
  },
  "labels, as bytes": (d: JsonTape.Document) => {
    let length = 0
    forEachItem(d, (item) => {
      length += Str.len(JsonTape.str(d, JsonTape.find(d, item, label)))
    })
    return length
  },
  "everything, as values": (d: JsonTape.Document) => JSON.stringify(JsonTape.toJson(d, JsonTape.root(d))).length
} as const

const encoder = new TextEncoder()
const valueUses = {
  "": (_: ReadonlyArray<Item>) => 0,
  "sum of price": (v: ReadonlyArray<Item>) => {
    let sum = 0
    for (const item of v) sum += item.price
    return sum
  },
  "names, as strings": (v: ReadonlyArray<Item>) => {
    let length = 0
    for (const item of v) length += item.name.length
    return length
  },
  // The parsed strings, as the UTF-8 a byte-oriented consumer needs
  "labels, as bytes": (v: ReadonlyArray<Item>) => {
    let length = 0
    for (const item of v) length += encoder.encode(item.label).length
    return length
  },
  "everything, as values": (v: ReadonlyArray<Item>) => JSON.stringify(v).length
} as const

type Use = keyof typeof tapeUses
// SAFETY: the keys of the object literal above, in order
const uses = Object.keys(tapeUses) as Array<Use>

interface Case {
  readonly use: Use
  readonly name: string
  readonly run: () => number
}
const cases: Array<Case> = []
for (const use of uses) {
  for (const [n, parse] of tapes) cases.push({ use, name: n, run: () => tapeUses[use](parse()) })
  for (const [n, parse] of values) cases.push({ use, name: n, run: () => valueUses[use](parse()) })
}

// Every parser must give every use the same answer before it is timed
for (const use of uses) {
  const answers = new Set(cases.filter((c) => c.use === use).map((c) => c.run()))
  if (answers.size !== 1) throw new Error(`"${use}": the parsers disagree (${Array.from(answers).join(", ")})`)
}

// ---- timing -------------------------------------------------------------------

const ROUNDS = 60
const best = bestOf(cases, ROUNDS)

/**
 * The collections `runs` runs of a case cause, and the time they take. The
 * runtime reports collections after the turn they happen in, so this waits
 * for a turn before it counts.
 */
const collections = async (run: () => number, runs: number): Promise<readonly [count: number, ms: number]> => {
  const entries: Array<PerformanceEntry> = []
  const observer = new PerformanceObserver((list) => {
    entries.push(...list.getEntries())
  })
  observer.observe({ entryTypes: ["gc"] })
  for (let i = 0; i < runs; i++) run()
  await new Promise((resolve) => setTimeout(resolve, 20))
  observer.disconnect()
  return [entries.length, entries.reduce((ms, entry) => ms + entry.duration, 0)]
}

const count = tape(heap)().tape.length
console.log(`document: ${(utf8.length / 1e6).toFixed(2)} MB of UTF-8, ${count} values`)
console.log(
  `tape: ${count} records of ${JsonTape.Node.size} bytes, ${((count * JsonTape.Node.size) / 1e6).toFixed(2)} MB`
)
console.log(`best of ${ROUNDS} interleaved runs\n`)
for (const use of uses) {
  console.log(use === "" ? "parse" : `parse + ${use}`)
  const group = cases.filter((c) => c.use === use)
  const last = group.at(-1)
  const reference = last === undefined ? Infinity : (best.get(last) ?? Infinity)
  for (const c of group) {
    const ms = best.get(c) ?? Infinity
    const mb = utf8.length / 1e6 / (ms / 1000)
    const gc = use === "" ? await collections(c.run, 200) : undefined
    console.log(
      `  ${c.name.padEnd(30)} ${ms.toFixed(2).padStart(6)} ms ${mb.toFixed(0).padStart(5)} MB/s  ${(reference / ms).toFixed(2)}x JSON.parse` +
        (gc === undefined
          ? ""
          : `  ${String(gc[0]).padStart(4)} collections, ${gc[1].toFixed(0).padStart(4)} ms, in 200 parses`)
    )
  }
}

// ---- why not Vec / StructOfArrays ---------------------------------------------

const fields = { kind: Layout.u32, next: Layout.u32, start: Layout.u32, end: Layout.u32 }
const appends: ReadonlyArray<readonly [string, () => number]> = [
  [
    "Tape.push (typed arrays over a block)",
    () => {
      const t = heap.tape
      t.clear()
      for (let i = 0; i < count; i++) t.push(JsonTape.Kind.String, i, i + 1)
      return t.length
    }
  ],
  [
    "Vec.push of a struct, an Effect each",
    () => {
      const vec = Effect.runSync(Vec.make(JsonTape.Node))
      for (let i = 0; i < count; i++) Effect.runSync(Vec.push(vec, { kind: 4, next: i + 1, start: i, end: i + 1 }))
      return Vec.length(vec)
    }
  ],
  [
    "StructOfArrays.push, an Effect each",
    () => {
      const soa = Effect.runSync(StructOfArrays.make(fields))
      for (let i = 0; i < count; i++) {
        Effect.runSync(StructOfArrays.push(soa, { kind: 4, next: i + 1, start: i, end: i + 1 }))
      }
      return StructOfArrays.length(soa)
    }
  ],
  [
    "StructOfArrays.extend, one Effect",
    () => {
      const soa = Effect.runSync(StructOfArrays.make(fields))
      const rows = Array.from({ length: count }, (_, i) => ({ kind: 4, next: i + 1, start: i, end: i + 1 }))
      Effect.runSync(StructOfArrays.extend(soa, rows))
      return StructOfArrays.length(soa)
    }
  ]
]
console.log(`\nappending ${count} records (best of 10)`)
for (const [n, run] of appends) {
  let ms = Infinity
  for (let round = 0; round < 10; round++) {
    const start = performance.now()
    run()
    ms = Math.min(ms, performance.now() - start)
  }
  console.log(`  ${n.padEnd(38)} ${ms.toFixed(2).padStart(7)} ms`)
}
