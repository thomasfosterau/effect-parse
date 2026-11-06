/**
 * Prefilters: facts about a regex that let the searcher skip input without
 * running the matcher, as ripgrep's literal optimisations do.
 *
 * - **Prefix literals**: a small set of byte strings one of which every
 *   match starts with. Candidate starts are their occurrences, found with
 *   the native `indexOf`.
 * - **Required literals**: a small set of byte strings one of which every
 *   match contains. Outside multiline mode a match lies within one line, so
 *   only the lines holding an occurrence need the matcher.
 * - **First bytes**: the bytes a match can start with, tested with a table.
 *
 * Each is a necessary condition only: the matcher still decides every match.
 *
 * @since 0.0.0
 */
import * as Str from "effect/String"
import type { Regex } from "./ast.ts"
import type { Ranges } from "./charset.ts"

const encoder = new TextEncoder()

/** The most strings a literal set may hold: each costs a pass of `indexOf` over the input. */
const MAX_LITERALS = 8

/** The most code points a class may hold to be treated as a set of literals. */
const MAX_CLASS = 4

const classSize = (set: Ranges): number => set.reduce((n, [a, b]) => n + (b - a + 1), 0)

const classStrings = (set: Ranges): ReadonlyArray<string> | undefined => {
  if (classSize(set) > MAX_CLASS) return undefined
  return set.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)))
}

const product = (xs: ReadonlyArray<string>, ys: ReadonlyArray<string>): ReadonlyArray<string> | undefined =>
  xs.length * ys.length > MAX_LITERALS ? undefined : xs.flatMap((x) => ys.map((y) => x + y))

const dedupe = (xs: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(xs)]

/**
 * The complete set of strings a node matches, when it is small and finite
 * (assertions match the empty string here: a superset is enough).
 */
const exact = (regex: Regex): ReadonlyArray<string> | undefined => {
  switch (regex._tag) {
    case "Empty":
    case "Look":
      return [""]
    case "Literal":
      return [regex.text]
    case "Class":
      return classStrings(regex.set)
    case "Capture":
      return exact(regex.sub)
    case "Repeat":
      return exactRepeat(regex)
    case "Concat":
      return regex.subs.reduce<ReadonlyArray<string> | undefined>(
        (acc, sub) => {
          const next = acc === undefined ? undefined : exact(sub)
          return next === undefined || acc === undefined ? undefined : product(acc, next)
        },
        [""]
      )
    case "Alternate":
      return alternatives(regex.subs.map(exact))
  }
}

const exactRepeat = (regex: Extract<Regex, { _tag: "Repeat" }>): ReadonlyArray<string> | undefined => {
  if (regex.min !== regex.max || regex.max > MAX_LITERALS) return undefined
  const sub = exact(regex.sub)
  let acc: ReadonlyArray<string> | undefined = [""]
  for (let i = 0; i < regex.min && acc !== undefined && sub !== undefined; i++) acc = product(acc, sub)
  return sub === undefined ? undefined : acc
}

const alternatives = (sets: ReadonlyArray<ReadonlyArray<string> | undefined>): ReadonlyArray<string> | undefined => {
  if (sets.some((s) => s === undefined)) return undefined
  const all = dedupe(sets.flatMap((s) => s ?? []))
  return all.length > MAX_LITERALS ? undefined : all
}

/** How useful a literal set is as a prefilter: longer shortest member first, then fewer members. */
const score = (set: ReadonlyArray<string>): number => {
  const shortest = Math.min(...set.map((s) => encoder.encode(s).length))
  return shortest === 0 ? -1 : shortest * 16 - set.length
}

const better = (a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string> | undefined) => {
  if (a === undefined) return b
  if (b === undefined) return a
  return score(b) > score(a) ? b : a
}

/** The literals at the start of every match: the leading run of exactly known parts. */
const prefixes = (regex: Regex): ReadonlyArray<string> | undefined => {
  const parts = regex._tag === "Concat" ? regex.subs : [regex]
  let acc: ReadonlyArray<string> = [""]
  for (const part of parts) {
    const set = exact(part)
    const next = set === undefined ? undefined : product(acc, set)
    if (next === undefined) {
      // A part that is not exactly known still starts with its own prefixes.
      const inner = part._tag === "Alternate" || part._tag === "Concat" ? undefined : leading(part)
      const joined = inner === undefined ? undefined : product(acc, inner)
      return joined ?? acc
    }
    acc = next
  }
  return acc
}

