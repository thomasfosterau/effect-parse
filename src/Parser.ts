/**
 * The `Parser` data type and its general-purpose combinators.
 *
 * A `Parser<A, E, R, I>` consumes input of type `I` and produces a value of
 * type `A`. It may fail with a `ParseError<E>`, where `E` is the type of
 * user supplied error causes, and it may require services `R` from an Effect
 * `Context`.
 *
 * Under the hood a parser is a function over a mutable cursor (`Input.State`),
 * as in winnow. Failure is cheap and backtracking is a matter of resetting an
 * offset. On the surface the API follows Effect's conventions: parsers are
 * pipeable, combinators are dual (data-first or data-last), and parsers can
 * be written with generators:
 *
 * ```ts
 * import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const point = Parser.gen(function*() {
 *   yield* Token.literal("(")
 *   const x = yield* Ascii.decInt
 *   yield* Token.literal(",")
 *   const y = yield* Ascii.decInt
 *   yield* Token.literal(")")
 *   return { x, y }
 * })
 *
 * Parser.parse(point, "(1,-2)") // Result.succeed({ x: 1, y: -2 })
 * ```
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import { NodeInspectSymbol } from "effect/Inspectable"
import * as Option from "effect/Option"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import * as Result from "effect/Result"
import type { Contravariant, Covariant, Simplify } from "effect/Types"
import type { ErrMode, Input, Slice, Source, TraceEvent } from "./Input.js"
import { Fail, Failure, mergeExpected, mergeFailures, State } from "./Input.js"
import type { ErrorKind } from "./ParseError.js"
import * as ParseError from "./ParseError.js"
import * as Registry from "./internal/compiler/registry.js"
import * as Entries from "./internal/entries.js"
import * as Resume from "./internal/resume.js"
import * as Stack from "./internal/stack.js"
import type { Node } from "./internal/node.js"
import { bounds, NodeId } from "./internal/node.js"

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category type ids
 */
export const TypeId: "~effect-parse/Parser" = "~effect-parse/Parser"

/**
 * A parser that consumes input of type `I`, producing a value of type `A`,
 * possibly failing with a user cause of type `E`, and requiring services `R`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Parser<out A, out E = never, out R = never, in I extends Input = string> extends Pipeable {
  readonly [TypeId]: Parser.Variance<A, E, R, I>
  /**
   * Runs one parsing step against a cursor. Returns the parsed value, or the
   * `Fail` sentinel after recording the failure on the state.
   *
   * Calling `step` directly is how custom combinators built with
   * {@link make} invoke other parsers.
   */
  readonly step: (state: State<I>) => A | Fail
  /** A human-readable name, used by `toString` and tracing. */
  readonly name: string | undefined
  [Symbol.iterator](): ParserIterator<Parser<A, E, R, I>>
}

/**
 * The iterator used by `yield*` inside {@link gen}.
 *
 * @since 0.1.0
 * @category models
 */
export interface ParserIterator<P extends Parser.Any> {
  next(...args: ReadonlyArray<any>): IteratorResult<P, Parser.Success<P>>
}

/**
 * @since 0.1.0
 * @category models
 */
export declare namespace Parser {
  /**
   * @since 0.1.0
   */
  export interface Variance<A, E, R, I> {
    readonly _A: Covariant<A>
    readonly _E: Covariant<E>
    readonly _R: Covariant<R>
    readonly _I: Contravariant<I>
  }
  /**
   * Any parser.
   *
   * @since 0.1.0
   */
  export type Any = Parser<any, any, any, any>
  /**
   * The output type of a parser.
   *
   * @since 0.1.0
   */
  export type Success<P> = P extends Parser<infer A, infer _E, infer _R, infer _I> ? A : never
  /**
   * The user error type of a parser.
   *
   * @since 0.1.0
   */
  export type Error<P> = P extends Parser<infer _A, infer E, infer _R, infer _I> ? E : never
  /**
   * The services required by a parser.
   *
   * @since 0.1.0
   */
  export type Services<P> = P extends Parser<infer _A, infer _E, infer R, infer _I> ? R : never
  /**
   * The input accepted by a parser (or by every member of a union of
   * parsers).
   *
   * @since 0.1.0
   */
  export type InputOf<P> = [P] extends [never]
    ? Input
    : [P] extends [Parser<infer _A, infer _E, infer _R, infer I>]
      ? I
      : never
}

/**
 * A repetition range, in the spirit of winnow's `impl Into<Range>`:
 *
 * - `n`: exactly `n` times
 * - `{ min, max }`: between `min` and `max` times (inclusive); `min`
 *   defaults to 0 and `max` to unbounded.
 *
 * @since 0.1.0
 * @category models
 */
export type Range = number | { readonly min?: number | undefined; readonly max?: number | undefined }

/**
 * The output of a repetition: a non-empty array when the range has a literal
 * positive minimum.
 *
 * @since 0.1.0
 * @category models
 */
export type Repeated<A, Rg> = Rg extends number
  ? number extends Rg
    ? Array<A>
    : Rg extends 0
      ? Array<A>
      : NonEmpty<A>
  : Rg extends { readonly min: infer M extends number }
    ? number extends M
      ? Array<A>
      : M extends 0
        ? Array<A>
        : NonEmpty<A>
    : Array<A>

type NonEmpty<A> = [A, ...Array<A>]

/**
 * A span of input offsets, `[start, end)`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Span {
  readonly start: number
  readonly end: number
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

const variance: Parser.Variance<never, never, never, unknown> = {
  _A: (_) => _,
  _E: (_) => _,
  _R: (_) => _,
  _I: (_) => {}
}

class SingleShotGen<T> {
  private called = false
  constructor(readonly self: T) {}
  next(a: any): IteratorResult<T, any> {
    if (this.called) return { value: a, done: true }
    this.called = true
    return { value: this.self, done: false }
  }
  return(a: any): IteratorResult<T, any> {
    return { value: a, done: true }
  }
  throw(e: unknown): never {
    throw e
  }
  [Symbol.iterator](): SingleShotGen<T> {
    return new SingleShotGen(this.self)
  }
}

class ParserImpl<A, E, R, I extends Input> implements Parser<A, E, R, I> {
  readonly [TypeId] = variance as Parser.Variance<A, E, R, I>
  /** The description used by the compiler; `undefined` for `Opaque`. */
  readonly [NodeId]: Node | undefined
  constructor(
    readonly step: (state: State<I>) => A | Fail,
    readonly name: string | undefined,
    node: Node | undefined
  ) {
    this[NodeId] = node
  }
  pipe() {
    return pipeArguments(this, arguments)
  }
  [Symbol.iterator](): ParserIterator<Parser<A, E, R, I>> {
    return new SingleShotGen(this) as any
  }
  toString() {
    return this.name === undefined ? "Parser" : `Parser(${this.name})`
  }
  toJSON() {
    return { _id: "Parser", name: this.name }
  }
  [NodeInspectSymbol]() {
    return this.toJSON()
  }
}

/**
 * Tests whether a value is a `Parser`.
 *
 * @since 0.1.0
 * @category guards
 */
export const isParser = (u: unknown): u is Parser<unknown, unknown, unknown, never> =>
  typeof u === "object" && u !== null && TypeId in u

const isParserArg = (args: IArguments) => isParser(args[0])
const isTwoParserArgs = (args: IArguments) => isParser(args[0]) && isParser(args[1])

// -----------------------------------------------------------------------------
// Constructors
// -----------------------------------------------------------------------------

/**
 * Creates a parser from a step function over the mutable {@link State}
 * cursor. This is the escape hatch for writing low-level parsers, much like
 * passing a plain function as a parser in winnow.
 *
 * The step function must either return the parsed value, having advanced
 * `state.pos` past the consumed input, or return the result of one of
 * `state.backtrack`, `state.cut`, `state.incomplete`, ... to signal failure.
 *
 * @example
 * ```ts
 * import { Parser } from "@thomasfosterau/effect-parse"
 *
 * // Parses a single ASCII uppercase letter
 * const upper = Parser.make<string>((state) => {
 *   const c = state.input.charCodeAt(state.pos)
 *   if (state.pos < state.end && c >= 65 && c <= 90) {
 *     state.pos++
 *     return String.fromCharCode(c)
 *   }
 *   return state.pos >= state.end
 *     ? state.eoi("Token", ["uppercase letter"], 1)
 *     : state.backtrack("Token", ["uppercase letter"])
 * })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = <A, E = never, R = never, I extends Input = string>(
  step: (state: State<I>) => A | Fail,
  name?: string
): Parser<A, E, R, I> => new ParserImpl(step, name, undefined)

/**
 * Creates a parser together with its description, used by the compiler.
 *
 * @internal
 */
export const described = <A, E = never, R = never, I extends Input = string>(
  step: (state: State<I>) => A | Fail,
  name: string | undefined,
  node: Node
): Parser<A, E, R, I> => new ParserImpl(step, name, node)

const nodeOfParser = (p: Parser.Any): Node | undefined => (p as any)[NodeId]

/**
 * Gives a parser a name, used by `toString`.
 *
 * @since 0.1.0
 * @category utils
 */
export const named: {
  (name: string): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E, R, I>
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, name: string): Parser<A, E, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, name: string): Parser<A, E, R, I> =>
    new ParserImpl(self.step, name, nodeOfParser(self))
)

/**
 * A parser that consumes nothing and succeeds with the given value.
 *
 * @since 0.1.0
 * @category constructors
 */
export const succeed = <A>(value: A): Parser<A, never, never, Input> =>
  described(() => value, "succeed", { _tag: "Succeed", value })

/**
 * A parser that consumes nothing and succeeds with the result of a thunk.
 *
 * @since 0.1.0
 * @category constructors
 */
export const sync = <A>(evaluate: () => A): Parser<A, never, never, Input> =>
  described(() => evaluate(), "sync", { _tag: "Sync", evaluate })

/**
 * A parser that consumes nothing and succeeds with `undefined` (winnow's
 * `empty`, nom's `success(())`).
 *
 * @since 0.1.0
 * @category constructors
 */
export const empty: Parser<void, never, never, Input> = /*#__PURE__*/ described(() => undefined, "empty", {
  _tag: "Succeed",
  value: undefined
})

/**
 * Alias of {@link empty}, following Effect's `Effect.void`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const void_: Parser<void, never, never, Input> = empty

export {
  /**
   * @since 0.1.0
   * @category constructors
   */
  void_ as void
}

/**
 * A parser that always fails (backtracks) with the given user error as its
 * cause.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fail = <E>(error: E): Parser<never, E, never, Input> =>
  described<never, E, never, Input>((state) => state.failCause("Backtrack", "Fail", error), "fail", failBacktrack)

const failBacktrack: Node = { _tag: "Fail", mode: "Backtrack" }

/**
 * A parser that always fails (backtracks) without a cause. This is winnow's
 * `fail` and nom's `fail()`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const reject: Parser<never, never, never, Input> = /*#__PURE__*/ described<never, never, never, Input>(
  (state) => state.backtrack("Fail"),
  "reject",
  failBacktrack
)

/**
 * A parser that always fails with a message.
 *
 * @since 0.1.0
 * @category constructors
 */
export const failMessage = (message: string): Parser<never, never, never, Input> =>
  described<never, never, never, Input>(
    (state) => state.failMessage("Backtrack", "Fail", message),
    "failMessage",
    failBacktrack
  )

/**
 * A placeholder parser that fails with an unrecoverable error (winnow's
 * `todo`).
 *
 * @since 0.1.0
 * @category constructors
 */
