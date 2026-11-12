/**
 * What the benchmarks share: the records of the benchmark document, and the
 * timing loop.
 */

/** The records of the benchmark document: keys, short and non-ASCII strings, numbers and nesting. */
export const records = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `item ${i}`,
    label: `élément nº${i} — 項目 😀`,
    tags: ["a", "b", "c"],
    price: i * 1.25,
    active: i % 2 === 0,
    nested: { x: i, y: [1, 2, 3], z: null }
  }))

/**
 * Runs every case `rounds` times, interleaved with the others, and returns
 * each case's best time in milliseconds: the least noisy estimate on a busy
 * machine.
 */
export const bestOf = <A, C extends { readonly run: () => A }>(
  cases: ReadonlyArray<C>,
  rounds: number
): Map<C, number> => {
  const best = new Map<C, number>(cases.map((c) => [c, Infinity]))
  for (let round = 0; round < rounds; round++) {
    for (const c of cases) {
      const start = performance.now()
      c.run()
      const ms = performance.now() - start
      if (ms < (best.get(c) ?? Infinity)) best.set(c, ms)
    }
  }
  return best
}
