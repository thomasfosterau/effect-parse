/**
 * Searching for the stop characters of `Token.takeTill` on string input
 * (#75): a run is scanned a unit at a time for `SearchHead` units, then
 * found with `indexOf`, which V8 runs much faster on long runs. Both
 * compilers use these; the interpreter scans unit by unit.
 */
import * as Arr from "effect/Array"
import type { State } from "../../Input.js"
import type { CharSet } from "./sets.js"

/**
 * How many units a compiled `takeTill` tests one at a time before it
 * searches with `indexOf` (twice as many for several stop characters, whose
 * cached search costs more): short runs, most tokens, are faster scanned.
 */
export const SearchHead = 8

/** The most stop characters a compiled `takeTill` searches for. */
const MaxStops = 3

/**
 * The stop characters of a `takeTill` set, as UTF-16 units, when there are
 * one to `MaxStops` of them, each a whole code point (not a surrogate).
 */
export const stopChars = (cs: CharSet): ReadonlyArray<number> | undefined => {
  const ranges = cs.ranges
  if (ranges === undefined || Arr.isReadonlyArrayEmpty(ranges) || ranges.length > MaxStops) return undefined
  if (!ranges.every(([a, b]) => a === b && (a < 0xd800 || (a > 0xdfff && a <= 0xffff)))) return undefined
  return ranges.map(([a]) => a)
}

/**
 * The stop characters of one compiled `takeTill`, identifying its search site.
 * The state holds, under this site, where each one next occurs (see
 * `nextStop`).
 */
export class StopCache {
  constructor(readonly chars: ReadonlyArray<string>) {}
}

/**
 * The first index from `p` of any of `site.chars` in the input of `s`, or
 * `s.end`. The state remembers, for each stop character `i`, the first
 * index at or after `from` where it occurs (`-1` if none), as
 * `[from, at]` at `2 * i` in `s.searches.get(site)`: successive runs over
 * one input then pay a comparison per stop character instead of a search,
 * and one that never occurs is searched for once.
 */
export const nextStop = (site: StopCache, s: State<string>, p: number): number => {
  const searches = (s.searches ??= new Map())
  let memo = searches.get(site)
  if (memo === undefined) {
    memo = site.chars.flatMap(() => [-1, -1])
    searches.set(site, memo)
  }
  let best = s.end
  for (let i = 0; i < site.chars.length; i++) {
    const from = memo[2 * i]
    let at = memo[2 * i + 1]
    if (from < 0 || p < from || (at >= 0 && at < p)) {
      at = s.input.indexOf(site.chars[i], p)
      memo[2 * i] = p
      memo[2 * i + 1] = at
    }
    if (at >= 0 && at < best) best = at
  }
  return best
}