export const todo: Parser<never, never, never, Input> = /*#__PURE__*/ described<never, never, never, Input>(
  (state) => state.failMessage("Cut", "Assert", "`todo` parser reached"),
  "todo",
  { _tag: "Fail", mode: "Cut" }
)

/**
 * Lazily constructs a parser, which is needed to define recursive grammars.
 * The thunk is evaluated once, on first use.
 *
 * Each level of recursion uses some of the call stack, interpreted or
 * compiled, so input nested a few thousand levels deep exhausts it. The
 * runners catch the overflow and fail with an unrecoverable `ParseError` of
 * kind `"TooDeep"` at the offset reached, instead of throwing.
 *
 * @example
 * ```ts
 * import { Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * type Nested = ReadonlyArray<Nested>
 * const nested: Parser.Parser<Nested> = Parser.delimited(
 *   Token.literal("["),
 *   Parser.repeat(Parser.suspend(() => nested)),
 *   Token.literal("]")
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const suspend = <A, E = never, R = never, I extends Input = string>(
  evaluate: () => Parser<A, E, R, I>
): Parser<A, E, R, I> => {
  let parser: Parser<A, E, R, I> | undefined
  return described((state) => (parser ??= evaluate()).step(state), "suspend", {
    _tag: "Suspend",
    resolve: () => (parser ??= evaluate())
  })
}

/**
 * The current offset into the input (winnow's `Location`).
 *
 * @since 0.1.0
 * @category constructors
 */
export const location: Parser<number, never, never, Input> = /*#__PURE__*/ described((state) => state.pos, "location", {
  _tag: "Location"
})

/**
 * Succeeds (with `undefined`) only at the end of the input; nom's and
 * winnow's `eof`. On partial input, reaching the end of the available data
 * is reported as `Incomplete` since more data may follow.
 *
 * @since 0.1.0
 * @category constructors
 */
export const eof: Parser<void, never, never, Input> = /*#__PURE__*/ described(
  (state) => {
    if (state.pos < state.end) return state.backtrack("Eof", expectedEof)
    if (state.partial) return state.incomplete(1, expectedEof)
    return undefined
  },
  "eof",
  { _tag: "Eof" }
)

const expectedEof = ["end of input"]

// -----------------------------------------------------------------------------
// Mapping
// -----------------------------------------------------------------------------

/**
 * Transforms the output of a parser.
 *
 * @since 0.1.0
 * @category mapping
 */
export const map: {
  <A, B>(f: (a: A) => B): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<B, E, R, I>
  <A, E, R, I extends Input, B>(self: Parser<A, E, R, I>, f: (a: A) => B): Parser<B, E, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B>(self: Parser<A, E, R, I>, f: (a: A) => B): Parser<B, E, R, I> => {
    const step = self.step
    return described(
      (state) => {
        const a = step(state)
        return a === Fail ? Fail : f(a)
      },
      self.name,
      { _tag: "Map", self, f }
    )
  }
)

/**
 * Builds an object from the `[key, value]` entries a parser returns, as
 * `Object.fromEntries` does: `fromEntries(self)` is
 * `map(self, Object.fromEntries)`.
 *
 * Compiled parsers build the object directly when `self` repeats a pair
 * (`separated` or `repeat` of `separatedPair` or a two-element `seq`,
 * possibly inside `preceded`, `terminated`, `delimited` or `cut`), without
 * the pairs and the array. They do the same for `map(Object.fromEntries)`.
 *
 * @example
 * ```ts
 * import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const entry = Parser.separatedPair(Ascii.alpha1, Token.literal("="), Ascii.decUint)
 * const record = Parser.fromEntries(Parser.separated(entry, Token.literal(",")))
 * Parser.parse(record, "a=1,b=2") // Result.succeed({ a: 1, b: 2 })
 * ```
 *
 * @since 0.2.0
 * @category mapping
 */
export const fromEntries = <K extends PropertyKey, V, E, R, I extends Input>(
  self: Parser<Iterable<readonly [K, V]>, E, R, I>
): Parser<{ [P in K]: V }, E, R, I> => map(self, Entries.fromEntries)

/**
 * Replaces the output of a parser with a constant (winnow's `value`, nom's
 * `value`).
 *
 * @since 0.1.0
 * @category mapping
 */
export const as: {
  <B>(value: B): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<B, E, R, I>
  <A, E, R, I extends Input, B>(self: Parser<A, E, R, I>, value: B): Parser<B, E, R, I>
} = /*#__PURE__*/ dual(2, <A, E, R, I extends Input, B>(self: Parser<A, E, R, I>, value: B): Parser<B, E, R, I> => {
  const step = self.step
  return described((state) => (step(state) === Fail ? Fail : value), self.name, { _tag: "As", self, value })
})

/**
 * Discards the output of a parser (winnow's `void`).
 *
 * @since 0.1.0
 * @category mapping
 */
export const asVoid = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<void, E, R, I> => as(self, undefined)

/**
 * Replaces the output of a parser with `Option.some(output)`.
 *
 * @since 0.1.0
 * @category mapping
 */
export const asSome = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<Option.Option<A>, E, R, I> =>
  map(self, Option.some)

/**
 * Runs a side effect on the output of a parser, keeping the output.
 *
 * @since 0.1.0
 * @category mapping
 */
export const tap: {
  <A>(f: (a: A) => void): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E, R, I>
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, f: (a: A) => void): Parser<A, E, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, f: (a: A) => void): Parser<A, E, R, I> => {
    const step = self.step
    return described(
      (state) => {
        const a = step(state)
        if (a !== Fail) f(a)
        return a
      },
      self.name,
      { _tag: "Tap", self, f }
    )
  }
)

/**
 * Uses the output of a parser to choose the parser that consumes the rest
 * of the input (winnow's `flat_map`, nom's `flat_map`).
 *
 * @since 0.1.0
 * @category sequencing
 */
export const flatMap: {
  <A, B, E2, R2, I2 extends Input>(
    f: (a: A) => Parser<B, E2, R2, I2>
  ): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<B, E | E2, R | R2, I & I2>
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    f: (a: A) => Parser<B, E2, R2, I2>
  ): Parser<B, E | E2, R | R2, I & I2>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    f: (a: A) => Parser<B, E2, R2, I2>
  ): Parser<B, E | E2, R | R2, I & I2> => {
    const step = self.step
    return described(
      (state) => {
        const a = step(state)
        return a === Fail ? Fail : f(a).step(state)
      },
      undefined,
      { _tag: "FlatMap", self, f }
    )
  }
)

/**
 * Applies a second parser to the *output* of the first (winnow's
 * `and_then`, nom's `map_parser`). The output of the first parser must
 * itself be an input, e.g. a slice produced by {@link taken} or
 * `Token.take`.
 *
 * Error offsets reported by the inner parser are translated relative to the
 * start of the outer parser.
 *
 * @example
 * ```ts
 * import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * // Take exactly 4 characters, then require them all to be digits
 * const year = Token.take(4).pipe(Parser.mapParser(Parser.allConsuming(Ascii.decUint)))
 * ```
 *
 * @since 0.1.0
 * @category sequencing
 */
export const mapParser: {
  <A extends Input, B, E2, R2>(
    inner: Parser<B, E2, R2, A>
  ): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<B, E | E2, R | R2, I>
  <A extends Input, E, R, I extends Input, B, E2, R2>(
    self: Parser<A, E, R, I>,
    inner: Parser<B, E2, R2, A>
  ): Parser<B, E | E2, R | R2, I>
} = /*#__PURE__*/ dual(
  2,
  <A extends Input, E, R, I extends Input, B, E2, R2>(
    self: Parser<A, E, R, I>,
    inner: Parser<B, E2, R2, A>
  ): Parser<B, E | E2, R | R2, I> => {
    const step = self.step
    return make((state) => {
      const start = state.pos
      const a = step(state)
      if (a === Fail) return Fail
      const sub = new State(a, { context: state.context })
      sub.tracer = state.tracer
      sub.depth = state.depth
      sub.recovered = state.recovered
      const b = inner.step(sub)
      if (b === Fail) {
        const f = sub.failure
        if (sub.encoding !== undefined) state.encoding = sub.encoding
        // The inner input is usually a slice ending where the outer parser stopped
        const base = Math.max(start, state.pos - a.length)
        const offset = Math.min(base + f.offset, state.pos)
        return state.failWith(
          sub.mode === "Incomplete" ? "Backtrack" : sub.mode,
          new Failure(offset, f.kind, f.expected, f.context, f.hasCause, f.cause, f.message, 0)
        )
      }
      return b
    })
  }
)

/**
 * Transforms the output of a parser with a function that may fail with a
 * `Result` (winnow's `try_map`, nom's `map_res`). On failure the parser
 * backtracks to where it started and the error becomes the `cause` of the
 * `ParseError`.
 *
 * @since 0.1.0
 * @category mapping
 */
export const tryMap: {
  <A, B, E2>(
    f: (a: A) => Result.Result<B, E2>
  ): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<B, E | E2, R, I>
  <A, E, R, I extends Input, B, E2>(
    self: Parser<A, E, R, I>,
    f: (a: A) => Result.Result<B, E2>
  ): Parser<B, E | E2, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B, E2>(
    self: Parser<A, E, R, I>,
    f: (a: A) => Result.Result<B, E2>
  ): Parser<B, E | E2, R, I> => {
    const step = self.step
    return described(
      (state) => {
        const start = state.pos
        const a = step(state)
        if (a === Fail) return Fail
        const r = f(a)
        if (Result.isSuccess(r)) return r.success
        state.pos = start
        return state.failCause("Backtrack", "Verify", r.failure)
      },
      self.name,
      { _tag: "TryMap", self, f }
    )
  }
)

/**
 * Like {@link tryMap}, but the function may throw. Thrown values become the
 * `cause` of the error.
 *
 * @since 0.1.0
 * @category mapping
 */
export const tryMapUnknown: {
  <A, B>(f: (a: A) => B): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<B, E | unknown, R, I>
  <A, E, R, I extends Input, B>(self: Parser<A, E, R, I>, f: (a: A) => B): Parser<B, E | unknown, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B>(self: Parser<A, E, R, I>, f: (a: A) => B): Parser<B, unknown, R, I> =>
    tryMap(self, (a) => {
      try {
        return Result.succeed(f(a))
      } catch (e) {
        if (Stack.isStackOverflow(e)) throw e
        return Result.fail(e)
      }
    })
)

/**
 * Transforms the output of a parser with a function returning an `Option`;
 * `None` makes the parser backtrack (winnow's `verify_map`, nom's
 * `map_opt`).
 *
 * @since 0.1.0
 * @category filtering
 */
export const filterMap: {
  <A, B>(f: (a: A) => Option.Option<B>): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<B, E, R, I>
  <A, E, R, I extends Input, B>(self: Parser<A, E, R, I>, f: (a: A) => Option.Option<B>): Parser<B, E, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B>(self: Parser<A, E, R, I>, f: (a: A) => Option.Option<B>): Parser<B, E, R, I> => {
    const step = self.step
    return described(
      (state) => {
        const start = state.pos
        const a = step(state)
        if (a === Fail) return Fail
        const o = f(a)
        if (Option.isSome(o)) return o.value
        state.pos = start
        return state.backtrack("Verify")
      },
      self.name,
      { _tag: "FilterMap", self, f }
    )
  }
)

/**
 * Keeps the output of a parser only if it satisfies a predicate, otherwise
 * backtracks (winnow's and nom's `verify`).
 *
 * @since 0.1.0
 * @category filtering
 */
