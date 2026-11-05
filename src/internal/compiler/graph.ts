/**
 * The shape of a grammar, as the code-generating compilers (the JIT and the
 * WebAssembly compiler) see it: which parsers are leaves, which are shared
 * and which are small enough to inline everywhere.
 */
import * as Predicate from "effect/Predicate"
import type { Node, ParserLike } from "../node.js"
import { children, nodeOf } from "../node.js"

/** Whether a node is a token or a constant, always generated inline. */
export const isLeaf = (node: Node): boolean =>
  Predicate.isTagged(node, "Succeed") ||
  Predicate.isTagged(node, "Fail") ||
  Predicate.isTagged(node, "Eof") ||
  Predicate.isTagged(node, "Location") ||
  Predicate.isTagged(node, "RestLen") ||
  Predicate.isTagged(node, "Any") ||
  Predicate.isTagged(node, "Literal") ||
  Predicate.isTagged(node, "OneOf") ||
  Predicate.isTagged(node, "TakeWhile")

/** The number of distinct parents of each parser reachable from `root`. */
export const countRefs = (root: ParserLike): WeakMap<ParserLike, number> => {
  const refs = new WeakMap<ParserLike, number>()
  const seen = new WeakSet<ParserLike>()
  const stack = [root]
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    if (seen.has(p)) continue
    seen.add(p)
    const counted = new WeakSet<ParserLike>()
    for (const c of children(nodeOf(p))) {
      if (counted.has(c)) continue
      counted.add(c)
      refs.set(c, (refs.get(c) ?? 0) + 1)
      stack.push(c)
    }
  }
  return refs
}

/** Whether a parser is small enough to inline wherever it is used. */
export const isSmall = (p: ParserLike): boolean => {
  let budget = 6
  const visit = (q: ParserLike): boolean => {
    const node = nodeOf(q)
    if (
      --budget < 0 ||
      Predicate.isTagged(node, "Suspend") ||
      Predicate.isTagged(node, "Escaped") ||
      Predicate.isTagged(node, "Dispatch")
    )
      return false
    return children(node).every(visit)
  }
  return visit(p)
}

/** The node a `dispatch` selects on, and whether it is looked at with `peek`. */
export const selectorOf = (selector: ParserLike): { readonly node: Node; readonly peek: boolean } => {
  const node = nodeOf(selector)
  return Predicate.isTagged(node, "Peek") ? { node: nodeOf(node.self), peek: true } : { node, peek: false }
}

/** ASCII lower case. */
export const lowerAscii = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c)

/** Whether a code is an ASCII letter. */
export const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
