/**
 * Sets of Unicode scalar values, for the regex engine's character classes.
 *
 * A set is a sorted list of disjoint, non-adjacent inclusive ranges, so that
 * the class algebra of Rust's regex syntax (union, intersection, difference,
 * symmetric difference, negation and simple case folding) is exact, and so
 * that matching can test a byte table for ASCII and search the ranges above
 * it. Surrogates (U+D800–U+DFFF) are never members: they
 * have no UTF-8 encoding, so no input can contain them.
 *
 * @since 0.0.0
 */
import * as Arr from "effect/Array"
import * as Order from "effect/Order"
import * as Tables from "./unicodeTables.ts"

/**
 * Inclusive `[from, to]` code point ranges, sorted and disjoint.
 *
 * @since 0.0.0
 */
export type Ranges = ReadonlyArray<readonly [number, number]>

const MAX = 0x10ffff
const SURROGATE_START = 0xd800
const SURROGATE_END = 0xdfff

/**
 * Sorts and merges arbitrary ranges into canonical form, dropping surrogates.
 *
 * @since 0.0.0
 */
export const normalize = (ranges: Ranges): Ranges => {
  const sorted = Arr.sort(
    ranges.filter(([a, b]) => a <= b),
    Order.combine(
      Order.mapInput(Order.Number, (r: readonly [number, number]) => r[0]),
      Order.mapInput(Order.Number, (r: readonly [number, number]) => r[1])
    )
  )
  const out: Array<[number, number]> = []
  for (const [a, b] of sorted) {
    const last = out.at(-1)
    if (last !== undefined && a <= last[1] + 1) {
      last[1] = Math.max(last[1], b)
    } else {
      out.push([a, b])
    }
  }
  return removeSurrogates(out)
}

const removeSurrogates = (ranges: ReadonlyArray<readonly [number, number]>): Ranges =>
  ranges.flatMap(([a, b]): Array<readonly [number, number]> => {
    if (b < SURROGATE_START || a > SURROGATE_END) return [[a, b]]
    const parts: Array<readonly [number, number]> = []
    if (a < SURROGATE_START) parts.push([a, SURROGATE_START - 1])
    if (b > SURROGATE_END) parts.push([SURROGATE_END + 1, b])
    return parts
  })

/**
 * The set of every Unicode scalar value.
 *
 * @since 0.0.0
 */
export const all: Ranges = normalize([[0, MAX]])

/**
 * The empty set.
 *
 * @since 0.0.0
 */
export const none: Ranges = []

/**
 * A set of the given code points.
 *
 * @since 0.0.0
 */
export const of = (...codePoints: ReadonlyArray<number>): Ranges => normalize(codePoints.map((c) => [c, c] as const))

/**
 * The union of sets.
 *
 * @since 0.0.0
 */
export const union = (...sets: ReadonlyArray<Ranges>): Ranges => normalize(sets.flat())

/**
 * The complement of a set among the Unicode scalar values.
 *
 * @since 0.0.0
 */
export const negate = (set: Ranges): Ranges => {
  const out: Array<readonly [number, number]> = []
  let next = 0
  for (const [a, b] of set) {
    if (a > next) out.push([next, a - 1])
    next = b + 1
  }
  if (next <= MAX) out.push([next, MAX])
  return removeSurrogates(out)
}

/**
 * The intersection of two sets.
 *
 * @since 0.0.0
 */
export const intersect = (x: Ranges, y: Ranges): Ranges => negate(union(negate(x), negate(y)))

/**
 * The members of `x` that are not in `y`.
 *
 * @since 0.0.0
 */
export const difference = (x: Ranges, y: Ranges): Ranges => intersect(x, negate(y))

/**
 * The members of exactly one of two sets.
 *
 * @since 0.0.0
 */
export const symmetricDifference = (x: Ranges, y: Ranges): Ranges => difference(union(x, y), intersect(x, y))

/**
 * Whether a set contains a code point (binary search).
 *
 * @since 0.0.0
 */
export const has = (set: Ranges, c: number): boolean => {
  let lo = 0
  let hi = set.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const range = set[mid]
    if (c < range[0]) hi = mid - 1
    else if (c > range[1]) lo = mid + 1
    else return true
  }
  return false
}

/**
 * Whether a set has no members.
 *
 * @since 0.0.0
 */
export const isEmpty = (set: Ranges): boolean => Arr.isReadonlyArrayEmpty(set)

/**
 * The single member of a one-element set, or `undefined`.
 *
 * @since 0.0.0
 */