export const filter: {
  <A, B extends A>(
    refinement: (a: NoInfer<A>) => a is B
  ): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<B, E, R, I>
  <A>(predicate: (a: NoInfer<A>) => boolean): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E, R, I>
  <A, E, R, I extends Input, B extends A>(self: Parser<A, E, R, I>, refinement: (a: A) => a is B): Parser<B, E, R, I>
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, predicate: (a: A) => boolean): Parser<A, E, R, I>
} = /*#__PURE__*/ dual(2, <A, E, R, I extends Input>(self: Parser<A, E, R, I>, predicate: (a: A) => boolean) => {
  const step = self.step
  return described<A, E, R, I>(
    (state) => {
      const start = state.pos
      const a = step(state)
      if (a === Fail) return Fail
      if (predicate(a)) return a
      state.pos = start
      return state.backtrack("Verify")
    },
    self.name,
    { _tag: "Filter", self, predicate }
  )
})

/**
 * Keeps the output of a parser only if it satisfies a predicate, otherwise
 * backtracks with the given user error.
 *
 * @since 0.1.0
 * @category filtering
 */
export const filterOrFail: {
  <A, B extends A, E2>(
    refinement: (a: NoInfer<A>) => a is B,
    orFailWith: (a: NoInfer<A>) => E2
  ): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<B, E | E2, R, I>
  <A, E2>(
    predicate: (a: NoInfer<A>) => boolean,
    orFailWith: (a: NoInfer<A>) => E2
  ): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E | E2, R, I>
  <A, E, R, I extends Input, B extends A, E2>(
    self: Parser<A, E, R, I>,
    refinement: (a: A) => a is B,
    orFailWith: (a: A) => E2
  ): Parser<B, E | E2, R, I>
  <A, E, R, I extends Input, E2>(
    self: Parser<A, E, R, I>,
    predicate: (a: A) => boolean,
    orFailWith: (a: A) => E2
  ): Parser<A, E | E2, R, I>
} = /*#__PURE__*/ dual(
  3,
  <A, E, R, I extends Input, E2>(self: Parser<A, E, R, I>, predicate: (a: A) => boolean, orFailWith: (a: A) => E2) => {
    const step = self.step
    return described<A, E | E2, R, I>(
      (state) => {
        const start = state.pos
        const a = step(state)
        if (a === Fail) return Fail
        if (predicate(a)) return a
        state.pos = start
        return state.failCause("Backtrack", "Verify", orFailWith(a))
      },
      self.name,
      { _tag: "Filter", self, predicate }
    )
  }
)

// -----------------------------------------------------------------------------
// Consumed input
// -----------------------------------------------------------------------------

/**
 * Returns the slice of input consumed by a parser instead of its output
 * (winnow's `take`, nom's `recognize`).
 *
 * @since 0.1.0
 * @category consumed input
 */
export const taken = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<Slice<I>, E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      const start = state.pos
      return step(state) === Fail ? Fail : state.slice(start, state.pos)
    },
    self.name,
    { _tag: "Taken", self, encoding: undefined }
  )
}

/**
 * Returns both the output of a parser and the slice of input it consumed
 * (winnow's `with_taken`; nom's `consumed` returns them in the other order).
 *
 * @since 0.1.0
 * @category consumed input
 */
export const withTaken = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>
): Parser<[output: A, taken: Slice<I>], E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      const start = state.pos
      const a = step(state)
      return a === Fail ? Fail : [a, state.slice(start, state.pos)]
    },
    self.name,
    { _tag: "WithTaken", self }
  )
}

/**
 * Returns the span (`[start, end)` offsets) consumed by a parser instead of
 * its output (winnow's `span`).
 *
 * @since 0.1.0
 * @category consumed input
 */
export const span = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<Span, E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      const start = state.pos
      return step(state) === Fail ? Fail : { start, end: state.pos }
    },
    self.name,
    { _tag: "Span", self }
  )
}

/**
 * Returns both the output of a parser and the span it consumed (winnow's
 * `with_span`).
 *
 * @since 0.1.0
 * @category consumed input
 */
export const withSpan = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>
): Parser<[output: A, span: Span], E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      const start = state.pos
      const a = step(state)
      return a === Fail ? Fail : [a, { start, end: state.pos }]
    },
    self.name,
    { _tag: "WithSpan", self }
  )
}

// -----------------------------------------------------------------------------
// Error management
// -----------------------------------------------------------------------------

const changeMode = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>,
  from: ErrMode,
  to: ErrMode
): Parser<A, E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      const a = step(state)
      if (a === Fail && state.mode === from) state.mode = to
      return a
    },
    self.name,
    { _tag: "Mode", self, from, to }
  )
}

/**
 * Commits to the current branch: recoverable failures of the parser become
 * unrecoverable, so enclosing `alt`, `opt`, `repeat`, ... do not try
 * alternatives (winnow's `cut_err`, nom's `cut`).
 *
 * @example
 * ```ts
 * import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * // Once we have seen "-", a number must follow
 * const negative = Parser.preceded(Token.literal("-"), Parser.cut(Ascii.decUint))
 * ```
 *
 * @since 0.1.0
 * @category error management
 */
export const cut = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<A, E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      // A committed failure is reported where it happened (winnow's
      // `cut_err`): only failures recorded inside `self` can outrank it as the
      // furthest failure, not ones from abandoned branches or lookaheads before
      // the commit.
      const deepest = state.deepest
      state.deepest = undefined
      const a = step(state)
      if (a === Fail && state.mode !== "Incomplete") {
        state.mode = "Cut"
        return a
      }
      const inner = state.deepest as Failure | undefined
      if (deepest !== undefined && (inner === undefined || deepest.offset > inner.offset)) state.deepest = deepest
      return a
    },
    self.name,
    { _tag: "Mode", self, from: "Backtrack", to: "Cut" }
  )
}

/**
 * Turns unrecoverable failures back into recoverable ones (winnow's
 * `backtrack_err`).
 *
 * @since 0.1.0
 * @category error management
 */
export const backtrack = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<A, E, R, I> =>
  changeMode(self, "Cut", "Backtrack")

/**
 * Turns `Incomplete` failures into recoverable ones, treating the input as
 * complete for this parser (winnow's `complete_err`, nom's `complete`).
 *
 * @since 0.1.0
 * @category error management
 */
export const complete = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<A, E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      const start = state.pos
      const a = step(state)
      if (a === Fail && state.mode === "Incomplete") {
        state.pos = start
        return state.backtrack("Complete")
      }
      return a
    },
    self.name,
    { _tag: "Mode", self, from: "Incomplete", to: "Backtrack" }
  )
}

/**
 * Adds a context label to failures of a parser (winnow's
 * `context(StrContext::Label(..))`, nom's `context`). Labels are rendered as
 * "while parsing <label>" in the error message.
 *
 * @since 0.1.0
 * @category error management
 */
export const context: {
  (label: string): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E, R, I>
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, label: string): Parser<A, E, R, I>
} = /*#__PURE__*/ dual(2, <A, E, R, I extends Input>(self: Parser<A, E, R, I>, label: string): Parser<A, E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      const a = step(state)
      if (a === Fail && state.mode !== "Incomplete") {
        const f = state.failure
        state.replaceFailure(
          new Failure(f.offset, f.kind, f.expected, [...f.context, label], f.hasCause, f.cause, f.message, f.needed)
        )
      }
      return a
    },
    self.name ?? label,
    { _tag: "Context", self, label }
  )
})

/**
 * Names what a parser expects. When the parser fails without consuming any
 * input, its expectations are replaced with `description`, so a failure is
 * reported as `expected <description>` rather than in terms of the parser's
 * internals (Parsec's `<?>`, winnow's `StrContext::Expected`).
 *
 * @since 0.1.0
 * @category error management
 */
export const expected: {
  (description: string): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E, R, I>
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, description: string): Parser<A, E, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, description: string): Parser<A, E, R, I> => {
    const step = self.step
    const desc = [description]
    return described(
      (state) => {
        const start = state.pos
        const hintOffset = state.hintOffset
        const hintExpected = state.hintExpected
        const a = step(state)
        if (a === Fail && state.failure.offset === start) {
          const f = state.failure
          const expected = hintOffset === start ? mergeExpected(hintExpected, desc) : desc
          state.replaceFailure(
            new Failure(f.offset, f.kind, expected, f.context, f.hasCause, f.cause, f.message, f.needed)
          )
        }
        return a
      },
      description,
      { _tag: "Expected", self, description }
    )
  }
)

/**
 * Transforms the user error (cause) of a parser's failures.
 *
 * @since 0.1.0
 * @category error management
 */
export const mapError: {
  <E, E2>(f: (e: E) => E2): <A, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E2, R, I>
  <A, E, R, I extends Input, E2>(self: Parser<A, E, R, I>, f: (e: E) => E2): Parser<A, E2, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, E2>(self: Parser<A, E, R, I>, f: (e: E) => E2): Parser<A, E2, R, I> => {
    const step = self.step
    return described(
      (state) => {
        const a = step(state)
        if (a === Fail && state.failure.hasCause) {
          const x = state.failure
          state.replaceFailure(
            new Failure(x.offset, x.kind, x.expected, x.context, true, f(x.cause as E), x.message, x.needed)
          )
        }
        return a
      },
      self.name,
      { _tag: "MapError", self }
    )
  }
)

/**
 * Replaces any failure of a parser with the given user error, keeping the
 * failure's position and mode.
 *
 * @since 0.1.0
 * @category error management
 */
export const orFail: {
  <E2>(error: () => E2): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E2, R, I>
  <A, E, R, I extends Input, E2>(self: Parser<A, E, R, I>, error: () => E2): Parser<A, E2, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, E2>(self: Parser<A, E, R, I>, error: () => E2): Parser<A, E2, R, I> => {
    const step = self.step
    return described(
      (state) => {
        const start = state.pos
        const a = step(state)
        if (a === Fail && state.mode !== "Incomplete") {
          const x = state.failure
          state.replaceFailure(new Failure(start, x.kind, [], x.context, true, error(), undefined, 0))
        }
        return a
      },
      self.name,
      { _tag: "OrFail", self }
    )
  }
)

/**
 * If the parser fails recoverably, tries `that` from the same position.
 * `p.pipe(Parser.orElse(() => q))` is equivalent to `Parser.alt(p, q)`.
 *
 * @since 0.1.0
 * @category error management
 */
export const orElse: {
  <B, E2, R2, I2 extends Input>(
    that: () => Parser<B, E2, R2, I2>
  ): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A | B, E | E2, R | R2, I & I2>
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    that: () => Parser<B, E2, R2, I2>
  ): Parser<A | B, E | E2, R | R2, I & I2>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    that: () => Parser<B, E2, R2, I2>
  ): Parser<A | B, E | E2, R | R2, I & I2> => alt(self, suspend(that))
)

/**
 * If the parser fails recoverably, succeeds with the given value without
 * consuming input.
 *
 * @since 0.1.0
 * @category error management
 */
export const orElseSucceed: {
  <B>(value: () => B): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A | B, E, R, I>
  <A, E, R, I extends Input, B>(self: Parser<A, E, R, I>, value: () => B): Parser<A | B, E, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B>(self: Parser<A, E, R, I>, value: () => B): Parser<A | B, E, R, I> => {
    const step = self.step
    return described(
      (state) => {
        const start = state.pos
        const a = step(state)
        if (a !== Fail) return a
        if (state.mode !== "Backtrack") return Fail
        recover(state, start)
        return value()
      },
      self.name,
      { _tag: "OrElseSucceed", self, value }
    )
  }
)

/** Rewinds after a recoverable failure, remembering it as a hint. */
const recover = (state: State<any>, start: number): void => {
  state.pos = start
  const f = state.failure
  if (f.offset === start) {
    state.hintOffset = start
    state.hintExpected = f.expected
  }
}

