/**
 * S-expressions with a small evaluator, after winnow's
 * `examples/s_expression`.
 *
 * Shows typed user errors: evaluation failures are raised with
 * `Parser.fail` / `Parser.tryMap` and surface as the `cause` of the
 * `ParseError`, typed in the parser's `E` channel.
 */
import * as Arr from "effect/Array"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Result from "effect/Result"
import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"

export type Atom =
  | { readonly _tag: "Num"; readonly value: number }
  | { readonly _tag: "Bool"; readonly value: boolean }
  | { readonly _tag: "Keyword"; readonly name: string }
  | { readonly _tag: "BuiltIn"; readonly op: "+" | "-" | "*" | "/" | "=" | "not" }

export type Expr =
  | { readonly _tag: "Constant"; readonly atom: Atom }
  | { readonly _tag: "Application"; readonly head: Expr; readonly args: ReadonlyArray<Expr> }
  | { readonly _tag: "If"; readonly cond: Expr; readonly consequent: Expr; readonly alternative: Expr | undefined }
  | { readonly _tag: "Quote"; readonly exprs: ReadonlyArray<Expr> }

export class EvalError extends Schema.TaggedError<EvalError, { readonly brand: unique symbol }>()("EvalError", {
  message: Schema.String
}) {}

const ws = Ascii.multispace0

const builtin = Parser.alt(Token.literal("not"), Token.oneOf("+-*/=")).pipe(
  Parser.map((op): Atom => ({ _tag: "BuiltIn", op: op as "+" }))
)

const bool = Parser.alt(Token.literal("#t").pipe(Parser.as(true)), Token.literal("#f").pipe(Parser.as(false))).pipe(
  Parser.map((value): Atom => ({ _tag: "Bool", value }))
)

const keyword = Parser.preceded(Token.literal(":"), Parser.cut(Ascii.alpha1)).pipe(
  Parser.map((name): Atom => ({ _tag: "Keyword", name }))
)

const num = Ascii.decInt.pipe(Parser.map((value): Atom => ({ _tag: "Num", value })))

const atom = Parser.alt(num, bool, builtin, keyword).pipe(Parser.map((atom): Expr => ({ _tag: "Constant", atom })))

const sExp = <A, E>(inner: Parser.Parser<A, E>) =>
  Parser.delimited(
    Token.literal("("),
    Parser.preceded(ws, inner),
    Parser.cut(Parser.preceded(ws, Token.literal(")")))
  ).pipe(Parser.context("s-expression"))

const exprRef: Parser.Parser<Expr, string> = Parser.suspend(() => expr)

const application = sExp(Parser.seq(exprRef, Parser.repeat(Parser.preceded(ws, exprRef)))).pipe(
  Parser.map(([head, args]): Expr => ({ _tag: "Application", head, args }))
)

const ifExpr = sExp(
  Parser.gen(function* () {
    yield* Token.literal("if")
    yield* Ascii.multispace1
    const cond = yield* exprRef
    yield* ws
    const consequent = yield* exprRef
    yield* ws
    const alternative = yield* Parser.optional(exprRef)
    return { _tag: "If", cond, consequent, alternative } satisfies Expr as Expr
  })
)

const quote = Parser.preceded(Token.literal("'"), Parser.cut(sExp(Parser.repeat(Parser.terminated(exprRef, ws))))).pipe(
  Parser.map((exprs): Expr => ({ _tag: "Quote", exprs }))
)

export const expr: Parser.Parser<Expr, string> = Parser.preceded(ws, Parser.alt(atom, ifExpr, application, quote))

const fail = (message: string) => Result.fail(new EvalError({ message }))

/** Evaluates an expression to an atom. */
export const evaluate = (e: Expr): Result.Result<Atom, EvalError> => {
  switch (e._tag) {
    case "Constant":
      return Result.succeed(e.atom)
    case "Quote":
      return fail("cannot evaluate a quoted list")
    case "If": {
      const cond = evaluate(e.cond)
      if (Result.isFailure(cond)) return cond
      if (cond.success._tag !== "Bool") return fail("`if` expects a boolean condition")
      if (cond.success.value) return evaluate(e.consequent)
      return e.alternative === undefined ? fail("`if` without else") : evaluate(e.alternative)
    }
    case "Application": {
      const head = evaluate(e.head)
      if (Result.isFailure(head)) return head
      if (head.success._tag !== "BuiltIn") return fail("only built-in functions can be applied")
      // Left to right, stopping at the first argument that fails or is not a value
      const evaluated = e.args.reduce<Result.Result<Array<number | boolean>, EvalError>>((acc, arg) => {
        if (Result.isFailure(acc)) return acc
        const r = evaluate(arg)
        if (Result.isFailure(r)) return Result.fail(r.failure)
        if (r.success._tag !== "Num" && r.success._tag !== "Bool") return fail("invalid argument")
        acc.success.push(r.success.value)
        return acc
      }, Result.succeed([]))
      if (Result.isFailure(evaluated)) return Result.fail(evaluated.failure)
      const args = evaluated.success
      const nums = () => (args.every((a) => Predicate.isNumber(a)) ? (args as Array<number>) : undefined)
      const op = head.success.op
      switch (op) {
        case "+":
        case "*": {
          const ns = nums()
          if (ns === undefined) return fail("arithmetic on non-numbers")
          const value = op === "+" ? ns.reduce((a, b) => a + b, 0) : ns.reduce((a, b) => a * b, 1)
          return Result.succeed({ _tag: "Num", value })
        }
        case "-":
        case "/": {
          const ns = nums()
          if (ns === undefined || !Arr.isArrayNonEmpty(ns)) return fail("arithmetic on non-numbers")
          const [first, ...rest] = ns
          if (op === "/" && rest.includes(0)) return fail("division by zero")
          const value = Arr.isArrayEmpty(rest)
            ? op === "-"
              ? -first
              : 1 / first
            : rest.reduce((a, b) => (op === "-" ? a - b : Math.trunc(a / b)), first)
          return Result.succeed({ _tag: "Num", value })
        }
        case "=":
          return Result.succeed({ _tag: "Bool", value: args.every((a) => a === args[0]) })
        case "not":
          return args.length === 1 && Predicate.isBoolean(args[0])
            ? Result.succeed({ _tag: "Bool", value: !args[0] })
            : fail("`not` expects one boolean")
      }
    }
  }
}

/** Parses and evaluates; evaluation errors are typed failures of the parser. */
export const program: Parser.Parser<Atom, string | EvalError> = Parser.terminated(expr, ws).pipe(
  Parser.tryMap(evaluate)
)
