/**
 * The shapes of `map(p, Object.fromEntries)` that the compilers build
 * directly (see `internal/entries.ts`).
 */
import type { Node, NodeOf, ParserLike } from "../node.js"
import { nodeOf } from "../node.js"

/** A repeated pair for `Object.fromEntries`: the sequence and the indices of its key and value. */
export const pairOf = (
  p: ParserLike
): { readonly parsers: ReadonlyArray<ParserLike>; readonly key: number; readonly value: number } | undefined => {
  let node = nodeOf(p)
  while (isDiagnostic(node)) node = nodeOf(node.self)
  if (node._tag !== "Seq") return undefined
  const output = node.output
  if (output === "tuple") return node.parsers.length === 2 ? { parsers: node.parsers, key: 0, value: 1 } : undefined
  if (typeof output === "number" || output[0] === output[1]) return undefined
  return { parsers: node.parsers, key: output[0], value: output[1] }
}

const isDiagnostic = (
  node: Node
): node is NodeOf<"Context" | "Expected" | "MapError" | "OrFail" | "Trace" | "Syntax" | "RetryAfter"> =>
  node._tag === "Context" ||
  node._tag === "Expected" ||
  node._tag === "MapError" ||
  node._tag === "OrFail" ||
  node._tag === "Trace" ||
  node._tag === "Syntax" ||
  node._tag === "RetryAfter"

/**
 * Whether `map(p, Object.fromEntries)` can build its object directly: `p`
 * is a `repeat` or `separated` of a pair, possibly inside `cut`, the kept
 * element of a sequence (`preceded`, `terminated`, `delimited`) and
 * diagnostics.
 */
export const entriesShape = (p: ParserLike): boolean => {
  const node = nodeOf(p)
  if (isDiagnostic(node) || node._tag === "Mode") return entriesShape(node.self)
  if (node._tag === "Seq") return typeof node.output === "number" && entriesShape(node.parsers[node.output]!)
  return (node._tag === "Repeat" || node._tag === "Separated") && pairOf(node.self) !== undefined
}
