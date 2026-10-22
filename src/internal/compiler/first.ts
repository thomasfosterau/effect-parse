/**
 * First sets: which input units can start a match of a parser.
 *
 * A first set has a mode:
 *
 * - `Strict`: when the next unit is not in `units` (or the input has
 *   ended), the parser fails with `Backtrack`.
 * - `Optional`: in that case, the parser either fails with `Backtrack` or
 *   succeeds without consuming input.
 * - `Unknown`: no guarantee.
 *
 * Units are UTF-16 code units for strings and bytes for byte inputs; units
 * from `TableSize` up are summarized by `high`. Array inputs have no units.
 *
 * Skipping a parser that is certain to fail also skips the callbacks it
 * would have run before failing, which is why callbacks must be pure.
 */
import * as Predicate from "effect/Predicate"
import type { Encoding } from "../../Encoding.js"
import type { Node, ParserLike } from "../node.js"
import { nodeOf } from "../node.js"
import { fastLimit } from "../text.js"
import type { CharSet } from "./sets.js"
import { kindOfEncoding, reachesAbove, TableSize, textSet, tokenSet } from "./sets.js"

export const Strict = 0
export const Optional = 1
export const Unknown = 2

export interface First {
  readonly mode: 0 | 1 | 2
  readonly units: Uint8Array
  readonly high: boolean
}

const none = /*#__PURE__*/ new Uint8Array(TableSize)
const all = /*#__PURE__*/ new Uint8Array(TableSize).fill(1)

const unknown: First = { mode: Unknown, units: all, high: true }
const emptyOptional: First = { mode: Optional, units: none, high: false }
const failing: First = { mode: Strict, units: none, high: false }
const anyUnit: First = { mode: Strict, units: all, high: true }

const union = (a: First, b: First, mode: 0 | 1 | 2): First => {
  const units = new Uint8Array(TableSize)
  for (let i = 0; i < TableSize; i++) units[i] = a.units[i] | b.units[i]
  return { mode, units, high: a.high || b.high }
}

const withMode = (f: First, mode: 0 | 1 | 2): First => (f.mode === mode ? f : { ...f, mode })

const lowerAscii = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c)
const upperAscii = (c: number): number => (c >= 97 && c <= 122 ? c - 32 : c)

const ofUnits = (codes: ReadonlyArray<number>, mode: 0 | 1 | 2 = Strict): First => {
  const units = new Uint8Array(TableSize)
  let high = false
  for (const c of codes) {
    if (c < TableSize) units[c] = 1
    else high = true
  }
  return { mode, units, high }
}

export class FirstSets {
  private readonly memo = new Map<ParserLike, First | undefined>()
  constructor(readonly kind: 0 | 1 | 2) {}

  of(p: ParserLike): First {
    if (this.kind === 2) return unknown
    if (this.memo.has(p)) return this.memo.get(p) ?? unknown // in progress: a cycle
    this.memo.set(p, undefined)
    const f = this.compute(nodeOf(p))
    this.memo.set(p, f)
    return f
  }

  /** Units of the code points of a set, as an encoding (or `Token`) reads them. */
  private setUnits(set: CharSet, enc: Encoding<any> | undefined, mode: 0 | 1): First | undefined {
    if (enc === undefined || kindOfEncoding(enc) === 0) {
      if (this.kind === 1) return { mode, units: set.table, high: false }
      return { mode, units: set.table, high: reachesAbove(set, TableSize) }
    }
    if (enc.unit !== 1) return undefined
    const fast = fastLimit(enc)
    if (fast === 0) return undefined
    const units = set.table.slice()
    // Multi-unit sequences start with a unit at or above `fast`
    if (fast < TableSize) units.fill(reachesAbove(set, fast) ? 1 : 0, fast)
    return { mode, units, high: false }
  }

