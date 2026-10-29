/**
 * Descriptions of parsers, recorded next to their steps so that parsers can
 * be compiled (see `docs/DESIGN.md`, "Compiled parsers").
 *
 * Nodes refer to their child parsers rather than to child nodes, so a
 * child's own step is always at hand for fallback, and recursion through
 * `Suspend` is just a reference.
 */
import * as Predicate from "effect/Predicate"
import type * as Option from "effect/Option"
import type * as Result from "effect/Result"
import type { Encoding } from "../Encoding.js"
import type { ErrMode, Input, State } from "../Input.js"

/** The parts of a parser the compiler needs. */
export interface ParserLike {
  readonly step: (state: State<any>) => unknown
  readonly name: string | undefined
}

type P = ParserLike
type Step = (state: State<any>) => unknown

/** A repetition range, normalized: `max` may be `Infinity`. */
interface Bounds {
  readonly min: number
  readonly max: number
}

/**
 * For token nodes: `undefined` for the `Token`/`Ascii` parsers (code points
 * of strings with lenient surrogates, bytes, or array elements), or the
 * encoding of a `Text` parser.
 */
type Enc = Encoding<any> | undefined

export type Node =
  // Constants
  | { readonly _tag: "Opaque"; readonly step: Step }
  | { readonly _tag: "Succeed"; readonly value: unknown }
  | { readonly _tag: "Sync"; readonly evaluate: () => unknown }
  | { readonly _tag: "Fail"; readonly mode: ErrMode }
  | { readonly _tag: "Eof" }
  | { readonly _tag: "Location" }
  | { readonly _tag: "Suspend"; readonly resolve: () => P }
  // Tokens
  | { readonly _tag: "Any"; readonly encoding: Enc }
  | { readonly _tag: "Literal"; readonly literal: Input; readonly caseless: boolean; readonly encoding: Enc }
  | { readonly _tag: "OneOf"; readonly set: unknown; readonly negate: boolean; readonly encoding: Enc }
  | { readonly _tag: "Take"; readonly count: number; readonly encoding: Enc }
  | ({ readonly _tag: "TakeWhile"; readonly set: unknown; readonly negate: boolean; readonly encoding: Enc } & Bounds)
  | ({ readonly _tag: "TakeUntil"; readonly literal: Input; readonly encoding: Enc } & Bounds)
  | { readonly _tag: "Rest"; readonly encoding: Enc }
  | { readonly _tag: "RestLen" }
  | { readonly _tag: "TillLineEnding"; readonly encoding: Enc }
  | { readonly _tag: "Identifier"; readonly encoding: Enc }
  | { readonly _tag: "Bom"; readonly encoding: Enc }
  | {
      readonly _tag: "Escaped"
      readonly normal: P
      /** The control character, as a code point (or a byte / unit for `Ascii`). */
      readonly control: number
      readonly escape: P
      /** `takeEscaped`: return the raw slice instead of the unescaped text. */
      readonly raw: boolean
      readonly encoding: Enc
    }
  // Mapping
  | { readonly _tag: "Map"; readonly self: P; readonly f: (a: any) => unknown }
  | { readonly _tag: "As"; readonly self: P; readonly value: unknown }
  | { readonly _tag: "Tap"; readonly self: P; readonly f: (a: any) => void }
  | { readonly _tag: "TryMap"; readonly self: P; readonly f: (a: any) => Result.Result<unknown, unknown> }
  | { readonly _tag: "FilterMap"; readonly self: P; readonly f: (a: any) => Option.Option<unknown> }
  | { readonly _tag: "Filter"; readonly self: P; readonly predicate: (a: any) => boolean }
  | { readonly _tag: "FlatMap"; readonly self: P; readonly f: (a: any) => P }
  // Consumed input
  | { readonly _tag: "Taken"; readonly self: P; readonly encoding: Enc }
  | { readonly _tag: "WithTaken"; readonly self: P }
  | { readonly _tag: "Span"; readonly self: P }
  | { readonly _tag: "WithSpan"; readonly self: P }
  // Errors
  | { readonly _tag: "Mode"; readonly self: P; readonly from: ErrMode; readonly to: ErrMode }
  | { readonly _tag: "Context"; readonly self: P; readonly label: string }
  | { readonly _tag: "Expected"; readonly self: P; readonly description: string }
  | { readonly _tag: "MapError"; readonly self: P }
  | { readonly _tag: "OrFail"; readonly self: P }
  // Control
  | { readonly _tag: "Opt"; readonly self: P }
  | { readonly _tag: "OrElseSucceed"; readonly self: P; readonly value: () => unknown }
  | { readonly _tag: "Peek"; readonly self: P }
  | { readonly _tag: "Not"; readonly self: P }
  // Sequencing
  | {
      readonly _tag: "Seq"
      readonly parsers: ReadonlyArray<P>
      /** Which outputs are kept: all (a tuple), one index, or a pair of indices. */
      readonly output: "tuple" | number | readonly [number, number]
    }
  | { readonly _tag: "Struct"; readonly keys: ReadonlyArray<string>; readonly parsers: ReadonlyArray<P> }
  | { readonly _tag: "ZipWith"; readonly self: P; readonly that: P; readonly f: (a: any, b: any) => unknown }
  // Choice
  | { readonly _tag: "Alt"; readonly parsers: ReadonlyArray<P> }
  | {
      readonly _tag: "Dispatch"
      readonly selector: P
      /** A record of cases, when `dispatch` was given one. */
      readonly cases: Readonly<Record<PropertyKey, P>> | undefined
      readonly otherwise: P | undefined
      readonly choose: (key: any) => P | undefined
    }
  // Repetition
  | ({ readonly _tag: "Repeat"; readonly self: P } & Bounds)
  | ({
      readonly _tag: "Fold"
      readonly self: P
      readonly init: () => unknown
      readonly f: (acc: any, a: any) => unknown
      /** Stops the repetition once false of the accumulator (after `min` elements). */
      readonly while: ((acc: any) => boolean) | undefined
      readonly name: string
    } & Bounds)
  | ({ readonly _tag: "RepeatTill"; readonly self: P; readonly end: P } & Bounds)
  | ({ readonly _tag: "Separated"; readonly self: P; readonly separator: P } & Bounds)
  | {
      readonly _tag: "SeparatedFold"
      readonly self: P
      readonly separator: P
      readonly op: (l: any, s: any, r: any) => unknown
      readonly right: boolean
    }
  // Services, recovery, debugging
  | { readonly _tag: "Service" }
  | { readonly _tag: "Provide"; readonly self: P }
  | { readonly _tag: "ResumeAfter"; readonly self: P; readonly recover: P }
  | { readonly _tag: "RetryAfter"; readonly self: P; readonly recover: P }
  | { readonly _tag: "Trace"; readonly self: P; readonly name: string }
  /** `Syntax.node`, `Syntax.token` and `Syntax.field`: identities outside `Syntax` parses. */
  | {
      readonly _tag: "Syntax"
      readonly self: P
      /** The node kind, or `undefined` for a field. */
      readonly kind: string | undefined
      readonly named: boolean
    }

