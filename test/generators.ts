/** Input generators shared by the differential test suites. */

/** A deterministic PRNG (mulberry32). */
export const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Random mutations of a valid input: deletions, insertions, replacements and truncations. */
export const mutations = (doc: string, alphabet: string, count: number, seed: number): Array<string> => {
  const random = rng(seed)
  const chars = Array.from(alphabet)
  return Array.from({ length: count }, (_, i) => {
    const at = Math.floor(random() * (doc.length + 1))
    const c = chars[Math.floor(random() * chars.length)]
    switch (i % 4) {
      case 0:
        return doc.slice(0, at) + doc.slice(at + 1)
      case 1:
        return doc.slice(0, at) + c + doc.slice(at)
      case 2:
        return doc.slice(0, at) + c + doc.slice(at + 1)
      default:
        return doc.slice(0, at)
    }
  })
}

/** Every string over `alphabet` up to length `max`. */
export const allStrings = (alphabet: ReadonlyArray<string>, max: number): Array<string> => {
  const layers = (layer: Array<string>, n: number): Array<string> =>
    n > max
      ? []
      : [
          ...layer,
          ...layers(
            layer.flatMap((s) => alphabet.map((c) => s + c)),
            n + 1
          )
        ]
  return layers([""], 0)
}

export const randomJson = (random: () => number, depth = 0): string => {
  const ws = () => [" ", "", "\n  ", "\t", ""][Math.floor(random() * 5)]
  const pick = random()
  if (depth > 3 || pick < 0.45) {
    const atoms = [
      () => String(Math.floor(random() * 2000) - 1000),
      () => (random() * 100).toFixed(3),
      () => `${Math.floor(random() * 9)}e${Math.floor(random() * 20) - 10}`,
      () => "-0.5E+3",
      () => "true",
      () => "false",
      () => "null",
      () => JSON.stringify(["abc", "é", "😀 x", '"q"', "\\", "\n\t", "\u0001", ""][Math.floor(random() * 8)]),
      () => '"\\u00e9\\ud83d\\ude00\\/\\b"'
    ]
    return atoms[Math.floor(random() * atoms.length)]()
  }
  const n = Math.floor(random() * 4)
  if (pick < 0.75) {
    return `[${ws()}${Array.from({ length: n }, () => randomJson(random, depth + 1)).join(`${ws()},${ws()}`)}${ws()}]`
  }
  const members = Array.from(
    { length: n },
    (_, i) => `${JSON.stringify(`k${i}é`)}${ws()}:${ws()}${randomJson(random, depth + 1)}`
  )
  return `{${ws()}${members.join(`${ws()},${ws()}`)}${ws()}}`
}