export const single = (set: Ranges): number | undefined => {
  const first = set[0]
  return set.length === 1 && first !== undefined && first[0] === first[1] ? first[0] : undefined
}

/**
 * Whether every member of a set is ASCII.
 *
 * @since 0.0.0
 */
export const isAscii = (set: Ranges): boolean => {
  const last = set.at(-1)
  return last === undefined || last[1] < 0x80
}

// ---------------------------------------------------------------------------
// Unicode properties
// ---------------------------------------------------------------------------

/**
 * Every scalar value once, in order: the BMP below and above the surrogates
 * as one code unit each, then the astral planes as surrogate pairs. Matching
 * a property regex over it with `/g` finds a property's ranges in one native
 * scan instead of a million `test` calls.
 */
let everyScalar: string | undefined

const scalars = (): string => {
  if (everyScalar === undefined) {
    const parts: Array<string> = []
    const chunk = (from: number, to: number) => {
      for (let start = from; start <= to; start += 0x1000) {
        const end = Math.min(to, start + 0xfff)
        const cps: Array<number> = []
        for (let c = start; c <= end; c++) cps.push(c)
        parts.push(String.fromCodePoint(...cps))
      }
    }
    chunk(0, SURROGATE_START - 1)
    chunk(SURROGATE_END + 1, MAX)
    everyScalar = parts.join("")
  }
  return everyScalar
}

/** The code point at a code unit index of {@link scalars}. */
const indexToCodePoint = (index: number): number => {
  if (index < SURROGATE_START) return index
  const bmpUpper = 0x10000 - (SURROGATE_END + 1)
  const afterGap = index - SURROGATE_START
  if (afterGap < bmpUpper) return SURROGATE_END + 1 + afterGap
  return 0x10000 + ((afterGap - bmpUpper) >> 1)
}

const propertyCache = new Map<string, Ranges>()

/**
 * The members of a set described by a JavaScript regex class body (such as
 * `\p{Script=Greek}` or `[\p{L}\p{Nd}]`), computed once and cached.
 *
 * @since 0.0.0
 */
const fromRegExpClass = (source: string): Ranges => {
  const cached = propertyCache.get(source)
  if (cached !== undefined) return cached
  const re = new RegExp(`${source}+`, "gu")
  const text = scalars()
  const out: Array<readonly [number, number]> = []
  for (const m of text.matchAll(re)) {
    const first = indexToCodePoint(m.index)
    const last = indexToCodePoint(m.index + m[0].length - 1)
    out.push([first, last])
  }
  const set = normalize(out)
  propertyCache.set(source, set)
  return set
}

/** Rust's property keys (loosely matched) and JavaScript's names for them. */
const propertyKeys: ReadonlyMap<string, string> = new Map([
  ["sc", "Script"],
  ["script", "Script"],
  ["scx", "Script_Extensions"],
  ["scriptextensions", "Script_Extensions"],
  ["gc", "General_Category"],
  ["generalcategory", "General_Category"]
])

const loose = (s: string): string => s.replaceAll(/[\s_-]/g, "").toLowerCase()

const titleCase = (s: string): string =>
  s
    .trim()
    .split(/[\s_-]+/)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1).toLowerCase())
    .join("_")

const specialProperties: ReadonlyMap<string, string> = new Map([
  ["any", "Any"],
  ["ascii", "ASCII"],
  ["assigned", "Assigned"],
  ["whitespace", "White_Space"],
  ["space", "White_Space"],
  ["digit", "Nd"],
  ["decimalnumber", "Nd"]
])

const tryProperty = (body: string): Ranges | undefined => {
  try {
    // Throws a SyntaxError for a name JavaScript does not know.
    return fromRegExpClass(`\\p{${body}}`)
  } catch {
    return undefined
  }
}

const valueCandidates = (value: string): ReadonlyArray<string> => {
  const special = specialProperties.get(loose(value))
  return [value, titleCase(value), value.toUpperCase(), ...(special === undefined ? [] : [special])]
}

/**
 * The set named by a Rust `\p{...}` property: a general category (`L`,
 * `Letter`, `gc=Lu`), a script (`Greek`, `sc=Greek`, `scx=Greek`) or a
 * binary property (`Alphabetic`, `Emoji`). Names match loosely, as in Rust:
 * case, spaces, `_` and `-` are ignored where JavaScript's own names allow.
 * Returns `undefined` for an unknown name.
 *
 * @since 0.0.0
 */