/** The prefixes of a repetition or group that is not exactly known. */
const leading = (regex: Regex): ReadonlyArray<string> | undefined => {
  if (regex._tag === "Capture") return prefixes(regex.sub)
  if (regex._tag === "Repeat" && regex.min > 0) return prefixes(regex.sub)
  return undefined
}

/** A set of literals one of which every match contains. */
const required = (regex: Regex): ReadonlyArray<string> | undefined => {
  switch (regex._tag) {
    case "Literal":
    case "Class":
      return exact(regex)
    case "Capture":
      return required(regex.sub)
    case "Repeat":
      return regex.min > 0 ? better(exact(regex), required(regex.sub)) : undefined
    case "Alternate":
      return alternatives(regex.subs.map((s) => better(exact(s), required(s))))
    case "Concat":
      return requiredConcat(regex.subs)
    default:
      return undefined
  }
}

/** The best of every window of exactly known parts and every part's own required set. */
const requiredConcat = (subs: ReadonlyArray<Regex>): ReadonlyArray<string> | undefined => {
  let best: ReadonlyArray<string> | undefined
  for (let i = 0; i < subs.length; i++) {
    best = better(best, required(subs[i]))
    let acc: ReadonlyArray<string> | undefined = [""]
    for (let j = i; j < subs.length && acc !== undefined; j++) {
      const set = exact(subs[j])
      acc = set === undefined ? undefined : product(acc, set)
      if (acc !== undefined) best = better(best, acc)
    }
  }
  return best
}

const lead = (c: number): number => (c < 0x800 ? 0xc0 | (c >> 6) : c < 0x10000 ? 0xe0 | (c >> 12) : 0xf0 | (c >> 18))

const markClass = (table: Uint8Array, set: Ranges): void => {
  for (const [a, b] of set) {
    for (let c = a; c <= Math.min(b, 0x7f); c++) table[c] = 1
    if (b >= 0x80) for (let x = lead(Math.max(a, 0x80)); x <= lead(b); x++) table[x] = 1
  }
}

/** Marks the bytes a match of `regex` can start with; returns whether it can match the empty string. */
const markFirst = (table: Uint8Array, regex: Regex): boolean => {
  switch (regex._tag) {
    case "Empty":
    case "Look":
      return true
    case "Literal":
      table[encoder.encode(regex.text)[0] ?? 0] = 1
      return false
    case "Class":
      markClass(table, regex.set)
      return false
    case "Capture":
      return markFirst(table, regex.sub)
    case "Repeat":
      return markFirst(table, regex.sub) || regex.min === 0
    case "Concat":
      return regex.subs.every((sub) => markFirst(table, sub))
    case "Alternate":
      return regex.subs.map((sub) => markFirst(table, sub)).some((nullable) => nullable)
  }
}

/**
 * The bytes a match of a regex can start with (`table[b]` is 1), and
 * whether it can match the empty string, in which case anything may follow.
 *
 * @since 0.0.0
 */
export interface FirstBytes {
  readonly table: Uint8Array
  readonly nullable: boolean
}

/**
 * The first bytes of `regex` (see {@link FirstBytes}).
 *
 * @since 0.0.0
 */
export const firstBytes = (regex: Regex): FirstBytes => {
  const table = new Uint8Array(256)
  return { table, nullable: markFirst(table, regex) }
}

/**
 * The ASCII bytes a part matches, when it is one byte from a small set: a
 * one-byte literal or a small ASCII class (`[sS]` under `-i`).
 */
const byteSet = (regex: Regex): Uint8Array | undefined => {
  if (regex._tag === "Literal")
    return regex.text.length === 1 && regex.text < "\x80" ? Uint8Array.of(regex.text.charCodeAt(0)) : undefined
  if (regex._tag !== "Class" || classSize(regex.set) > MAX_CLASS) return undefined
  const bytes = regex.set.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))
  return bytes.every((c) => c < 0x80) ? Uint8Array.from(bytes) : undefined
}

