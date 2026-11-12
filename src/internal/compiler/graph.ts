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

/**
 * How many times each parser reachable from `root` is used: one for every
 * place a parent mentions it. A parser used twice is generated once, as a
 * rule the two places call (unless it is small, see {@link isSmall}).
 *
 * Uses are counted, not distinct parents: `seq(p, p)` uses `p` twice. When
 * only parents were counted, such a `p` was inlined at both places, and a
 * grammar that does it at every level (`p = seq(p, p)`, twenty times over)
 * compiled to 2^20 copies: 160 MB of source from twenty lines (#122).
 */
export const countRefs = (root: ParserLike): WeakMap<ParserLike, number> => {
  const refs = new WeakMap<ParserLike, number>()
  const seen = new WeakSet<ParserLike>()
  const stack = [root]
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    if (seen.has(p)) continue
    seen.add(p)
    for (const c of children(nodeOf(p))) {
      refs.set(c, (refs.get(c) ?? 0) + 1)
      stack.push(c)
    }
  }
  return refs
}

/**
 * The most parsers a code-generating compiler inlines for one root. Sharing
 * is what keeps generated code proportional to the grammar; a grammar that
 * is itself enormous (a tree of distinct parsers built by a loop, a derived
 * schema) would still take minutes and gigabytes to generate, so past this
 * many the compiler gives up and the next one down takes over (the JIT for
 * WebAssembly, the closure compiler for the JIT), which costs a closure per
 * parser instead of source text. The largest grammars in this repository
 * and the libraries built on it inline a few thousand.
 */
export const MaxInlined = 100_000

/** Counts a parser a compiler is about to inline, failing the compilation past {@link MaxInlined}. */
export const countInlined = (inlined: number): number => {
  if (inlined >= MaxInlined) {
    throw new RangeError(
      `effect-parse: the grammar is too large to generate code for (over ${MaxInlined} parsers inlined)`
    )
  }
  return inlined + 1
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
