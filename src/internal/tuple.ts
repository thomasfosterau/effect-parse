/**
 * Tuple steps: run steps in sequence and collect their outputs in an array.
 *
 * V8 pretenures by allocation site, and only array and object literals have
 * one: an array from `new Array(n)` starts young, so tuples that a parse keeps
 * (a `repeat(seq(...))`, a tree) are copied by a scavenge or two before they
 * are promoted. A literal's site learns that its arrays survive, and V8 then
 * allocates them straight into the old generation. So arities up to
 * {@link maxLiteral} build their tuple with a literal of that arity, each its
 * own site; longer tuples fall back to `new Array(n)` (#86).
 */
import { Fail } from "../Input.js"
import type { State } from "../Input.js"

type Step = (state: State<any>) => unknown

/** The longest tuple built with a literal. */
const maxLiteral = 8

/** A step that runs `steps` in order and returns their outputs as an array, or {@link Fail}. */
export const tupleStep = (steps: ReadonlyArray<Step>): ((state: State<any>) => Array<unknown> | Fail) => {
  const n = steps.length
  if (n <= maxLiteral) return literals[n](steps)
  return (state) => {
    const out = new Array<unknown>(n)
    for (let i = 0; i < n; i++) {
      const a = steps[i](state)
      if (a === Fail) return Fail
      out[i] = a
    }
    return out
  }
}

const literals: ReadonlyArray<(steps: ReadonlyArray<Step>) => (state: State<any>) => Array<unknown> | Fail> = [
  () => () => [],
  ([s0]) =>
    (state) => {
      const a0 = s0(state)
      if (a0 === Fail) return Fail
      return [a0]
    },
  ([s0, s1]) =>
    (state) => {
      const a0 = s0(state)
      if (a0 === Fail) return Fail
      const a1 = s1(state)
      if (a1 === Fail) return Fail
      return [a0, a1]
    },
  ([s0, s1, s2]) =>
    (state) => {
      const a0 = s0(state)
      if (a0 === Fail) return Fail
      const a1 = s1(state)
      if (a1 === Fail) return Fail
      const a2 = s2(state)
      if (a2 === Fail) return Fail
      return [a0, a1, a2]
    },
  ([s0, s1, s2, s3]) =>
    (state) => {
      const a0 = s0(state)
      if (a0 === Fail) return Fail
      const a1 = s1(state)
      if (a1 === Fail) return Fail
      const a2 = s2(state)
      if (a2 === Fail) return Fail
      const a3 = s3(state)
      if (a3 === Fail) return Fail
      return [a0, a1, a2, a3]
    },
  ([s0, s1, s2, s3, s4]) =>
    (state) => {
      const a0 = s0(state)
      if (a0 === Fail) return Fail
      const a1 = s1(state)
      if (a1 === Fail) return Fail
      const a2 = s2(state)
      if (a2 === Fail) return Fail
      const a3 = s3(state)
      if (a3 === Fail) return Fail
      const a4 = s4(state)
      if (a4 === Fail) return Fail
      return [a0, a1, a2, a3, a4]
    },
  ([s0, s1, s2, s3, s4, s5]) =>
    (state) => {
      const a0 = s0(state)
      if (a0 === Fail) return Fail
      const a1 = s1(state)
      if (a1 === Fail) return Fail
      const a2 = s2(state)
      if (a2 === Fail) return Fail
      const a3 = s3(state)
      if (a3 === Fail) return Fail
      const a4 = s4(state)
      if (a4 === Fail) return Fail
      const a5 = s5(state)
      if (a5 === Fail) return Fail
      return [a0, a1, a2, a3, a4, a5]
    },
  ([s0, s1, s2, s3, s4, s5, s6]) =>
    (state) => {
      const a0 = s0(state)
      if (a0 === Fail) return Fail
      const a1 = s1(state)
      if (a1 === Fail) return Fail
      const a2 = s2(state)
      if (a2 === Fail) return Fail
      const a3 = s3(state)
      if (a3 === Fail) return Fail
      const a4 = s4(state)
      if (a4 === Fail) return Fail
      const a5 = s5(state)
      if (a5 === Fail) return Fail
      const a6 = s6(state)
      if (a6 === Fail) return Fail
      return [a0, a1, a2, a3, a4, a5, a6]
    },
  ([s0, s1, s2, s3, s4, s5, s6, s7]) =>
    (state) => {
      const a0 = s0(state)
      if (a0 === Fail) return Fail
      const a1 = s1(state)
      if (a1 === Fail) return Fail
      const a2 = s2(state)
      if (a2 === Fail) return Fail
      const a3 = s3(state)
      if (a3 === Fail) return Fail
      const a4 = s4(state)
      if (a4 === Fail) return Fail
      const a5 = s5(state)
      if (a5 === Fail) return Fail
      const a6 = s6(state)
      if (a6 === Fail) return Fail
      const a7 = s7(state)
      if (a7 === Fail) return Fail
      return [a0, a1, a2, a3, a4, a5, a6, a7]
    }
]
