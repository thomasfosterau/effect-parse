/**
 * Operator-precedence expression parsing with a Pratt parser (from
 * `nom-language`'s `precedence`, and winnow's expression parser).
 *
 * Describe the operand parser and a table of prefix, postfix and infix
 * operators with their precedence (higher binds tighter) and associativity.
 * Each operator carries a function that folds its operands into a result.
 *
 * @example
 * ```ts
 * import { Ascii, Expression, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const op = (s: string) => Parser.delimited(Ascii.space0, Token.literal(s), Ascii.space0)
 *
 * const arithmetic: Parser.Parser<number, string> = Expression.make({
 *   operand: Parser.alt(
 *     Ascii.decInt,
 *     Parser.delimited(op("("), Parser.suspend(() => arithmetic), op(")"))
 *   ),
 *   operators: [
 *     Expression.prefix(op("-"), 4, (_, x) => -x),
 *     Expression.postfix(op("!"), 5, (x) => factorial(x)),
 *     Expression.infixRight(op("^"), 3, (l, _, r) => l ** r),
 *     Expression.infixLeft(op("*"), 2, (l, _, r) => l * r),
 *     Expression.infixLeft(op("/"), 2, (l, _, r) => l / r),
 *     Expression.infixLeft(op("+"), 1, (l, _, r) => l + r),
 *     Expression.infixLeft(op("-"), 1, (l, _, r) => l - r)
 *   ]
 * })
 *
 * declare const factorial: (n: number) => number
 * Parser.parse(arithmetic, "1 + 2 * 3 ^ 2") // Result.succeed(19)
 * ```
 *
 * @since 0.1.0
 */
import * as Predicate from "effect/Predicate"
import type { Input, State } from "./Input.js"
import { Fail } from "./Input.js"
import type { Parser } from "./Parser.js"
import { make as makeParser } from "./Parser.js"
import { TiedFailures } from "./internal/ties.js"

/**
 * An operator in an expression grammar.
 *
 * @since 0.1.0
 * @category models
 */
export type Operator<A, E = never, R = never, I extends Input = string> =
  | Prefix<A, E, R, I>
  | Postfix<A, E, R, I>
  | Infix<A, E, R, I>

