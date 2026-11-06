/**
 * The regex syntax tree: Rust regex syntax after flags have been applied.
 * Case-insensitive literals are already classes, `.` is already a class,
 * and `^` / `$` are already line or text anchors.
 *
 * @since 0.0.0
 */
import type { Ranges } from "./charset.ts"
import * as Arr from "effect/Array"

/**
 * A zero-width assertion.
 *
 * @since 0.0.0
 */
export type Look =
  | "StartText"
  | "EndText"
  | "StartLine"
  | "EndLine"
  | "StartLineCrlf"
  | "EndLineCrlf"
  | "WordBoundary"
  | "NotWordBoundary"
  | "WordStart"
  | "WordEnd"
  | "WordStartHalf"
  | "WordEndHalf"
  | "WordBoundaryAscii"
  | "NotWordBoundaryAscii"
  | "WordStartAscii"
  | "WordEndAscii"
  | "WordStartHalfAscii"
  | "WordEndHalfAscii"

/**
 * A regex.
 *
 * @since 0.0.0
 */
export type Regex =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Literal"; readonly text: string }
  | { readonly _tag: "Class"; readonly set: Ranges }
  | { readonly _tag: "Look"; readonly look: Look }
  | {
      readonly _tag: "Repeat"
      readonly sub: Regex
      readonly min: number
      readonly max: number
      readonly greedy: boolean
    }
  | { readonly _tag: "Capture"; readonly sub: Regex; readonly index: number; readonly name: string | undefined }
  | { readonly _tag: "Concat"; readonly subs: ReadonlyArray<Regex> }
  | { readonly _tag: "Alternate"; readonly subs: ReadonlyArray<Regex> }

/**
 * The empty regex, which matches the empty string.
 *
 * @since 0.0.0
 */
export const empty: Regex = { _tag: "Empty" }

/**
 * A concatenation, flattened, with adjacent literals merged.
 *
 * @since 0.0.0
 */
export const concat = (subs: ReadonlyArray<Regex>): Regex => {
  const out: Array<Regex> = []
  for (const sub of subs.flatMap((s) => (s._tag === "Concat" ? s.subs : s._tag === "Empty" ? [] : [s]))) {
    const last = out.at(-1)
    if (last?._tag === "Literal" && sub._tag === "Literal") {
      out[out.length - 1] = { _tag: "Literal", text: last.text + sub.text }
    } else {
      out.push(sub)
    }
  }
  if (Arr.isReadonlyArrayEmpty(out)) return empty
  return out.length === 1 ? out[0] : { _tag: "Concat", subs: out }
}

/**
 * An alternation of branches, tried in order (leftmost-first, as in Rust).
 *
 * @since 0.0.0
 */
export const alternate = (subs: ReadonlyArray<Regex>): Regex =>
  subs.length === 1 ? subs[0] : { _tag: "Alternate", subs }

/**
 * The fewest bytes a match of the regex can consume (0 for one that can
 * match the empty string).
 *
 * @since 0.0.0
 */
export const minLength = (regex: Regex): number => {
  switch (regex._tag) {
    case "Empty":
    case "Look":
      return 0
    case "Literal":
      return new TextEncoder().encode(regex.text).length
    case "Class":
      return 1
    case "Repeat":
      return regex.min * minLength(regex.sub)
    case "Capture":
      return minLength(regex.sub)
    case "Concat":
      return regex.subs.reduce((n, s) => n + minLength(s), 0)
    case "Alternate":
      return Math.min(...regex.subs.map(minLength))
  }
}

/**
 * A tree with numbered capture groups, and the groups' names by index.
 *
 * @since 0.0.0
 */
export interface Numbered {
  readonly regex: Regex
  readonly names: ReadonlyArray<string | undefined>
}

/**
 * Numbers the capture groups in the order their opening parentheses appear
 * (group 0 is the whole match), and returns the tree with the names of the
 * groups by index.
 *
 * @since 0.0.0
 */
export const numberCaptures = (regex: Regex): Numbered => {
  const names: Array<string | undefined> = [undefined]
  const go = (r: Regex): Regex => {
    switch (r._tag) {
      case "Capture": {
        const index = names.length
        names.push(r.name)
        return { ...r, index, sub: go(r.sub) }
      }
      case "Repeat":
        return { ...r, sub: go(r.sub) }
      case "Concat":
        return { _tag: "Concat", subs: r.subs.map(go) }
      case "Alternate":
        return { _tag: "Alternate", subs: r.subs.map(go) }
      default:
        return r
    }
  }
  return { regex: go(regex), names }
}

/**
 * Applies `f` to every class in the tree (used to remove the line
 * terminator from classes outside multiline mode).
 *
 * @since 0.0.0
 */
export const mapClasses = (regex: Regex, f: (set: Ranges) => Ranges): Regex => {
  switch (regex._tag) {
    case "Class":
      return { _tag: "Class", set: f(regex.set) }
    case "Repeat":
    case "Capture":
      return { ...regex, sub: mapClasses(regex.sub, f) }
    case "Concat":
      return { _tag: "Concat", subs: regex.subs.map((s) => mapClasses(s, f)) }
    case "Alternate":
      return { _tag: "Alternate", subs: regex.subs.map((s) => mapClasses(s, f)) }
    default:
      return regex
  }
}

/**
 * Whether any literal in the tree contains the given character.
 *
 * @since 0.0.0
 */
export const literalContains = (regex: Regex, char: string): boolean => {
  switch (regex._tag) {
    case "Literal":
      return regex.text.includes(char)
    case "Repeat":
    case "Capture":
      return literalContains(regex.sub, char)
    case "Concat":
    case "Alternate":
      return regex.subs.some((s) => literalContains(s, char))
    default:
      return false
  }
}
