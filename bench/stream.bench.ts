/**
 * Parsing a JSON response body as it downloads, against waiting for the
 * download and then parsing.
 *
 * The body is a `ReadableStream` that delivers a document in 64 KiB chunks
 * at a simulated bandwidth. Each case reports the time from the start of the
 * download to the parsed value, and how long after the last byte the value
 * was ready.
 *
 * - `Response.json()`: the native path, which waits for the whole body, then
 *   decodes and parses it
 * - `arrayBuffer()` + compiled `Text.utf8`: waits, then parses the bytes
 * - `ParserStream.parseResponse`: parses the bytes as they arrive, with the
 *   compiled and with the interpreted parser
 *
 * Run with `pnpm build && pnpm bench:stream`.
 */
import { Effect } from "effect"
import { Compiler, Parser, ParserStream, Text } from "@thomasfosterau/effect-parse"
import { makeJson } from "../examples/json-text.ts"

const doc = JSON.stringify(
  Array.from({ length: 12000 }, (_, i) => ({
    id: i,
    name: `item ${i}`,
    label: `élément nº${i} — 項目 😀`,
    tags: ["a", "b", "c"],
    price: i * 1.25,
    active: i % 2 === 0,
    nested: { x: i, y: [1, 2, 3], z: null }
  }))
)
const bytes = new TextEncoder().encode(doc)
const chunkSize = 64 * 1024

const interpretedJson = makeJson(Text.utf8)
const compiledJson = Compiler.jit(makeJson(Text.utf8))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A body delivering `bytes` at `mbPerSecond` (all at once if `Infinity`).
 * Like a network connection, it delivers on its own schedule and the stream
 * buffers what the reader has not taken yet.
 */
const body = (mbPerSecond: number) => {
  const start = performance.now()
  let last = 0
  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const end = Math.min(bytes.length, offset + chunkSize)
        if (mbPerSecond !== Infinity) {
          const wait = start + (end / 1e6 / mbPerSecond) * 1000 - performance.now()
          if (wait > 0) await sleep(wait)
        }
        // A copy, as a network stream would deliver
        controller.enqueue(bytes.slice(offset, end))
      }
      last = performance.now()
      controller.close()
    }
  }, { highWaterMark: Infinity })
  return { stream, start, lastByte: () => last }
}

const cases: ReadonlyArray<readonly [string, (response: Response) => Promise<unknown>]> = [
  ["Response.json()", (r) => r.json()],
  ["arrayBuffer() + compiled Text.utf8", async (r) => Parser.parseSync(compiledJson, await r.arrayBuffer())],
  ["parseResponse, compiled", (r) => Effect.runPromise(ParserStream.parseResponse(r, compiledJson))],
  ["parseResponse, interpreted", (r) => Effect.runPromise(ParserStream.parseResponse(r, interpretedJson))]
]

const expected = JSON.stringify(JSON.parse(doc))
console.log(`document: ${(bytes.length / 1e6).toFixed(2)} MB of UTF-8 JSON, ${chunkSize / 1024} KiB chunks; best of 5 runs\n`)
for (const bandwidth of [10, 25, 100, Infinity]) {
  console.log(bandwidth === Infinity ? "in memory (no throttling)" : `${bandwidth} MB/s (${bandwidth * 8} Mbit/s)`)
  for (const [name, run] of cases) {
    let bestTotal = Infinity
    let bestAfter = Infinity
    for (let i = 0; i < 5; i++) {
      const b = body(bandwidth)
      const value = await run(new Response(b.stream))
      const end = performance.now()
      // Let the body finish delivering before the next run
      while (b.lastByte() === 0) await sleep(1)
      if (i === 0 && JSON.stringify(value) !== expected) throw new Error(`${name}: wrong result`)
      bestTotal = Math.min(bestTotal, end - b.start)
      bestAfter = Math.min(bestAfter, Math.max(0, end - b.lastByte()))
    }
    console.log(`  ${name.padEnd(36)} ${bestTotal.toFixed(1).padStart(7)} ms total  ${bestAfter.toFixed(1).padStart(6)} ms after the last byte`)
  }
  console.log()
}