// -----------------------------------------------------------------------------
// Control
// -----------------------------------------------------------------------------

/**
 * Makes a parser optional: returns `Option.none()` without consuming input if
 * it fails recoverably (winnow's and nom's `opt`).
 *
 * @since 0.1.0
 * @category control
 */
export const opt = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<Option.Option<A>, E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      const start = state.pos
      const a = step(state)
      if (a !== Fail) return Option.some(a)
      if (state.mode !== "Backtrack") return Fail
      recover(state, start)
      return Option.none()
    },
    self.name,
    { _tag: "Opt", self }
  )
}

/**
 * Like {@link opt}, but returns `undefined` instead of `None`.
 *
 * @since 0.1.0
 * @category control
 */
export const optional = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<A | undefined, E, R, I> =>
  orElseSucceed(self, () => undefined)

/**
 * Runs the parser only if `condition` holds, otherwise succeeds with
 * `Option.none()` (winnow's and nom's `cond`).
 *
 * @since 0.1.0
 * @category control
 */
export const cond = <A, E, R, I extends Input>(
  condition: boolean,
  self: Parser<A, E, R, I>
): Parser<Option.Option<A>, E, R, I> => (condition ? asSome(self) : succeed(Option.none()))

/**
 * Runs a parser without consuming input (winnow's and nom's `peek`).
 *
 * @since 0.1.0
 * @category control
 */
export const peek = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<A, E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      const start = state.pos
      const hintOffset = state.hintOffset
      const hintExpected = state.hintExpected
      const deepest = state.deepest
      const a = step(state)
      if (a !== Fail) {
        // Failures inside a lookahead that succeeded are about input that was
        // never consumed, so they are not reported as the furthest failure
        state.pos = start
        state.hintOffset = hintOffset
        state.hintExpected = hintExpected
        state.deepest = deepest
      }
      return a
    },
    self.name,
    { _tag: "Peek", self }
  )
}

/**
 * Succeeds, without consuming input, only if the parser fails recoverably
 * (winnow's and nom's `not`).
 *
 * @since 0.1.0
 * @category control
 */
export const not = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<void, E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      const start = state.pos
      const hintOffset = state.hintOffset
      const hintExpected = state.hintExpected
      const deepest = state.deepest
      const a = step(state)
      if (a !== Fail) {
        // The failures inside `self` are not this parser's failure
        state.pos = start
        state.deepest = deepest
        return state.backtrack("Not")
      }
      if (state.mode !== "Backtrack") return Fail
      state.pos = start
      state.hintOffset = hintOffset
      state.hintExpected = hintExpected
      state.deepest = deepest
      return undefined
    },
    self.name,
    { _tag: "Not", self }
  )
}

/**
 * Requires the parser to consume the whole input (nom's `all_consuming`).
 *
 * @since 0.1.0
 * @category control
 */
export const allConsuming = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<A, E, R, I> =>
  terminated(self, eof)

// -----------------------------------------------------------------------------
// Sequencing
// -----------------------------------------------------------------------------

/**
 * Runs parsers in sequence, collecting their outputs in a tuple (winnow's
 * and nom's tuple parsers, winnow's `seq!`).
 *
 * @since 0.1.0
 * @category sequencing
 */
export const seq = <const Ps extends ReadonlyArray<Parser.Any>>(
  ...parsers: Ps
): Parser<
  { -readonly [K in keyof Ps]: Parser.Success<Ps[K]> },
  Parser.Error<Ps[number]>,
  Parser.Services<Ps[number]>,
  Parser.InputOf<Ps[number]>
> => {
  const steps = parsers.map((p) => p.step)
  const n = steps.length
  return described(
    (state: State<any>) => {
      const out = new Array(n)
      for (let i = 0; i < n; i++) {
        const a = steps[i](state)
        if (a === Fail) return Fail
        out[i] = a
      }
      return out as any
    },
    "seq",
    { _tag: "Seq", parsers, output: "tuple" }
  )
}

/**
 * Runs a record of parsers in sequence (in key order), collecting their
 * outputs in a record. This is the Effect counterpart to winnow's
 * `seq!(Struct { .. })`.
 *
 * @since 0.1.0
 * @category sequencing
 */
export const struct = <const Fields extends Readonly<Record<string, Parser.Any>>>(
  fields: Fields
): Parser<
  Simplify<{ -readonly [K in keyof Fields]: Parser.Success<Fields[K]> }>,
  Parser.Error<Fields[keyof Fields]>,
  Parser.Services<Fields[keyof Fields]>,
  Parser.InputOf<Fields[keyof Fields]>
> => {
  const keys = Object.keys(fields)
  const steps = keys.map((k) => fields[k].step)
  const n = keys.length
  return described(
    (state: State<any>) => {
      const out: Record<string, unknown> = {}
      for (let i = 0; i < n; i++) {
        const a = steps[i](state)
        if (a === Fail) return Fail
        out[keys[i]] = a
      }
      return out as any
    },
    "struct",
    { _tag: "Struct", keys, parsers: keys.map((k) => fields[k]) }
  )
}

/**
 * Runs two parsers in sequence and returns both outputs.
 *
 * @since 0.1.0
 * @category sequencing
 */
export const zip: {
  <B, E2, R2, I2 extends Input>(
    that: Parser<B, E2, R2, I2>
  ): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<[A, B], E | E2, R | R2, I & I2>
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    that: Parser<B, E2, R2, I2>
  ): Parser<[A, B], E | E2, R | R2, I & I2>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    that: Parser<B, E2, R2, I2>
  ): Parser<[A, B], E | E2, R | R2, I & I2> => zipWith(self, that, (a, b) => [a, b])
)

/**
 * Runs two parsers in sequence and combines their outputs.
 *
 * @since 0.1.0
 * @category sequencing
 */
export const zipWith: {
  <B, E2, R2, I2 extends Input, A, C>(
    that: Parser<B, E2, R2, I2>,
    f: (a: A, b: B) => C
  ): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<C, E | E2, R | R2, I & I2>
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input, C>(
    self: Parser<A, E, R, I>,
    that: Parser<B, E2, R2, I2>,
    f: (a: A, b: B) => C
  ): Parser<C, E | E2, R | R2, I & I2>
} = /*#__PURE__*/ dual(
  3,
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input, C>(
    self: Parser<A, E, R, I>,
    that: Parser<B, E2, R2, I2>,
    f: (a: A, b: B) => C
  ): Parser<C, E | E2, R | R2, I & I2> => {
    const s1 = self.step
    const s2 = that.step
    return described(
      (state) => {
        const a = s1(state)
        if (a === Fail) return Fail
        const b = s2(state)
        if (b === Fail) return Fail
        return f(a, b)
      },
      undefined,
      { _tag: "ZipWith", self, that, f }
    )
  }
)

/**
 * Runs two parsers in sequence, keeping the output of the first.
 *
 * @since 0.1.0
 * @category sequencing
 */
export const zipLeft: {
  <B, E2, R2, I2 extends Input>(
    that: Parser<B, E2, R2, I2>
  ): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E | E2, R | R2, I & I2>
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    that: Parser<B, E2, R2, I2>
  ): Parser<A, E | E2, R | R2, I & I2>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    that: Parser<B, E2, R2, I2>
  ): Parser<A, E | E2, R | R2, I & I2> => terminated(self, that)
)

/**
 * Runs two parsers in sequence, keeping the output of the second.
 *
 * @since 0.1.0
 * @category sequencing
 */
export const zipRight: {
  <B, E2, R2, I2 extends Input>(
    that: Parser<B, E2, R2, I2>
  ): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<B, E | E2, R | R2, I & I2>
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    that: Parser<B, E2, R2, I2>
  ): Parser<B, E | E2, R | R2, I & I2>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    that: Parser<B, E2, R2, I2>
  ): Parser<B, E | E2, R | R2, I & I2> => preceded(self, that)
)

/**
 * Runs `prefix` then `parser`, keeping the output of `parser` (winnow's and
 * nom's `preceded`).
 *
 * @since 0.1.0
 * @category sequencing
 */
export const preceded = <A1, E1, R1, I1 extends Input, A2, E2, R2, I2 extends Input>(
  prefix: Parser<A1, E1, R1, I1>,
  parser: Parser<A2, E2, R2, I2>
): Parser<A2, E1 | E2, R1 | R2, I1 & I2> => {
  const s1 = prefix.step
  const s2 = parser.step
  return described((state) => (s1(state) === Fail ? Fail : s2(state)), parser.name, {
    _tag: "Seq",
    parsers: [prefix, parser],
    output: 1
  })
}

/**
 * Runs `parser` then `suffix`, keeping the output of `parser` (winnow's and
 * nom's `terminated`).
 *
 * @since 0.1.0
 * @category sequencing
 */
export const terminated = <A1, E1, R1, I1 extends Input, A2, E2, R2, I2 extends Input>(
  parser: Parser<A1, E1, R1, I1>,
  suffix: Parser<A2, E2, R2, I2>
): Parser<A1, E1 | E2, R1 | R2, I1 & I2> => {
  const s1 = parser.step
  const s2 = suffix.step
  return described(
    (state) => {
      const a = s1(state)
      if (a === Fail) return Fail
      return s2(state) === Fail ? Fail : a
    },
    parser.name,
    { _tag: "Seq", parsers: [parser, suffix], output: 0 }
  )
}

/**
 * Runs `open`, `parser` and `close`, keeping the output of `parser`
 * (winnow's and nom's `delimited`).
 *
 * @since 0.1.0
 * @category sequencing
 */
export const delimited = <A1, E1, R1, I1 extends Input, A2, E2, R2, I2 extends Input, A3, E3, R3, I3 extends Input>(
  open: Parser<A1, E1, R1, I1>,
  parser: Parser<A2, E2, R2, I2>,
  close: Parser<A3, E3, R3, I3>
): Parser<A2, E1 | E2 | E3, R1 | R2 | R3, I1 & I2 & I3> => {
  const s1 = open.step
  const s2 = parser.step
  const s3 = close.step
  return described(
    (state) => {
      if (s1(state) === Fail) return Fail
      const a = s2(state)
      if (a === Fail) return Fail
      return s3(state) === Fail ? Fail : a
    },
    parser.name,
    { _tag: "Seq", parsers: [open, parser, close], output: 1 }
  )
}

/**
 * Runs `first`, `separator` and `second`, keeping the outputs of `first` and
 * `second` (winnow's and nom's `separated_pair`).
 *
 * @since 0.1.0
 * @category sequencing
 */
export const separatedPair = <A1, E1, R1, I1 extends Input, A2, E2, R2, I2 extends Input, A3, E3, R3, I3 extends Input>(
  first: Parser<A1, E1, R1, I1>,
  separator: Parser<A2, E2, R2, I2>,
  second: Parser<A3, E3, R3, I3>
): Parser<[A1, A3], E1 | E2 | E3, R1 | R2 | R3, I1 & I2 & I3> => {
  const s1 = first.step
  const s2 = separator.step
  const s3 = second.step
  return described(
    (state) => {
      const a = s1(state)
      if (a === Fail) return Fail
      if (s2(state) === Fail) return Fail
      const b = s3(state)
      return b === Fail ? Fail : [a, b]
    },
    undefined,
    { _tag: "Seq", parsers: [first, separator, second], output: [0, 2] }
  )
}