/** A part split into one-byte sets, when every character of it is one (`Literal` "abc" is three). */
const byteSets = (regex: Regex): ReadonlyArray<Uint8Array> | undefined => {
  if (regex._tag === "Literal") {
    const bytes = encoder.encode(regex.text)
    return bytes.every((c) => c < 0x80) ? Array.from(bytes, (c) => Uint8Array.of(c)) : undefined
  }
  const one = byteSet(regex)
  return one === undefined ? undefined : [one]
}

/** A run of one-byte sets, and the index of the part it starts at. */
interface Run {
  readonly sets: ReadonlyArray<Uint8Array>
  readonly index: number
}

/** The longest run of one-byte sets in a concatenation, and where it starts (0 for a prefix). */
const longestSequence = (parts: ReadonlyArray<Regex>): Run => {
  let best: ReadonlyArray<Uint8Array> = []
  let bestIndex = -1
  let run: Array<Uint8Array> = []
  let runIndex = 0
  parts.forEach((part, i) => {
    const sets = byteSets(part)
    if (sets === undefined) {
      run = []
      runIndex = i + 1
      return
    }
    run = [...run, ...sets]
    if (run.length > best.length) {
      best = run
      bestIndex = runIndex
    }
  })
  return { sets: best, index: bestIndex }
}

/**
 * A byte-set sequence every match contains: consecutive positions, each one
 * of a few ASCII bytes (`[sS][hH][eE]…` under `-i`). `atStart` when every
 * match starts with it.
 *
 * @since 0.0.0
 */
export interface Sequence {
  readonly sets: ReadonlyArray<Uint8Array>
  readonly atStart: boolean
}

const sequenceOf = (regex: Regex): Sequence | undefined => {
  const parts = regex._tag === "Concat" ? regex.subs : [regex]
  const { index, sets } = longestSequence(parts)
  if (sets.length < 2) return undefined
  // Leading assertions do not consume input: the sequence still starts each match.
  const atStart = parts.slice(0, index).every((p) => p._tag === "Look")
  return { sets, atStart }
}

/**
 * What the searcher may skip by.
 *
 * @since 0.0.0
 */
export interface Prefilter {
  /** Every match starts with one of these (as UTF-8), or `undefined`. */
  readonly prefixes: ReadonlyArray<Uint8Array> | undefined
  /** Every match contains one of these, or `undefined`. */
  readonly required: ReadonlyArray<Uint8Array> | undefined
  /** `table[b]` is 1 for each byte a match can start with; `undefined` when a match can be empty. */
  readonly firstBytes: Uint8Array | undefined
  /** A byte-set sequence every match contains, or `undefined`. */
  readonly sequence: Sequence | undefined
}

const bytesOf = (set: ReadonlyArray<string> | undefined): ReadonlyArray<Uint8Array> | undefined =>
  set === undefined || score(set) < 0 ? undefined : set.map((s) => encoder.encode(s))

/**
 * The prefilters for a regex.
 *
 * @example
 * ```ts
 * import * as Prefilter from "./prefilter.ts"
 *
 * Prefilter.analyze({ _tag: "Literal", text: "needle" }).prefixes // [needle]
 * ```
 *
 * @since 0.0.0
 */
export const analyze = (regex: Regex): Prefilter => {
  const table = new Uint8Array(256)
  const nullable = markFirst(table, regex)
  const pre = prefixes(regex)
  const req = required(regex)
  return {
    prefixes: bytesOf(pre),
    required: bytesOf(better(pre, req)),
    firstBytes: nullable ? undefined : table,
    sequence: sequenceOf(regex)
  }
}

/**
 * Whether a regex is exactly a set of literals, so that an occurrence of a
 * prefix is a match by itself.
 *
 * @since 0.0.0
 */
export const isLiteralSet = (regex: Regex): boolean => {
  const set = exact(regex)
  return set !== undefined && set.every(Str.isNonEmpty) && !hasLook(regex)
}

const hasLook = (regex: Regex): boolean => {
  switch (regex._tag) {
    case "Look":
      return true
    case "Capture":
    case "Repeat":
      return hasLook(regex.sub)
    case "Concat":
    case "Alternate":
      return regex.subs.some(hasLook)
    default:
      return false
  }
}