export type Tag = Node["_tag"]

export type NodeOf<T extends Tag> = Extract<Node, { readonly _tag: T }>

/** Where a parser's description is stored. */
export const NodeId: unique symbol = /*#__PURE__*/ Symbol.for("effect-parse/Parser/node")

/** The description of a parser: `Opaque` when it has none. */
export const nodeOf = (p: ParserLike): Node => (p as any)[NodeId] ?? { _tag: "Opaque", step: p.step }

/** Normalizes a range, as `repeat`, `takeWhile`, ... do. */
export const bounds = (
  range: number | { readonly min?: number | undefined; readonly max?: number | undefined } | undefined
): Bounds => {
  if (range === undefined) return { min: 0, max: Infinity }
  if (Predicate.isNumber(range)) return { min: range, max: range }
  return { min: range.min ?? 0, max: range.max ?? Infinity }
}

/** The child parsers of a node, in evaluation order. */
export const children = (node: Node): ReadonlyArray<P> => {
  switch (node._tag) {
    case "Escaped":
      return [node.normal, node.escape]
    case "Map":
    case "As":
    case "Tap":
    case "TryMap":
    case "FilterMap":
    case "Filter":
    case "FlatMap":
    case "Taken":
    case "WithTaken":
    case "Span":
    case "WithSpan":
    case "Mode":
    case "Context":
    case "Expected":
    case "MapError":
    case "OrFail":
    case "Opt":
    case "OrElseSucceed":
    case "Peek":
    case "Not":
    case "Repeat":
    case "Fold":
    case "Provide":
    case "Trace":
    case "Syntax":
      return [node.self]
    case "ResumeAfter":
    case "RetryAfter":
      return [node.self, node.recover]
    case "Seq":
    case "Struct":
    case "Alt":
      return node.parsers
    case "ZipWith":
      return [node.self, node.that]
    case "Dispatch": {
      const out: Array<P> = [node.selector]
      if (node.cases !== undefined) {
        for (const key of Reflect.ownKeys(node.cases)) out.push(node.cases[key as any])
      }
      if (node.otherwise !== undefined) out.push(node.otherwise)
      return out
    }
    case "RepeatTill":
      return [node.self, node.end]
    case "Separated":
    case "SeparatedFold":
      return [node.self, node.separator]
    case "Suspend":
      return [node.resolve()]
    default:
      return []
  }
}