/**
 * Writes a parser in imperative style with a generator, Effect style:
 * `yield*` a parser to run it and get its output.
 *
 * @example
 * ```ts
 * import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const keyValue = Parser.gen(function*() {
 *   const key = yield* Ascii.alpha1
 *   yield* Token.literal("=")
 *   const value = yield* Ascii.decInt
 *   return [key, value] as const
 * })
 * ```
 *
 * The body runs on every parse, so parsers created inside it, like
 * `Token.literal("=")` above, are rebuilt on every run. On hot paths, build
 * them once outside the body:
 *
 * ```ts
 * import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const equals = Token.literal("=")
 *
 * const keyValue = Parser.gen(function*() {
 *   const key = yield* Ascii.alpha1
 *   yield* equals
 *   const value = yield* Ascii.decInt
 *   return [key, value] as const
 * })
 * ```
 *
 * @since 0.1.0
 * @category sequencing
 */
export const gen = <Eff extends Parser.Any, AEff>(
  f: () => Generator<Eff, AEff, never>
): Parser<AEff, Parser.Error<Eff>, Parser.Services<Eff>, Parser.InputOf<Eff>> =>
  make((state: State<any>) => {
    const iterator = f()
    let next = iterator.next()
    while (!next.done) {
      const a = next.value.step(state)
      if (a === Fail) {
        iterator.return?.(undefined as any)
        return Fail
      }
      next = iterator.next(a as never)
    }
    return next.value
  }, "gen")

/**
 * The starting point for Do notation.
 *
 * @example
 * ```ts
 * import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const range = Parser.Do.pipe(
 *   Parser.bind("start", () => Ascii.decUint),
 *   Parser.zipLeft(Token.literal("..")),
 *   Parser.bind("end", () => Ascii.decUint)
 * )
 * ```
 *
 * @since 0.1.0
 * @category do notation
 */
export const Do: Parser<{}, never, never, Input> = /*#__PURE__*/ succeed({})

/**
 * Binds the output of a parser to a field of the Do record.
 *
 * @since 0.1.0
 * @category do notation
 */
export const bind: {
  <N extends string, A extends object, B, E2, R2, I2 extends Input>(
    name: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => Parser<B, E2, R2, I2>
  ): <E, R, I extends Input>(
    self: Parser<A, E, R, I>
  ) => Parser<Simplify<Omit<A, N> & { [K in N]: B }>, E | E2, R | R2, I & I2>
  <A extends object, E, R, I extends Input, N extends string, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    name: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => Parser<B, E2, R2, I2>
  ): Parser<Simplify<Omit<A, N> & { [K in N]: B }>, E | E2, R | R2, I & I2>
} = /*#__PURE__*/ dual(3, (self: Parser.Any, name: string, f: (a: any) => Parser.Any): Parser.Any =>
  flatMap(self, (a) => map(f(a), (b) => ({ ...a, [name]: b })))
)

/**
 * Wraps the output of a parser in a record with a single field.
 *
 * @since 0.1.0
 * @category do notation
 */
export const bindTo: {
  <N extends string>(name: N): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<{ [K in N]: A }, E, R, I>
  <A, E, R, I extends Input, N extends string>(self: Parser<A, E, R, I>, name: N): Parser<{ [K in N]: A }, E, R, I>
} = /*#__PURE__*/ dual(2, (self: Parser.Any, name: string): Parser.Any => map(self, (a) => ({ [name]: a })))

const let_: {
  <N extends string, A extends object, B>(
    name: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => B
  ): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<Simplify<Omit<A, N> & { [K in N]: B }>, E, R, I>
  <A extends object, E, R, I extends Input, N extends string, B>(
    self: Parser<A, E, R, I>,
    name: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => B
  ): Parser<Simplify<Omit<A, N> & { [K in N]: B }>, E, R, I>
} = /*#__PURE__*/ dual(3, (self: Parser.Any, name: string, f: (a: any) => unknown): Parser.Any =>
  map(self, (a) => ({ ...a, [name]: f(a) }))
)

export {
  /**
   * Adds a computed field to the Do record.
   *
   * @since 0.1.0
   * @category do notation
   */
  let_ as let
}

// -----------------------------------------------------------------------------
// Choice
// -----------------------------------------------------------------------------

/**
 * Tries each parser in turn and returns the output of the first that
 * succeeds (winnow's and nom's `alt`).
 *
 * Unrecoverable (`Cut`) and `Incomplete` failures stop the search
 * immediately. If every alternative fails recoverably, the failures are
 * merged: the one that got furthest wins, and failures at the same offset
 * combine their expectations, e.g. `expected "true", "false" or "null"`.
 *
 * @since 0.1.0
 * @category choice
 */
export const alt = <const Ps extends ReadonlyArray<Parser.Any>>(
  ...parsers: Ps
): Parser<
  Parser.Success<Ps[number]>,
  Parser.Error<Ps[number]>,
  Parser.Services<Ps[number]>,
  Parser.InputOf<Ps[number]>
> => {
  const steps = parsers.map((p) => p.step)
  const n = steps.length
  if (n === 0) return reject as any
  if (n === 1) return parsers[0]
  return described(
    (state: State<any>) => {
      const start = state.pos
      let failure: Failure | undefined
      for (let i = 0; i < n; i++) {
        const a = steps[i](state)
        if (a !== Fail) {
          if (failure !== undefined && failure.offset === state.pos) state.setHint(failure.offset, failure.expected)
          return a
        }
        if (state.mode !== "Backtrack") return Fail
        failure = failure === undefined ? state.failure : mergeFailures(failure, state.failure)
        state.pos = start
      }
      // `failure` is set: there are at least two alternatives, and each one that fails sets it
      return state.failWith("Backtrack", failure ?? state.failure)
    },
    "alt",
    { _tag: "Alt", parsers }
  )
}

/**
 * Selects the parser to run next based on the output of `selector`, like a
 * `match` over the input (winnow's `dispatch!`). If no case matches, the
 * parser backtracks to where it started.
 *
 * Cases are given either as a record keyed by the selector's output (with
 * an optional `otherwise` parser for unlisted keys, like winnow's `_ =>`
 * arm), or as a function returning a parser (or `undefined` for no match).
 *
 * @example
 * ```ts
 * import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const escape = Parser.preceded(
 *   Token.literal("\\"),
 *   Parser.dispatch(Token.any, {
 *     n: Parser.succeed("\n"),
 *     t: Parser.succeed("\t"),
 *     u: Parser.preceded(Token.literal("{"), Ascii.hexUint).pipe(
 *       Parser.zipLeft(Token.literal("}")),
 *       Parser.map((cp) => String.fromCodePoint(cp))
 *     )
 *   })
 * )
 * ```
 *
 * @since 0.1.0
 * @category choice
 */
export const dispatch: {
  <K, E, R, I extends Input, P extends Parser.Any>(
    selector: Parser<K, E, R, I>,
    cases: (key: K) => P | undefined
  ): Parser<Parser.Success<P>, E | Parser.Error<P>, R | Parser.Services<P>, I & Parser.InputOf<P>>
  <
    K extends PropertyKey,
    E,
    R,
    I extends Input,
    const Cases extends { readonly [key in K]?: Parser.Any },
    Otherwise extends Parser.Any = never
  >(
    selector: Parser<K, E, R, I>,
    cases: Cases,
    otherwise?: Otherwise
  ): Parser<
    Parser.Success<NonNullable<Cases[keyof Cases]> | Otherwise>,
    E | Parser.Error<NonNullable<Cases[keyof Cases]> | Otherwise>,
    R | Parser.Services<NonNullable<Cases[keyof Cases]> | Otherwise>,
    I & Parser.InputOf<NonNullable<Cases[keyof Cases]> | Otherwise>
  >
} = (
  selector: Parser.Any,
  cases: ((key: any) => Parser.Any | undefined) | Record<PropertyKey, Parser.Any>,
  otherwise?: Parser.Any
) => {
  const choose =
    typeof cases === "function"
      ? cases
      : (key: PropertyKey) => (Object.prototype.hasOwnProperty.call(cases, key) ? cases[key] : otherwise)
  const step = selector.step
  return described(
    (state: State<any>) => {
      const start = state.pos
      const key = step(state)
      if (key === Fail) return Fail
      const parser = choose(key)
      if (parser === undefined) {
        state.pos = start
        return state.backtrack("Dispatch")
      }
      return parser.step(state)
    },
    "dispatch",
    {
      _tag: "Dispatch",
      selector,
      cases: typeof cases === "function" ? undefined : cases,
      otherwise: typeof cases === "function" ? undefined : otherwise,
      choose
    }
  )
}

/**
 * Applies every parser exactly once, in whatever order they match, and
 * returns their outputs in the order the parsers were given (winnow's and
 * nom's `permutation`).
 *
 * @since 0.1.0
 * @category choice
 */
export const permutation = <const Ps extends ReadonlyArray<Parser.Any>>(
  ...parsers: Ps
): Parser<
  { -readonly [K in keyof Ps]: Parser.Success<Ps[K]> },
  Parser.Error<Ps[number]>,
  Parser.Services<Ps[number]>,
  Parser.InputOf<Ps[number]>
> => {
  const steps = parsers.map((p) => p.step)
  const n = steps.length
  return make((state: State<any>) => {
    const out = new Array(n)
    const done = new Array<boolean>(n).fill(false)
    let remaining = n
    while (remaining > 0) {
      let failure: Failure | undefined
      let matched = false
      for (let i = 0; i < n; i++) {
        if (done[i]) continue
        const start = state.pos
        const a = steps[i](state)
        if (a !== Fail) {
          out[i] = a
          done[i] = true
          remaining--
          matched = true
          break
        }
        if (state.mode !== "Backtrack") return Fail
        failure = failure === undefined ? state.failure : mergeFailures(failure, state.failure)
        state.pos = start
      }
      // `failure` is set: some parser is not done yet, and each one that fails sets it
      if (!matched) return state.failWith("Backtrack", failure ?? state.failure)
    }
    return out as any
  }, "permutation")
}

// -----------------------------------------------------------------------------
// Repetition
// -----------------------------------------------------------------------------

const normalizeRange = (range: Range | undefined): [min: number, max: number] => {
  if (range === undefined) return [0, Infinity]
  if (typeof range === "number") return [range, range]
  const min = range.min ?? 0
  const max = range.max ?? Infinity
  if (min > max) throw new RangeError(`invalid range: min (${min}) > max (${max})`)
  return [min, max]
}

const assertConsumes = (state: State<any>, name: string): Fail =>
  state.failMessage("Cut", "Assert", `\`${name}\` parsers must always consume`)

/** How far a repetition got before a streaming parse ran out of input. */
interface FoldCheckpoint<B> {
  readonly acc: B
  readonly count: number
  /** Where the next element starts. */
  readonly pos: number
}

const saveFold = <B>(state: State<any>, key: object, entry: number, acc: B, pos: number): void =>
  Resume.save(state, key, entry, { acc, count: 0, pos } satisfies FoldCheckpoint<B>)

const foldImpl = <A, B, E, R, I extends Input>(
  self: Parser<A, E, R, I>,
  range: Range | undefined,
  init: () => B,
  f: (acc: B, a: A) => B,
  name: string,
  node?: Node,
  cond?: (acc: B) => boolean
): Parser<B, E, R, I> => {
  const [min, max] = normalizeRange(range)
  const step = self.step
  const checkLoop = max === Infinity
  const key = {}
  return described(
    (state) => {
      const entry = state.pos
      let acc: B
      let count = 0
      const resumed = state.resume === undefined ? undefined : (Resume.take(state, key, entry) as FoldCheckpoint<B>)
      if (resumed instanceof Resume.Done) {
        state.pos = resumed.pos
        return resumed.value as B
      }
      if (resumed !== undefined) {
        acc = resumed.acc
        count = resumed.count
        state.pos = resumed.pos
      } else {
        acc = init()
      }
      for (; count < max; count++) {
        if (cond !== undefined && count >= min && !cond(acc)) break
        const start = state.pos
        const a = step(state)
        if (a === Fail) {
          if (state.mode === "Incomplete" && state.resume !== undefined) {
            Resume.save(state, key, entry, { acc, count, pos: start } satisfies FoldCheckpoint<B>)
          }
          if (state.mode !== "Backtrack" || count < min) return Fail
          recover(state, start)
          return Resume.done(state, key, entry, resumed !== undefined, acc)
        }
        if (checkLoop && state.pos === start) return assertConsumes(state, name)
        acc = f(acc, a)
      }
      return Resume.done(state, key, entry, resumed !== undefined, acc)
    },
    name,
    node ?? { _tag: "Fold", self, init, f, while: cond, name, ...bounds(range) }
  )
}