  private compute(node: Node): First {
    const kind = this.kind as 0 | 1
    switch (node._tag) {
      case "Succeed":
      case "Sync":
      case "Location":
      case "RestLen":
      case "Eof":
        return emptyOptional
      case "Fail":
        return node.mode === "Backtrack" ? failing : unknown
      case "Any":
        return node.encoding !== undefined && kindOfEncoding(node.encoding) !== kind ? unknown : anyUnit
      case "Take":
        return node.count === 0 ? emptyOptional : anyUnit
      case "Literal": {
        const lit = node.literal
        if (node.encoding !== undefined) {
          if (kindOfEncoding(node.encoding) !== kind) return unknown
          if (node.caseless) return lit.length === 0 ? unknown : anyUnit
          const encoded = node.encoding.encode(lit as string)
          if (encoded.length === 0) return emptyOptional
          return ofUnits([Predicate.isString(encoded) ? encoded.charCodeAt(0) : encoded[0]])
        }
        if (lit.length === 0) return emptyOptional
        let first: number
        if (Predicate.isString(lit)) {
          first = kind === 0 ? lit.charCodeAt(0) : new TextEncoder().encode(lit)[0]
        } else if (lit instanceof Uint8Array && kind === 1) {
          first = lit[0]
        } else {
          return unknown
        }
        return ofUnits(node.caseless ? [first, lowerAscii(first), upperAscii(first)] : [first])
      }
      case "OneOf":
      case "TakeWhile": {
        if (node.encoding !== undefined && kindOfEncoding(node.encoding) !== kind) return unknown
        const min = node._tag === "OneOf" ? 1 : node.min
        if (node._tag === "TakeWhile" && node.max === 0) return emptyOptional
        const mode = min > 0 ? Strict : Optional
        if (node.negate) return mode === Strict ? anyUnit : withMode(anyUnit, Optional)
        const set = node.encoding === undefined ? tokenSet(node.set, kind) : textSet(node.set)
        return this.setUnits(set, node.encoding, mode) ?? (mode === Strict ? anyUnit : unknown)
      }
      case "Map":
      case "As":
      case "Tap":
      case "TryMap":
      case "FilterMap":
      case "Filter":
      case "Taken":
      case "WithTaken":
      case "Span":
      case "WithSpan":
      case "Context":
      case "Expected":
      case "MapError":
      case "OrFail":
      case "Peek":
      case "Trace":
      case "Syntax":
      case "ResumeAfter":
      case "RetryAfter":
        return this.of(node.self)
      case "FlatMap":
      case "SeparatedFold":
      case "Dispatch": {
        const f = this.of(node._tag === "Dispatch" ? node.selector : node.self)
        return f.mode === Strict ? f : unknown
      }
      case "Mode": {
        const f = this.of(node.self)
        return node.from === "Backtrack" ? (f.mode === Unknown ? f : unknown) : f
      }
      case "Opt":
      case "OrElseSucceed": {
        const f = this.of(node.self)
        return f.mode === Unknown ? f : withMode(f, Optional)
      }
      case "Seq":
      case "Struct":
        return this.sequence(node.parsers)
      case "ZipWith":
        return this.sequence([node.self, node.that])
      case "Alt": {
        if (node.parsers.length === 0) return failing
        let acc: First | undefined
        let mode: 0 | 1 | 2 = Strict
        for (const p of node.parsers) {
          const f = this.of(p)
          if (f.mode === Unknown) return unknown
          if (f.mode === Optional) mode = Optional
          acc = acc === undefined ? f : union(acc, f, mode)
        }
        return acc === undefined ? failing : withMode(acc, mode)
      }
      case "Repeat":
      case "Fold":
      case "Separated": {
        if (node.max === 0) return emptyOptional
        const f = this.of(node.self)
        if (f.mode !== Strict) return unknown
        return node.min === 0 ? withMode(f, Optional) : f
      }
      case "Suspend":
        return this.of(node.resolve())
      default:
        return unknown
    }
  }

  private sequence(parsers: ReadonlyArray<ParserLike>): First {
    let acc: First | undefined
    for (const p of parsers) {
      const f = this.of(p)
      if (f.mode === Unknown) return unknown
      acc = acc === undefined ? f : union(acc, f, f.mode)
      if (f.mode === Strict) return acc
    }
    return acc ?? emptyOptional
  }
}

/**
 * For an `Alt`: the branches worth trying for each next unit, each next
 * high unit, and at the end of the input, or `undefined` when pruning
 * would never skip a branch.
 */
export interface AltPlan {
  /** Indexed by unit: indexes into `lists`. */
  readonly byUnit: Uint8Array
  readonly high: number
  readonly end: number
  readonly lists: ReadonlyArray<ReadonlyArray<number>>
}

export const planAlt = (firsts: ReadonlyArray<First>): AltPlan | undefined => {
  const n = firsts.length
  if (n < 2 || n > 64) return undefined
  const lists: Array<ReadonlyArray<number>> = []
  const index = new Map<string, number>()
  const listOf = (keep: (f: First) => boolean): number => {
    const list: Array<number> = []
    for (let i = 0; i < n; i++) if (keep(firsts[i])) list.push(i)
    const key = list.join(",")
    let k = index.get(key)
    if (k === undefined) {
      k = lists.length
      lists.push(list)
      index.set(key, k)
    }
    return k
  }
  const byUnit = new Uint8Array(TableSize)
  for (let u = 0; u < TableSize; u++) byUnit[u] = listOf((f) => f.mode !== Strict || f.units[u] === 1)
  const high = listOf((f) => f.mode !== Strict || f.high)
  const end = listOf((f) => f.mode !== Strict)
  if (lists.length === 1 && lists[0].length === n) return undefined
  if (lists.length > 255) return undefined
  return { byUnit, high, end, lists }
}