export const unicodeProperty = (name: string): Ranges | undefined => {
  const eq = name.search(/[=:]/)
  if (eq < 0) return firstProperty(valueCandidates(name).flatMap((v) => [v, `Script=${v}`]))
  const jsKey = propertyKeys.get(loose(name.slice(0, eq)))
  if (jsKey === undefined) return undefined
  return firstProperty(valueCandidates(name.slice(eq + 1)).map((v) => `${jsKey}=${v}`))
}

/** The set of the first property body JavaScript knows. */
const firstProperty = (bodies: ReadonlyArray<string>): Ranges | undefined => {
  for (const body of bodies) {
    const set = tryProperty(body)
    if (set !== undefined) return set
  }
  return undefined
}

/**
 * Rust's Unicode `\w`: `Alphabetic`, marks, decimal numbers, connector
 * punctuation and `Join_Control` (precomputed in `unicodeTables.ts`).
 *
 * @since 0.0.0
 */
export const unicodeWord = (): Ranges => Tables.word

/**
 * Rust's Unicode `\d`: general category `Nd`.
 *
 * @since 0.0.0
 */
export const unicodeDigit = (): Ranges => Tables.digit

/**
 * Rust's Unicode `\s`: the `White_Space` property.
 *
 * @since 0.0.0
 */
export const unicodeSpace = (): Ranges => Tables.space

/**
 * ASCII `\w`: `[0-9A-Za-z_]`.
 *
 * @since 0.0.0
 */
export const asciiWord: Ranges = normalize([
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a]
])

/**
 * ASCII `\d`: `[0-9]`.
 *
 * @since 0.0.0
 */
export const asciiDigit: Ranges = [[0x30, 0x39]]

/**
 * ASCII `\s`: `[\t\n\v\f\r ]`.
 *
 * @since 0.0.0
 */
export const asciiSpace: Ranges = normalize([
  [0x09, 0x0d],
  [0x20, 0x20]
])

/**
 * The POSIX classes allowed in brackets (`[[:alpha:]]`), as ASCII sets.
 *
 * @since 0.0.0
 */
export const posixClasses: ReadonlyMap<string, Ranges> = new Map<string, Ranges>([
  [
    "alnum",
    normalize([
      [0x30, 0x39],
      [0x41, 0x5a],
      [0x61, 0x7a]
    ])
  ],
  [
    "alpha",
    normalize([
      [0x41, 0x5a],
      [0x61, 0x7a]
    ])
  ],
  ["ascii", [[0, 0x7f]]],
  [
    "blank",
    normalize([
      [0x09, 0x09],
      [0x20, 0x20]
    ])
  ],
  [
    "cntrl",
    normalize([
      [0, 0x1f],
      [0x7f, 0x7f]
    ])
  ],
  ["digit", asciiDigit],
  ["graph", [[0x21, 0x7e]]],
  ["lower", [[0x61, 0x7a]]],
  ["print", [[0x20, 0x7e]]],
  [
    "punct",
    normalize([
      [0x21, 0x2f],
      [0x3a, 0x40],
      [0x5b, 0x60],
      [0x7b, 0x7e]
    ])
  ],
  ["space", asciiSpace],
  ["upper", [[0x41, 0x5a]]],
  ["word", asciiWord],
  [
    "xdigit",
    normalize([
      [0x30, 0x39],
      [0x41, 0x46],
      [0x61, 0x66]
    ])
  ]
])

// ---------------------------------------------------------------------------
// Simple case folding
// ---------------------------------------------------------------------------

let foldClasses: ReadonlyMap<number, ReadonlyArray<number>> | undefined

/** The classes of simple case folding, by member (precomputed in `unicodeTables.ts`). */
const caseClasses = (): ReadonlyMap<number, ReadonlyArray<number>> =>
  (foldClasses ??= new Map(Tables.foldClasses.flatMap((group) => group.map((c) => [c, group] as const))))

/**
 * Closes a set under simple case folding: adds every case variant of every
 * member, as Rust's regex does under `(?i)`.
 *
 * @since 0.0.0
 */
export const caseFold = (set: Ranges): Ranges => {
  const extra: Array<readonly [number, number]> = []
  for (const [c, group] of caseClasses()) {
    if (has(set, c)) for (const d of group) extra.push([d, d])
  }
  return Arr.isReadonlyArrayEmpty(extra) ? set : union(set, extra)
}

/**
 * The case variants of one code point, itself included.
 *
 * @since 0.0.0
 */
export const caseVariants = (c: number): ReadonlyArray<number> => caseClasses().get(c) ?? [c]

/**
 * Whether a string contains a character that has case variants (an
 * uppercase letter, for smart case, is tested separately).
 *
 * @since 0.0.0
 */
export const hasUppercase = (s: string): boolean => /\p{Uppercase}/u.test(s)