/**
 * Applies a parser repeatedly, collecting the outputs in an array (winnow's
 * `repeat`, nom's `many0`, `many1`, `many_m_n` and `count`).
 *
 * The range defaults to `{ min: 0 }` (zero or more). A number repeats
 * exactly that many times. With a literal positive `min`, the output is
 * typed as a non-empty array.
 *
 * As in winnow, an unbounded repetition of a parser that succeeds without
 * consuming input fails with an unrecoverable assertion instead of looping
 * forever.
 *
 * @example
 * ```ts
 * import { Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const abs = Parser.repeat(Token.literal("ab"), { min: 1 })
 * Parser.parse(abs, "ababab") // Result.succeed(["ab", "ab", "ab"])
 * ```
 *
 * @since 0.1.0
 * @category repetition
 */
export const repeat: {
  <const Rg extends Range = { readonly min: 0 }>(
    range?: Rg
  ): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<Repeated<A, Rg>, E, R, I>
  <A, E, R, I extends Input, const Rg extends Range = { readonly min: 0 }>(
    self: Parser<A, E, R, I>,
    range?: Rg
  ): Parser<Repeated<A, Rg>, E, R, I>
} = /*#__PURE__*/ dual(isParserArg, <A, E, R, I extends Input>(self: Parser<A, E, R, I>, range?: Range) =>
  foldImpl<A, Array<A>, E, R, I>(
    self,
    range,
    () => [],
    (acc, a) => {
      acc.push(a)
      return acc
    },
    "repeat",
    { _tag: "Repeat", self, ...bounds(range) }
  )
)

/**
 * Applies a parser repeatedly, folding the outputs into an accumulator
 * (winnow's `repeat(..).fold(..)`, nom's `fold_many0`/`fold_many1`/
 * `fold_many_m_n`).
 *
 * With `while`, the repetition also stops, successfully and without
 * consuming more input, as soon as the predicate is false of the
 * accumulator. It is checked before each element once `range.min` elements
 * have been folded, so `min` still holds.
 *
 * @example
 * ```ts
 * import { Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * // Keeps the first two digits, leaving the rest unparsed
 * const two = Parser.fold(Token.oneOf("0123456789"), {
 *   init: () => "",
 *   f: (acc, d) => acc + d,
 *   while: (acc) => acc.length < 2
 * })
 * Parser.parsePeek(two, "1234") // Result.succeed(["34", "12"])
 * ```
 *
 * @since 0.1.0
 * @category repetition
 */
export const fold: {
  <A, B>(options: {
    readonly init: () => B
    readonly f: (acc: B, a: A) => B
    readonly range?: Range | undefined
    readonly while?: ((acc: B) => boolean) | undefined
  }): <E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<B, E, R, I>
  <A, E, R, I extends Input, B>(
    self: Parser<A, E, R, I>,
    options: {
      readonly init: () => B
      readonly f: (acc: B, a: A) => B
      readonly range?: Range | undefined
      readonly while?: ((acc: B) => boolean) | undefined
    }
  ): Parser<B, E, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B>(
    self: Parser<A, E, R, I>,
    options: {
      readonly init: () => B
      readonly f: (acc: B, a: A) => B
      readonly range?: Range | undefined
      readonly while?: ((acc: B) => boolean) | undefined
    }
  ): Parser<B, E, R, I> => foldImpl(self, options.range, options.init, options.f, "fold", undefined, options.while)
)

/**
 * Applies `self` repeatedly until `end` succeeds, returning the collected
 * outputs and the output of `end` (winnow's `repeat_till`, nom's
 * `many_till`).
 *
 * @since 0.1.0
 * @category repetition
 */
export const repeatTill: {
  <B, E2, R2, I2 extends Input, const Rg extends Range = { readonly min: 0 }>(
    end: Parser<B, E2, R2, I2>,
    range?: Rg
  ): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<[Repeated<A, Rg>, B], E | E2, R | R2, I & I2>
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input, const Rg extends Range = { readonly min: 0 }>(
    self: Parser<A, E, R, I>,
    end: Parser<B, E2, R2, I2>,
    range?: Rg
  ): Parser<[Repeated<A, Rg>, B], E | E2, R | R2, I & I2>
} = /*#__PURE__*/ dual(
  isTwoParserArgs,
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    end: Parser<B, E2, R2, I2>,
    range?: Range
  ): Parser<[Array<A>, B], E | E2, R | R2, I & I2> => {
    const [min, max] = normalizeRange(range)
    const step = self.step
    const endStep = end.step
    return described(
      (state) => {
        const acc: Array<A> = []
        while (true) {
          const start = state.pos
          let endFailure: Failure | undefined
          if (acc.length >= min) {
            const b = endStep(state)
            if (b !== Fail) return [acc, b]
            if (state.mode !== "Backtrack") return Fail
            endFailure = state.failure
            state.pos = start
            if (acc.length >= max) return Fail
          }
          const a = step(state)
          if (a === Fail) {
            if (endFailure !== undefined && state.mode === "Backtrack") {
              state.failWith("Backtrack", mergeFailures(endFailure, state.failure))
            }
            return Fail
          }
          if (state.pos === start) return assertConsumes(state, "repeatTill")
          acc.push(a)
        }
      },
      "repeatTill",
      { _tag: "RepeatTill", self, end, ...bounds(range) }
    )
  }
)

/**
 * Applies `self` repeatedly, separated by `separator`, collecting the
 * outputs of `self` (winnow's `separated`, nom's `separated_list0` and
 * `separated_list1`). A trailing separator is not consumed.
 *
 * @example
 * ```ts
 * import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const csv = Parser.separated(Ascii.decInt, Token.literal(","))
 * Parser.parse(csv, "1,2,3") // Result.succeed([1, 2, 3])
 * ```
 *
 * @since 0.1.0
 * @category repetition
 */
/** How far `separated` got: the elements so far, and where the next separator starts. */
interface SeparatedCheckpoint<A> {
  readonly acc: Array<A>
  readonly pos: number
}

export const separated: {
  <S, E2, R2, I2 extends Input, const Rg extends Range = { readonly min: 0 }>(
    separator: Parser<S, E2, R2, I2>,
    range?: Rg
  ): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<Repeated<A, Rg>, E | E2, R | R2, I & I2>
  <A, E, R, I extends Input, S, E2, R2, I2 extends Input, const Rg extends Range = { readonly min: 0 }>(
    self: Parser<A, E, R, I>,
    separator: Parser<S, E2, R2, I2>,
    range?: Rg
  ): Parser<Repeated<A, Rg>, E | E2, R | R2, I & I2>
} = /*#__PURE__*/ dual(
  isTwoParserArgs,
  <A, E, R, I extends Input, S, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    separator: Parser<S, E2, R2, I2>,
    range?: Range
  ): Parser<Array<A>, E | E2, R | R2, I & I2> => {
    const [min, max] = normalizeRange(range)
    const step = self.step
    const sepStep = separator.step
    const checkLoop = max === Infinity
    const key = {}
    return described(
      (state) => {
        const entry = state.pos
        let acc: Array<A>
        const resumed =
          state.resume === undefined ? undefined : (Resume.take(state, key, entry) as SeparatedCheckpoint<A>)
        if (resumed instanceof Resume.Done) {
          state.pos = resumed.pos
          return resumed.value as Array<A>
        }
        if (resumed !== undefined) {
          acc = resumed.acc
          state.pos = resumed.pos
        } else {
          acc = []
          if (max === 0) return acc
          const start = state.pos
          const first = step(state)
          if (first === Fail) {
            if (state.mode !== "Backtrack" || min > 0) return Fail
            recover(state, start)
            return acc
          }
          acc.push(first)
        }
        while (acc.length < max) {
          const start = state.pos
          if (sepStep(state) === Fail) {
            if (state.mode === "Incomplete" && state.resume !== undefined) {
              Resume.save(state, key, entry, { acc, pos: start } satisfies SeparatedCheckpoint<A>)
            }
            if (state.mode !== "Backtrack" || acc.length < min) return Fail
            recover(state, start)
            return Resume.done(state, key, entry, resumed !== undefined, acc)
          }
          if (checkLoop && state.pos === start) return assertConsumes(state, "separated")
          const a = step(state)
          if (a === Fail) {
            if (state.mode === "Incomplete" && state.resume !== undefined) {
              Resume.save(state, key, entry, { acc, pos: start } satisfies SeparatedCheckpoint<A>)
            }
            if (state.mode !== "Backtrack" || acc.length < min) return Fail
            state.pos = start
            return Resume.done(state, key, entry, resumed !== undefined, acc)
          }
          acc.push(a)
        }
        return Resume.done(state, key, entry, resumed !== undefined, acc)
      },
      "separated",
      { _tag: "Separated", self, separator, ...bounds(range) }
    )
  }
)

/**
 * Parses one or more `self` separated by `separator`, folding them from the
 * left with the separator's output: `((a op b) op c)` (winnow's
 * `separated_foldl1`). This is the classic way to parse left-associative
 * binary operators.
 *
 * @example
 * ```ts
 * import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const sum = Parser.separatedFoldl1(
 *   Ascii.decInt,
 *   Parser.alt(Token.literal("+"), Token.literal("-")),
 *   (l, op, r) => op === "+" ? l + r : l - r
 * )
 * Parser.parse(sum, "10-3+2") // Result.succeed(9)
 * ```
 *
 * @since 0.1.0
 * @category repetition
 */
export const separatedFoldl1 = <A, E, R, I extends Input, S, E2, R2, I2 extends Input>(
  self: Parser<A, E, R, I>,
  separator: Parser<S, E2, R2, I2>,
  op: (left: A, separator: S, right: A) => A
): Parser<A, E | E2, R | R2, I & I2> => {
  const step = self.step
  const sepStep = separator.step
  const key = {}
  return described(
    (state) => {
      const entry = state.pos
      const resumed = state.resume === undefined ? undefined : (Resume.take(state, key, entry) as FoldCheckpoint<A>)
      let acc: A | Fail
      if (resumed instanceof Resume.Done) {
        state.pos = resumed.pos
        return resumed.value as A
      }
      if (resumed !== undefined) {
        acc = resumed.acc
        state.pos = resumed.pos
      } else {
        acc = step(state)
        if (acc === Fail) return Fail
      }
      while (true) {
        const start = state.pos
        const s = sepStep(state)
        if (s === Fail) {
          if (state.mode === "Incomplete" && state.resume !== undefined) saveFold(state, key, entry, acc, start)
          if (state.mode !== "Backtrack") return Fail
          recover(state, start)
          return Resume.done(state, key, entry, resumed !== undefined, acc as A)
        }
        if (state.pos === start) return assertConsumes(state, "separatedFoldl1")
        const a = step(state)
        if (a === Fail) {
          if (state.mode === "Incomplete" && state.resume !== undefined) saveFold(state, key, entry, acc, start)
          if (state.mode !== "Backtrack") return Fail
          state.pos = start
          return Resume.done(state, key, entry, resumed !== undefined, acc as A)
        }
        acc = op(acc, s, a)
      }
    },
    "separatedFoldl1",
    { _tag: "SeparatedFold", self, separator, op, right: false }
  )
}

