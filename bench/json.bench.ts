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
import * as Predicate from "effect/Predicate"
import { Compiler, Encoding, Parser, Text } from "@thomasfosterau/effect-parse"
import { json } from "../examples/json.ts"
import { jsonGrammar as fastJsonGrammar } from "../examples/json-fast.ts"
import { jsonGrammar } from "../examples/json-text.ts"
import { parseFused } from "./json-fused.ts"
import { bestOf, records } from "./shared.ts"

const doc = JSON.stringify(records(2000), null, 2)
const utf8 = new TextEncoder().encode(doc)
const utf16 = Encoding.utf16le.encode(doc)
const decoder = new TextDecoder()

const backends = ["interpreted", "closure", "jit", "wasm"] as const
type Backend = (typeof backends)[number]

/** A separate parser object per backend, since compilation is per parser. */
const variant = <P extends Parser.Parser.Any>(p: P, backend: Backend): P => {
  // SAFETY: `named` returns a copy of `p` with the same step and description, so the same parser type
  const copy = Parser.named(p, p.name ?? "json") as P
  // SAFETY: `Compiler.jit` and `Compiler.closure` return the parser they are given
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
  ["Text.string", jsonGrammar(Text.string), doc],
  ["Text.utf8", jsonGrammar(Text.utf8), utf8],
  ["Text.utf16le", jsonGrammar(Text.utf16le), utf16],
  ["json-fast.ts, Text.string", fastJsonGrammar(Text.string), doc],
  ["json-fast.ts, Text.utf8", fastJsonGrammar(Text.utf8), utf8]
] as const
/**
 * Two copies of an input, parsed in turn: a parser can't reuse anything of
 * the previous run's input (the WebAssembly compiler keeps the latest string
 * it copied into its memory, which the same string parsed again would reuse).
 */
const twin = (input: string | Uint8Array): string | Uint8Array =>
  Predicate.isString(input) ? JSON.parse(JSON.stringify(input)) : input.slice()
let turn = 0

for (const [group, grammar, input] of grammars) {
  for (const backend of backends) {
    // SAFETY: the grammars differ only in their input type, and each runs on its own input
    const p = variant(grammar as Parser.Parser<unknown, never, never, any>, backend)
    const inputs = [input, twin(input)]
    cases.push({ group, name: backend, run: () => Parser.parseSync(p, inputs[turn++ & 1]) })
  }
}
const jsonString = variant(jsonGrammar(Text.string), "jit")
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

const best = bestOf(cases, 40)

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
