/**
 * Token sets for compiled parsers: membership tables for small units, the
 * exact test for the rest, and the code point ranges when they are known.
 */
import * as Arr from "effect/Array"
import * as Order from "effect/Order"
import * as Predicate from "effect/Predicate"
import type { Encoding } from "../../Encoding.js"
import { firstCodePoint } from "../text.js"
import { compile, compileAny, PredicateRanges } from "../tokens.js"

/** Size of the membership table: every byte, and the Latin-1 code points. */
export const TableSize = 256

export interface CharSet {
  /** Tests a code point (or byte, for `Token` on bytes). */
  readonly test: (code: number) => boolean
  /** `table[c] === 1` iff `test(c)`, for `c < TableSize`. */
  readonly table: Uint8Array
  /** Sorted inclusive ranges of accepted code points, when known. */
  readonly ranges: ReadonlyArray<readonly [number, number]> | undefined
}

const isRange = (u: unknown): u is { readonly from: string | number; readonly to: string | number } =>
  Predicate.isObjectOrArray(u) && (u as any)._tag === "TokenRange"

const toCode = (u: string | number): number => (Predicate.isNumber(u) ? u : firstCodePoint(u))

/** The code point ranges of a token set, or `undefined` if it has an unknown predicate. */
export const rangesOf = (set: unknown): Array<[number, number]> | undefined => {
  const out: Array<[number, number]> = []
  const add = (u: unknown): boolean => {
    if (Predicate.isString(u)) {
      for (const c of u) {
        const cp = firstCodePoint(c)
        out.push([cp, cp])
      }
      return true
    }
    if (Predicate.isNumber(u)) {
      out.push([u, u])
      return true
    }
    if (u instanceof Uint8Array) {
      for (const b of u) out.push([b, b])
      return true
    }
    if (isRange(u)) {
      out.push([toCode(u.from), toCode(u.to)])
      return true
    }
    if (Predicate.isFunction(u)) {
      const r = (u as any)[PredicateRanges] as ReadonlyArray<readonly [number, number]> | undefined
      if (r === undefined) return false
      for (const [a, b] of r) out.push([a, b])
      return true
    }
    if (Array.isArray(u)) return u.every(add)
    return false
  }
  if (!add(set)) return undefined
  const merged: Array<[number, number]> = []
  for (const [a, b] of Arr.sort(
    out,
    Order.mapInput(Order.Number, (range: readonly [number, number]) => range[0])
  )) {
    if (b < a) continue
    const last = merged[merged.length - 1]
    if (last !== undefined && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return merged
}

const makeSet = (test: (code: number) => boolean, set: unknown): CharSet => {
  // The table calls the test once per small code: token-set predicates are
  // assumed to be pure (see the design notes).
  const table = new Uint8Array(TableSize)
  for (let c = 0; c < TableSize; c++) table[c] = test(c) ? 1 : 0
  return { test, table, ranges: rangesOf(set) }
}

/**
 * The set as a `Token` parser sees it: string predicates receive strings on
 * string input, everything receives numbers on byte input.
 */
export const tokenSet = (set: unknown, kind: 0 | 1): CharSet => {
  const m = compileAny(set)
  return makeSet(kind === 0 ? m.forString.code : m.forCode.code, set)
}

/** The set as a `Text` parser sees it: code points, for any encoding. */
export const textSet = (set: unknown): CharSet => makeSet(compile(set, "string").code, set)

/** Whether some accepted code point is at least `limit` (true when unknown). */
export const reachesAbove = (s: CharSet, limit: number): boolean =>
  s.ranges === undefined || s.ranges.some(([, b]) => b >= limit)

/** The input kind a `Text` encoding reads: 0 for strings, 1 for bytes. */
export const kindOfEncoding = (enc: Encoding<any>): 0 | 1 => {
  let k = kinds.get(enc)
  if (k === undefined) kinds.set(enc, (k = Predicate.isString(enc.encode("")) ? 0 : 1))
  return k
}

const kinds = /*#__PURE__*/ new WeakMap<Encoding<any>, 0 | 1>()