/**
 * Parses one or more `self` separated by `separator`, folding them from the
 * right with the separator's output: `(a op (b op c))` (winnow's
 * `separated_foldr1`). Useful for right-associative operators such as
 * exponentiation.
 *
 * @since 0.1.0
 * @category repetition
 */
export const separatedFoldr1 = <A, E, R, I extends Input, S, E2, R2, I2 extends Input>(
  self: Parser<A, E, R, I>,
  separator: Parser<S, E2, R2, I2>,
  op: (left: A, separator: S, right: A) => A
): Parser<A, E | E2, R | R2, I & I2> => {
  const step = self.step
  const sepStep = separator.step
  return described(
    (state) => {
      const first = step(state)
      if (first === Fail) return Fail
      const values: Array<A> = [first]
      const seps: Array<S> = []
      while (true) {
        const start = state.pos
        const s = sepStep(state)
        if (s === Fail) {
          if (state.mode !== "Backtrack") return Fail
          recover(state, start)
          break
        }
        if (state.pos === start) return assertConsumes(state, "separatedFoldr1")
        const a = step(state)
        if (a === Fail) {
          if (state.mode !== "Backtrack") return Fail
          state.pos = start
          break
        }
        seps.push(s)
        values.push(a)
      }
      let acc = values[values.length - 1] as A
      for (let i = seps.length - 1; i >= 0; i--) {
        acc = op(values[i] as A, seps[i] as S, acc)
      }
      return acc
    },
    "separatedFoldr1",
    { _tag: "SeparatedFold", self, separator, op, right: true }
  )
}

// -----------------------------------------------------------------------------
// Services
// -----------------------------------------------------------------------------

/**
 * Accesses a service from the parser's context. Services take the place of
 * winnow's `Stateful` input: they can hold configuration, or mutable state
 * such as an indentation stack or a symbol table.
 *
 * Services are provided with {@link provideService} / {@link provide}, with
 * the `context` option of the runners, or taken from the surrounding Effect
 * by {@link parseEffect}.
 *
 * Mutations made to a service's state are not undone on backtracking (as
 * with winnow's `Stateful`).
 *
 * @example
 * ```ts
 * import { Context } from "effect"
 * import { Ascii, Parser } from "@thomasfosterau/effect-parse"
 *
 * class Radix extends Context.Service<Radix, number>()("Radix") {}
 *
 * const number = Parser.service(Radix).pipe(
 *   Parser.flatMap((radix) =>
 *     Ascii.alphanumeric1.pipe(Parser.map((digits) => parseInt(digits, radix)))
 *   )
 * )
 *
 * Parser.parse(Parser.provideService(number, Radix, 16), "ff") // Result.succeed(255)
 * ```
 *
 * @since 0.1.0
 * @category services
 */
export const service = <Id, S>(key: Context.Key<Id, S>): Parser<S, never, Id, Input> =>
  described((state) => Context.getUnsafe(state.context, key), "service", serviceNode)

const serviceNode: Node = { _tag: "Service" }

/**
 * Provides a service to a parser.
 *
 * @since 0.1.0
 * @category services
 */
export const provideService: {
  <Id, S>(
    key: Context.Key<Id, S>,
    service: NoInfer<S>
  ): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E, Exclude<R, Id>, I>
  <A, E, R, I extends Input, Id, S>(
    self: Parser<A, E, R, I>,
    key: Context.Key<Id, S>,
    service: NoInfer<S>
  ): Parser<A, E, Exclude<R, Id>, I>
} = /*#__PURE__*/ dual(
  3,
  <A, E, R, I extends Input, Id, S>(
    self: Parser<A, E, R, I>,
    key: Context.Key<Id, S>,
    service: S
  ): Parser<A, E, Exclude<R, Id>, I> => {
    const step = self.step
    return described(
      (state) => {
        const prev = state.context
        state.context = Context.add(prev, key, service) as Context.Context<never>
        try {
          return step(state)
        } finally {
          state.context = prev
        }
      },
      self.name,
      { _tag: "Provide", self }
    )
  }
)

/**
 * Provides a context of services to a parser.
 *
 * @since 0.1.0
 * @category services
 */
export const provide: {
  <R2>(
    context: Context.Context<R2>
  ): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E, Exclude<R, R2>, I>
  <A, E, R, I extends Input, R2>(
    self: Parser<A, E, R, I>,
    context: Context.Context<R2>
  ): Parser<A, E, Exclude<R, R2>, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, R2>(
    self: Parser<A, E, R, I>,
    context: Context.Context<R2>
  ): Parser<A, E, Exclude<R, R2>, I> => {
    const step = self.step
    return described(
      (state) => {
        const prev = state.context
        state.context = Context.merge(prev, context) as Context.Context<never>
        try {
          return step(state)
        } finally {
          state.context = prev
        }
      },
      self.name,
      { _tag: "Provide", self }
    )
  }
)

// -----------------------------------------------------------------------------
// Error recovery
// -----------------------------------------------------------------------------

/**
 * Error recovery: if the parser fails, record the failure, skip input with
 * `recover`, and continue with `Option.none()` (winnow's `resume_after`).
 *
 * Recovery is only active when running with {@link parseRecoverable}. Under
 * the other runners the parser behaves like `Parser.asSome(self)`.
 *
 * @since 0.1.0
 * @category error recovery
 */
export const resumeAfter: {
  <B, E2, R2, I2 extends Input>(
    recover: Parser<B, E2, R2, I2>
  ): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<Option.Option<A>, E | E2, R | R2, I & I2>
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    recover: Parser<B, E2, R2, I2>
  ): Parser<Option.Option<A>, E | E2, R | R2, I & I2>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    recover: Parser<B, E2, R2, I2>
  ): Parser<Option.Option<A>, E | E2, R | R2, I & I2> => {
    const step = self.step
    const recoverStep = recover.step
    return described(
      (state) => {
        const start = state.pos
        const a = step(state)
        if (a !== Fail) return Option.some(a)
        if (state.recovered === undefined || state.mode === "Incomplete") return Fail
        const failure = state.failure
        const mode = state.mode
        state.pos = start
        if (recoverStep(state) === Fail) return state.failWith(mode, failure)
        state.recovered.push(failure)
        state.syntax?.skipped(start, failure, mode)
        return Option.none()
      },
      self.name,
      { _tag: "ResumeAfter", self, recover }
    )
  }
)

/**
 * Error recovery: if the parser fails, record the failure, skip input with
 * `recover`, and try the parser again (winnow's `retry_after`).
 *
 * Recovery is only active when running with {@link parseRecoverable}. Under
 * the other runners the parser behaves like `self`.
 *
 * @since 0.1.0
 * @category error recovery
 */
export const retryAfter: {
  <B, E2, R2, I2 extends Input>(
    recover: Parser<B, E2, R2, I2>
  ): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E | E2, R | R2, I & I2>
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    recover: Parser<B, E2, R2, I2>
  ): Parser<A, E | E2, R | R2, I & I2>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
    self: Parser<A, E, R, I>,
    recover: Parser<B, E2, R2, I2>
  ): Parser<A, E | E2, R | R2, I & I2> => {
    const step = self.step
    const recoverStep = recover.step
    return described(
      (state) => {
        while (true) {
          const start = state.pos
          const a = step(state)
          if (a !== Fail) return a
          if (state.recovered === undefined || state.mode === "Incomplete") return Fail
          const failure = state.failure
          const mode = state.mode
          state.pos = start
          if (recoverStep(state) === Fail || state.pos === start) return state.failWith(mode, failure)
          state.recovered.push(failure)
          state.syntax?.skipped(start, failure, mode)
        }
      },
      self.name,
      { _tag: "RetryAfter", self, recover }
    )
  }
)

// -----------------------------------------------------------------------------
// Debugging
// -----------------------------------------------------------------------------

/**
 * Traces the execution of a parser (winnow's `trace`). When a tracer is
 * installed (see the `trace` option of {@link parse}), `Enter` and `Exit`
 * events are reported for each traced parser; otherwise tracing has no
 * effect.
 *
 * @since 0.1.0
 * @category debugging
 */
export const trace: {
  (name: string): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E, R, I>
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, name: string): Parser<A, E, R, I>
} = /*#__PURE__*/ dual(2, <A, E, R, I extends Input>(self: Parser<A, E, R, I>, name: string): Parser<A, E, R, I> => {
  const step = self.step
  return described(
    (state) => {
      const tracer = state.tracer
      if (tracer === undefined) return step(state)
      const start = state.pos
      const depth = state.depth
      tracer({ _tag: "Enter", name, depth, offset: start, state })
      state.depth = depth + 1
      const a = step(state)
      state.depth = depth
      tracer({
        _tag: "Exit",
        name,
        depth,
        offset: start,
        endOffset: state.pos,
        result: a === Fail ? state.mode : "Ok",
        state
      })
      return a
    },
    name,
    { _tag: "Trace", self, name }
  )
})

const preview = (state: State<any>, offset: number): string => {
  const input = state.input
  if (typeof input === "string") {
    const s = input.slice(offset, offset + 24)
    return JSON.stringify(s) + (offset + 24 < input.length ? "…" : "∅")
  }
  if (input instanceof Uint8Array) {
    return Array.from(input.subarray(offset, offset + 12), (b) => b.toString(16).padStart(2, "0")).join(" ")
  }
  return `[${offset}/${input.length}]`
}

/**
 * A tracer that writes an indented trace to `console.log`, similar to
 * winnow's `debug` feature.
 *
 * @since 0.1.0
 * @category debugging
 */
export const consoleTracer = (event: TraceEvent): void => {
  const indent = "  ".repeat(event.depth)
  if (event._tag === "Enter") {
    console.log(`${indent}> ${event.name} @${event.offset} | ${preview(event.state, event.offset)}`)
  } else {
    const consumed = (event.endOffset ?? event.offset) - event.offset
    console.log(`${indent}< ${event.name} | ${event.result === "Ok" ? `+${consumed}` : event.result}`)
  }
}

// -----------------------------------------------------------------------------
// Compiled parsers
// -----------------------------------------------------------------------------

/** Returned by {@link runCompiled} when there is no compiled form to run. */
const NotCompiled: unique symbol = /*#__PURE__*/ Symbol("NotCompiled")

/**
 * Runs the compiled form of `self`, if it has one: returns its value, or
 * `Fail` when it failed (or, with `whole`, did not consume the whole
 * input), in which case the state must be thrown away. `resumable` selects
 * the build that handles partial input.
 */
const runCompiled = <I extends Input>(
  self: Parser.Any,
  state: State<I>,
  whole: boolean,
  resumable = false
): unknown => {
  if (state.tracer !== undefined || state.recovered !== undefined) return NotCompiled
  const step = Registry.stepFor(self, state, resumable)
  if (step === undefined) return NotCompiled
  const a = Stack.run(step, state)
  if (a === Fail || (whole && state.pos < state.end)) return Fail
  return a
}

// -----------------------------------------------------------------------------
// Running
// -----------------------------------------------------------------------------

/**
 * Options accepted by the runners.
 *
 * @since 0.1.0
 * @category running
 */