interface OperatorBase<E, R, I extends Input> {
  readonly parser: Parser<unknown, E, R, I>
  readonly precedence: number
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Prefix<A, E = never, R = never, I extends Input = string> extends OperatorBase<E, R, I> {
  readonly _tag: "Prefix"
  readonly fold: (op: any, operand: A) => A
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Postfix<A, E = never, R = never, I extends Input = string> extends OperatorBase<E, R, I> {
  readonly _tag: "Postfix"
  readonly fold: (operand: A, op: any) => A
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Infix<A, E = never, R = never, I extends Input = string> extends OperatorBase<E, R, I> {
  readonly _tag: "Infix"
  readonly associativity: "left" | "right"
  readonly fold: (left: A, op: any, right: A) => A
}

/**
 * A prefix operator, e.g. unary minus.
 *
 * @since 0.1.0
 * @category operators
 */
export const prefix = <O, E, R, I extends Input, A>(
  parser: Parser<O, E, R, I>,
  precedence: number,
  fold: (op: O, operand: A) => A
): Prefix<A, E, R, I> => ({ _tag: "Prefix", parser, precedence, fold })

/**
 * A postfix operator, e.g. factorial or a function call suffix.
 *
 * @since 0.1.0
 * @category operators
 */
export const postfix = <O, E, R, I extends Input, A>(
  parser: Parser<O, E, R, I>,
  precedence: number,
  fold: (operand: A, op: O) => A
): Postfix<A, E, R, I> => ({ _tag: "Postfix", parser, precedence, fold })

/**
 * A left-associative infix operator: `a - b - c` is `(a - b) - c`.
 *
 * @since 0.1.0
 * @category operators
 */
export const infixLeft = <O, E, R, I extends Input, A>(
  parser: Parser<O, E, R, I>,
  precedence: number,
  fold: (left: A, op: O, right: A) => A
): Infix<A, E, R, I> => ({ _tag: "Infix", associativity: "left", parser, precedence, fold })

/**
 * A right-associative infix operator: `a ^ b ^ c` is `a ^ (b ^ c)`.
 *
 * @since 0.1.0
 * @category operators
 */
export const infixRight = <O, E, R, I extends Input, A>(
  parser: Parser<O, E, R, I>,
  precedence: number,
  fold: (left: A, op: O, right: A) => A
): Infix<A, E, R, I> => ({ _tag: "Infix", associativity: "right", parser, precedence, fold })

type OpError<Op> = Op extends OperatorBase<infer E, infer _R, infer _I> ? E : never
type OpServices<Op> = Op extends OperatorBase<infer _E, infer R, infer _I> ? R : never
type OpInput<Op> = [Op] extends [never] ? Input : [Op] extends [OperatorBase<infer _E, infer _R, infer I>] ? I : never

/**
 * Builds an expression parser from an operand parser and an operator table.
 *
 * Precedences are compared numerically: higher binds tighter. A prefix
 * operator applies to everything that binds tighter than it, so with `-`
 * at precedence 4 and `^` at 3, `-2 ^ 2` parses as `(-2) ^ 2`.
 *
 * When several operators of the same kind match, the first one in the
 * table wins, so list longer operators (`<=`) before their prefixes (`<`).
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = <A, E, R, I extends Input, const Ops extends ReadonlyArray<Operator<A, any, any, any>>>(options: {
  readonly operand: Parser<A, E, R, I>
  readonly operators: Ops
}): Parser<A, E | OpError<Ops[number]>, R | OpServices<Ops[number]>, I & OpInput<Ops[number]>> => {
  const operand = options.operand.step
  const prefixes = options.operators.filter((o): o is Prefix<A, any, any, any> => Predicate.isTagged(o, "Prefix"))
  const postfixes = options.operators.filter((o): o is Postfix<A, any, any, any> => Predicate.isTagged(o, "Postfix"))
  const infixes = options.operators.filter((o): o is Infix<A, any, any, any> => Predicate.isTagged(o, "Infix"))

  // Attempts each operator in turn. Returns the index of the first match
  // (with its output in `matched`), -1 if none matched, or -2 on a fatal
  // failure. Failed attempts are folded into `failures`, merged only when
  // read (#44): a round in which an operator matches discards them unmerged.
  // Like `matched`, it is shared by nested expressions, which clear it.
  let matched: unknown
  const failures = new TiedFailures()
  const tryOps = (state: State<any>, ops: ReadonlyArray<OperatorBase<any, any, any>>, mustConsume: boolean): number => {
    const start = state.pos
    for (let i = 0; i < ops.length; i++) {
      const out = ops[i].parser.step(state)
      if (out !== Fail) {
        // A prefix or postfix operator matching nothing would apply forever
        if (mustConsume && state.pos === start) {
          state.failMessage("Cut", "Assert", "prefix and postfix operators must always consume")
          return -2
        }
        matched = out
        return i
      }
      if (state.mode !== "Backtrack") return -2
      state.pos = start
      failures.add(state)
    }
    return -1
  }

  const expr = (state: State<any>, minPower: number): A | Fail => {
    let lhs: A | Fail
    failures.clear()
    const p = tryOps(state, prefixes, true)
    if (p === -2) return Fail
    if (p >= 0) {
      const op = prefixes[p]
      const opOut = matched
      const operandValue = expr(state, op.precedence * 2)
      if (operandValue === Fail) return Fail
      lhs = op.fold(opOut, operandValue)
    } else {
      const prefixFailure = failures.failure
      const prefixTie1 = failures.tie1
      const prefixTie2 = failures.tie2
      lhs = operand(state)
      if (lhs === Fail) {
        if (prefixFailure !== undefined && state.mode === "Backtrack") {
          // The operand may have parsed nested expressions, which reuse `failures`
          failures.failure = prefixFailure
          failures.tie1 = prefixTie1
          failures.tie2 = prefixTie2
          failures.add(state)
          failures.fail(state)
        }
        return Fail
      }
    }

    while (true) {
      const start = state.pos
      failures.clear()
      const q = tryOps(state, postfixes, true)
      if (q === -2) return Fail
      if (q >= 0) {
        const op = postfixes[q]
        if (op.precedence * 2 < minPower) {
          state.pos = start
          break
        }
        lhs = op.fold(lhs, matched)
        continue
      }
      // The infix attempts are folded on top of the postfix ones
      const i = tryOps(state, infixes, false)
      if (i === -2) return Fail
      if (i < 0) {
        failures.hint(state)
        break
      }
      const op = infixes[i]
      const leftPower = op.precedence * 2
      if (leftPower < minPower) {
        state.pos = start
        break
      }
      const opOut = matched
      const rhs = expr(state, op.associativity === "left" ? leftPower + 1 : leftPower)
      if (rhs === Fail) return Fail
      lhs = op.fold(lhs, opOut, rhs)
    }
    return lhs
  }

  return makeParser((state: State<any>) => expr(state, 0), "expression")
}
