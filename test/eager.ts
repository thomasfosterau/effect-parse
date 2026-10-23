/**
 * Reference implementations of combinators that merge tied failures lazily
 * (#38, #44): the eager algorithms they replaced, merging every failure as it
 * happens. A lazy combinator must report exactly what its eager reference
 * does: the same failure, furthest failure and hint.
 */
import * as Predicate from "effect/Predicate"
import type { Expression } from "../src/index.js"
import { Input, Parser } from "../src/index.js"

type Any = Parser.Parser<unknown, unknown>

/** `Parser.permutation` as it was before #44. */
export const eagerPermutation = (...ps: ReadonlyArray<Any>): Any =>
  Parser.make((state) => {
    const out: Array<unknown> = ps.map(() => undefined)
    const done = ps.map(() => false)
    const round = (remaining: number): unknown => {
      if (remaining === 0) return out
      const attempt = (i: number, failure: Input.Failure | undefined): unknown => {
        if (i === ps.length) return state.failWith("Backtrack", failure ?? state.failure)
        if (done[i]) return attempt(i + 1, failure)
        const start = state.pos
        const a = ps[i].step(state)
        if (a !== Input.Fail) {
          out[i] = a
          done[i] = true
          return round(remaining - 1)
        }
        if (state.mode !== "Backtrack") return Input.Fail
        const merged = failure === undefined ? state.failure : Input.mergeFailures(failure, state.failure)
        state.pos = start
        return attempt(i + 1, merged)
      }
      return attempt(0, undefined)
    }
    return round(ps.length)
  })

type Op = Expression.Operator<unknown, unknown>
type Prefix = Expression.Prefix<unknown, unknown>
type Postfix = Expression.Postfix<unknown, unknown>
type Infix = Expression.Infix<unknown, unknown>

/** `Expression.make` as it was before #44, its loops written as recursion. */
export const eagerExpression = (options: { readonly operand: Any; readonly operators: ReadonlyArray<Op> }): Any => {
  const operand = options.operand.step
  const prefixes = options.operators.filter((o): o is Prefix => Predicate.isTagged(o, "Prefix"))
  const postfixes = options.operators.filter((o): o is Postfix => Predicate.isTagged(o, "Postfix"))
  const infixes = options.operators.filter((o): o is Infix => Predicate.isTagged(o, "Infix"))

  // Shared by every nested call, as in the original
  let matched: unknown
  let failure: Input.Failure | undefined
  const tryOps = (state: Input.State<string>, ops: ReadonlyArray<Op>, mustConsume: boolean): number => {
    const start = state.pos
    const go = (i: number): number => {
      if (i === ops.length) return -1
      const out = ops[i].parser.step(state)
      if (out !== Input.Fail) {
        if (mustConsume && state.pos === start) {
          state.failMessage("Cut", "Assert", "prefix and postfix operators must always consume")
          return -2
        }
        matched = out
        return i
      }
      if (state.mode !== "Backtrack") return -2
      failure = failure === undefined ? state.failure : Input.mergeFailures(failure, state.failure)
      state.pos = start
      return go(i + 1)
    }
    return go(0)
  }

  const expr = (state: Input.State<string>, minPower: number): unknown => {
    failure = undefined
    const p = tryOps(state, prefixes, true)
    if (p === -2) return Input.Fail
    let first: unknown
    if (p >= 0) {
      const op = prefixes[p]
      const opOut = matched
      const operandValue = expr(state, op.precedence * 2)
      if (operandValue === Input.Fail) return Input.Fail
      first = op.fold(opOut, operandValue)
    } else {
      const prefixFailure = failure
      first = operand(state)
      if (first === Input.Fail) {
        if (prefixFailure !== undefined && state.mode === "Backtrack") {
          state.failWith("Backtrack", Input.mergeFailures(prefixFailure, state.failure))
        }
        return Input.Fail
      }
    }
    const loop = (lhs: unknown): unknown => {
      const start = state.pos
      failure = undefined
      const q = tryOps(state, postfixes, true)
      if (q === -2) return Input.Fail
      if (q >= 0) {
        const op = postfixes[q]
        if (op.precedence * 2 < minPower) {
          state.pos = start
          return lhs
        }
        return loop(op.fold(lhs, matched))
      }
      const postfixFailure = failure
      const i = tryOps(state, infixes, false)
      if (i === -2) return Input.Fail
      if (i < 0) {
        const f =
          postfixFailure === undefined
            ? failure
            : failure === undefined
              ? postfixFailure
              : Input.mergeFailures(postfixFailure, failure)
        if (f !== undefined && f.offset === state.pos) state.setHint(f.offset, f.expected)
        return lhs
      }
      const op = infixes[i]
      const leftPower = op.precedence * 2
      if (leftPower < minPower) {
        state.pos = start
        return lhs
      }
      const opOut = matched
      const rhs = expr(state, op.associativity === "left" ? leftPower + 1 : leftPower)
      if (rhs === Input.Fail) return Input.Fail
      return loop(op.fold(lhs, opOut, rhs))
    }
    return loop(first)
  }

  return Parser.make((state) => expr(state, 0))
}