export interface ParseOptions {
  /**
   * Install a tracer for {@link trace}d parsers: `true` uses
   * {@link consoleTracer}.
   */
  readonly trace?: boolean | ((event: TraceEvent) => void) | undefined
  /**
   * Where to start parsing (default `0`): in code units for strings, bytes
   * for byte input and elements for arrays. The result is that of parsing
   * `input.slice(offset)`, but without copying the input, and every offset
   * (`parsePartial`'s `Done`, `location`, spans, `ParseError.offset` and its
   * line and column) is a position in the whole input. This is what an
   * incremental driver, such as a lexer reading one token at a time from a
   * buffer, needs: compiled parsers run compiled from any offset.
   *
   * Throws a `RangeError` unless it is an integer from `0` to the input's
   * length.
   */
  readonly offset?: number | undefined
}

/**
 * Options accepted by the runners for parsers that require services.
 *
 * @since 0.1.0
 * @category running
 */
export interface ParseOptionsWithContext<R> extends ParseOptions {
  readonly context: Context.Context<R>
}

const makeState = <I extends Input>(
  input: I | Source<I>,
  options: (ParseOptions & { readonly context?: Context.Context<any> }) | undefined,
  partial: boolean
): State<I> => {
  const offset = options?.offset
  const state = new State(input, { partial, context: options?.context, offset })
  if (offset !== undefined && !(Number.isInteger(offset) && offset >= 0 && offset <= state.end)) {
    throw new RangeError(`Invalid offset ${offset} for an input of length ${state.end}`)
  }
  const t = options?.trace
  if (t !== undefined && t !== false) state.tracer = t === true ? consoleTracer : t
  return state
}

const toError = <E>(state: State<any>): ParseError.ParseError<E> =>
  ParseError.fromFailure<E>(state.input, state.reportedFailure(), state.mode, state.encoding)

/** Runs a parser against a complete input, compiled when possible. */
const parseComplete = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>,
  input: I | Source<I>,
  options: (ParseOptions & { readonly context?: Context.Context<any> }) | undefined
): Result.Result<A, ParseError.ParseError<E>> => {
  const state = makeState(input, options, false)
  const a = runCompiled(self, state, true)
  if (a === NotCompiled) return runComplete(self, state)
  if (a !== Fail) return Result.succeed(a as A)
  // Re-run interpreted for the diagnostics
  return runComplete(self, makeState(input, options, false))
}

const runComplete = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>,
  state: State<I>
): Result.Result<A, ParseError.ParseError<E>> => {
  const a = Stack.run(self.step, state)
  if (a === Fail) return Result.fail(toError(state))
  if (state.pos < state.end) {
    state.backtrack("Eof", expectedEof)
    return Result.fail(toError(state))
  }
  return Result.succeed(a)
}

/**
 * Runs a parser against a complete input, requiring the whole input to be
 * consumed (winnow's `Parser::parse`).
 *
 * @example
 * ```ts
 * import { Result } from "effect"
 * import { Ascii, Parser } from "@thomasfosterau/effect-parse"
 *
 * Parser.parse(Ascii.decInt, "-42") // Result.succeed(-42)
 * Result.isFailure(Parser.parse(Ascii.decInt, "42x")) // true
 * ```
 *
 * @since 0.1.0
 * @category running
 */
export const parse: {
  <A, E, I extends Input>(
    self: Parser<A, E, never, I>,
    input: NoInfer<Source<I>>,
    options?: ParseOptions
  ): Result.Result<A, ParseError.ParseError<E>>
  <A, E, R, I extends Input>(
    self: Parser<A, E, R, I>,
    input: NoInfer<Source<I>>,
    options: ParseOptionsWithContext<R>
  ): Result.Result<A, ParseError.ParseError<E>>
} = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>,
  input: I | Source<I>,
  options?: ParseOptions & { readonly context?: Context.Context<R> }
): Result.Result<A, ParseError.ParseError<E>> => parseComplete(self, input, options)

/**
 * Like {@link parse}, but throws the `ParseError` on failure.
 *
 * @since 0.1.0
 * @category running
 */
export const parseSync: {
  <A, E, I extends Input>(self: Parser<A, E, never, I>, input: NoInfer<Source<I>>, options?: ParseOptions): A
  <A, E, R, I extends Input>(
    self: Parser<A, E, R, I>,
    input: NoInfer<Source<I>>,
    options: ParseOptionsWithContext<R>
  ): A
} = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>,
  input: I | Source<I>,
  options?: ParseOptions & { readonly context?: Context.Context<R> }
): A => {
  const result = parseComplete(self, input, options)
  if (Result.isSuccess(result)) return result.success
  throw result.failure
}

/**
 * Runs a parser against the start of an input, returning the remaining
 * input along with the output, nom-style (winnow's `parse_peek`, nom's
 * `IResult`).
 *
 * The parser ended at offset `input.length - remaining.length`, which is
 * how a caller running from an `offset` (see {@link ParseOptions}) finds
 * where to continue.
 *
 * @since 0.1.0
 * @category running
 */
export const parsePeek: {
  <A, E, I extends Input>(
    self: Parser<A, E, never, I>,
    input: NoInfer<Source<I>>,
    options?: ParseOptions
  ): Result.Result<[remaining: Slice<I>, output: A], ParseError.ParseError<E>>
  <A, E, R, I extends Input>(
    self: Parser<A, E, R, I>,
    input: NoInfer<Source<I>>,
    options: ParseOptionsWithContext<R>
  ): Result.Result<[remaining: Slice<I>, output: A], ParseError.ParseError<E>>
} = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>,
  input: I | Source<I>,
  options?: ParseOptions & { readonly context?: Context.Context<R> }
): Result.Result<[remaining: Slice<I>, output: A], ParseError.ParseError<E>> => {
  let state = makeState(input, options, false)
  const compiled = runCompiled(self, state, false)
  if (compiled !== NotCompiled && compiled !== Fail) {
    return Result.succeed([state.slice(state.pos, state.end), compiled as A])
  }
  if (compiled === Fail) state = makeState(input, options, false)
  const a = Stack.run(self.step, state)
  if (a === Fail) return Result.fail(toError(state))
  return Result.succeed([state.slice(state.pos, state.end), a])
}

/**
 * The outcome of parsing a partial (streaming) input.
 *
 * - `Done`: the parser succeeded, consuming input up to `offset`.
 * - `Incomplete`: more input is needed (`needed` tokens, if known).
 *
 * @since 0.1.0
 * @category running
 */
export type PartialResult<A> =
  | { readonly _tag: "Done"; readonly value: A; readonly offset: number }
  | { readonly _tag: "Incomplete"; readonly needed: Option.Option<number> }

/**
 * Runs a parser against a *partial* input, i.e. a chunk of a stream that may
 * be followed by more data (winnow's `Partial`, nom's `streaming` parsers).
 * Token parsers that reach the end of the chunk report `Incomplete` instead
 * of failing or succeeding early.
 *
 * The parser does not have to consume the whole input; the returned
 * `offset` says where it stopped. It is a position in the whole input, so
 * with the `offset` option (see {@link ParseOptions}) it is where the next
 * parse starts.
 *
 * A parser compiled with the `Compiler` module runs compiled, with a build
 * that handles partial input. When it fails or needs more input, it runs again
 * interpreted, so `Incomplete`'s `needed` and every `ParseError` are the
 * interpreter's.
 *
 * @example
 * ```ts
 * import { Ascii, Parser } from "@thomasfosterau/effect-parse"
 *
 * Parser.parsePartial(Ascii.digit1, "123")
 * // Result.succeed({ _tag: "Incomplete", needed: Option.some(1) })
 * Parser.parsePartial(Ascii.digit1, "123;")
 * // Result.succeed({ _tag: "Done", value: "123", offset: 3 })
 * ```
 *
 * @since 0.1.0
 * @category running
 */
export const parsePartial: {
  <A, E, I extends Input>(
    self: Parser<A, E, never, I>,
    input: NoInfer<Source<I>>,
    options?: ParseOptions
  ): Result.Result<PartialResult<A>, ParseError.ParseError<E>>
  <A, E, R, I extends Input>(
    self: Parser<A, E, R, I>,
    input: NoInfer<Source<I>>,
    options: ParseOptionsWithContext<R>
  ): Result.Result<PartialResult<A>, ParseError.ParseError<E>>
} = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>,
  input: I | Source<I>,
  options?: ParseOptions & { readonly context?: Context.Context<R> }
): Result.Result<PartialResult<A>, ParseError.ParseError<E>> => {
  let state = makeState(input, options, true)
  const compiled = runCompiled(self, state, false, true)
  if (compiled !== NotCompiled && compiled !== Fail) {
    return Result.succeed({ _tag: "Done", value: compiled as A, offset: state.pos })
  }
  // Re-run interpreted for `needed` and the diagnostics
  if (compiled === Fail) state = makeState(input, options, true)
  const a = Stack.run(self.step, state)
  if (a !== Fail) return Result.succeed({ _tag: "Done", value: a, offset: state.pos })
  if (state.mode === "Incomplete") {
    const needed = state.failure.needed
    return Result.succeed({ _tag: "Incomplete", needed: needed > 0 ? Option.some(needed) : Option.none() })
  }
  return Result.fail(toError(state))
}

/**
 * Runs a parser against a complete input as an `Effect`. Services required
 * by the parser are taken from the Effect's context.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Ascii, Parser } from "@thomasfosterau/effect-parse"
 *
 * const program = Effect.gen(function*() {
 *   const n = yield* Parser.parseEffect(Ascii.decInt, "42")
 *   return n + 1
 * })
 * ```
 *
 * @since 0.1.0
 * @category running
 */
export const parseEffect = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>,
  input: NoInfer<Source<I>>,
  options?: ParseOptions
): Effect.Effect<A, ParseError.ParseError<E>, R> =>
  Effect.flatMap(Effect.context<R>(), (context) =>
    Effect.fromResult(parseComplete(self, input, { ...options, context }))
  )

/**
 * The outcome of {@link parseRecoverable}.
 *
 * @since 0.1.0
 * @category running
 */
export interface RecoverableResult<A, E> {
  /** The output, if parsing ultimately succeeded. */
  readonly value: Option.Option<A>
  /** Every error encountered: recovered ones, then the fatal one (if any). */
  readonly errors: ReadonlyArray<ParseError.ParseError<E>>
}

/**
 * Runs a parser with error recovery enabled (winnow's `Recoverable`
 * stream). Failures handled by {@link resumeAfter} and {@link retryAfter}
 * are collected instead of aborting the parse.
 *
 * @since 0.1.0
 * @category running
 */
export const parseRecoverable: {
  <A, E, I extends Input>(
    self: Parser<A, E, never, I>,
    input: NoInfer<Source<I>>,
    options?: ParseOptions
  ): RecoverableResult<A, E>
  <A, E, R, I extends Input>(
    self: Parser<A, E, R, I>,
    input: NoInfer<Source<I>>,
    options: ParseOptionsWithContext<R>
  ): RecoverableResult<A, E>
} = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>,
  input: I | Source<I>,
  options?: ParseOptions & { readonly context?: Context.Context<R> }
): RecoverableResult<A, E> => {
  const state = makeState(input, options, false)
  const recovered: Array<Failure> = []
  state.recovered = recovered
  const result = runComplete(self, state)
  const errors = recovered.map((f) => ParseError.fromFailure<E>(state.input, f, "Backtrack", state.encoding))
  if (Result.isSuccess(result)) return { value: Option.some(result.success), errors }
  errors.push(result.failure)
  return { value: Option.none(), errors }
}

// -----------------------------------------------------------------------------
// Low-level helpers
// -----------------------------------------------------------------------------

/**
 * Records a failure kind for use in custom parsers; re-exported for
 * convenience.
 *
 * @since 0.1.0
 * @category models
 */
export type { ErrorKind }
