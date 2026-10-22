/**
 * Running parsers over Effect `Stream`s of input chunks.
 *
 * This is where nom's and winnow's *partial* (streaming) parsing meets
 * Effect: chunks are buffered and the parser runs in partial mode, so a
 * value split across chunk boundaries is reported as `Incomplete` and
 * retried once more data arrives. When the stream ends, the leftover input
 * is parsed in complete mode.
 *
 * @example
 * ```ts
 * import { Effect, Stream } from "effect"
 * import { Ascii, Parser, ParserStream, Token } from "@thomasfosterau/effect-parse"
 *
 * const line = Parser.terminated(Ascii.decInt, Token.literal("\n"))
 *
 * const program = Stream.make("1\n2", "3\n", "4\n").pipe(
 *   ParserStream.parseMany(line),
 *   Stream.runCollect
 * )
 * // Effect.runSync(program) => [1, 23, 4]
 * ```
 *
 * @since 0.1.0
 */
import type * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Stream from "effect/Stream"
import type { BinaryInput, Input, Source } from "./Input.js"
import { Fail, Failure, fromSource, State } from "./Input.js"
import * as ParseError from "./ParseError.js"
import * as Registry from "./internal/compiler/registry.js"
import type * as Resume from "./internal/resume.js"
import * as Stack from "./internal/stack.js"
import type { Parser } from "./Parser.js"

/**
 * Input kinds that can be streamed in chunks.
 *
 * @since 0.1.0
 * @category models
 */
export type Chunkable = string | Uint8Array | ReadonlyArray<unknown>

const concat = <I extends Chunkable>(a: I, b: I): I => {
  if (typeof a === "string") return (a + (b as string)) as I
  if (a instanceof Uint8Array) {
    if (a.length === 0) return b
    const out = new Uint8Array(a.length + (b as Uint8Array).length)
    out.set(a)
    out.set(b as Uint8Array, a.length)
    return out as I
  }
  return [...a, ...(b as ReadonlyArray<unknown>)] as unknown as I
}

const sliceFrom = <I extends Chunkable>(input: I, offset: number): I =>
  (typeof input === "string" ? input.slice(offset) : input.slice(offset)) as I

const noProgress = (input: Input, offset: number) =>
  ParseError.fromFailure<never>(
    input,
    new Failure(offset, "Assert", [], [], false, undefined, "`parseMany` parsers must always consume", 0),
    "Cut"
  )

/**
 * Options for {@link parseMany}.
 *
 * @since 0.1.0
 * @category models
 */
export interface ParseManyOptions<I> {
  /** The empty input, used to initialise the buffer (inferred from the first chunk if omitted). */
  readonly empty?: Source<I> | undefined
}

/**
 * Transforms a stream of input chunks into a stream of parsed values by
 * applying `parser` repeatedly. Each application must consume input.
 *
 * Services required by the parser are taken from the stream's context.
 * Error offsets are relative to the internal buffer of unconsumed input,
 * which is also the `input` of the reported `ParseError`.
 *
 * @since 0.1.0
 * @category combinators
 */
export const parseMany: {
  <A, E, R, I extends Chunkable>(
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): <E0, R0>(self: Stream.Stream<Source<I>, E0, R0>) => Stream.Stream<A, E0 | ParseError.ParseError<E>, R0 | R>
  <I extends Chunkable, E0, R0, A, E, R>(
    self: Stream.Stream<Source<NoInfer<I>>, E0, R0>,
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): Stream.Stream<A, E0 | ParseError.ParseError<E>, R0 | R>
} = /*#__PURE__*/ dual(
  (args) => Stream.isStream(args[0]),
  <I extends Chunkable, E0, R0, A, E, R>(
    self: Stream.Stream<Source<I>, E0, R0>,
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): Stream.Stream<A, E0 | ParseError.ParseError<E>, R0 | R> =>
    Stream.suspend(() => {
      const step = parser.step
      let buffer: I | undefined = options?.empty === undefined ? undefined : fromSource<I>(options.empty)

      const drain = (context: any, partial: boolean): Effect.Effect<Array<A>, ParseError.ParseError<E>> => {
        const out: Array<A> = []
        if (buffer === undefined) return Effect.succeed(out)
        const input = buffer
        let offset = 0
        while (offset < input.length) {
          const state = new State(input, { partial, context, offset })
          const a = Stack.run(step, state)
          if (a === Fail) {
            if (partial && state.mode === "Incomplete") break
            return Effect.fail(ParseError.fromFailure<E>(input, state.reportedFailure(), state.mode, state.encoding))
          }
          if (state.pos === offset) return Effect.fail(noProgress(input, offset))
          out.push(a)
          offset = state.pos
        }
        buffer = sliceFrom(input, offset)
        return Effect.succeed(out)
      }

      const feed = (source: Source<I>) =>
        Effect.flatMap(Effect.context<R>(), (context) =>
          Effect.suspend(() => {
            const chunk = fromSource<I>(source)
            buffer = buffer === undefined ? chunk : concat(buffer, chunk)
            return drain(context, true)
          })
        )

      const finish = Effect.flatMap(Effect.context<R>(), (context) => Effect.suspend(() => drain(context, false)))

      return self.pipe(
        Stream.mapEffect(feed),
        Stream.flattenIterable,
        Stream.concat(Stream.unwrap(Effect.map(finish, Stream.fromIterable)))
      )
    })
)

/**
 * Parses a stream of chunks incrementally, as one input. Chunks are parsed
 * as they arrive, in partial mode; when the parser runs out of input, its
 * repetitions keep checkpoints (see `internal/resume.ts`), so the next
 * attempt carries on from where the last one stopped instead of starting
 * over.
 */
class Incremental<A, E, I extends Chunkable> {
  private kind: 0 | 1 | 2 | undefined
  private text = ""
  private bytes = new Uint8Array(0)
  private items: Array<unknown> = []
  private length = 0
  private readonly resume: Resume.Checkpoints = new Map()
  /** The input length at the last attempt, and where that attempt ran out of input. */
  private attempted = 0
  private restart = 0
  /** Set once an attempt settles: a success (with its end offset) or a definite failure. */
  private settled: { readonly value: A; readonly pos: number } | "failed" | undefined

  constructor(
    private readonly parser: Parser<A, E, any, I>,
    private readonly context: Context.Context<never>,
    empty: I | undefined
  ) {
    if (empty !== undefined) this.append(empty)
  }

  private append(chunk: I): void {
    if (typeof chunk === "string") {
      this.kind ??= 0
      this.text += chunk
      this.length += chunk.length
    } else if (chunk instanceof Uint8Array) {
      this.kind ??= 1
      const needed = this.length + chunk.length
      if (needed > this.bytes.length) {
        // Grow geometrically, so appending costs amortized constant time per byte
        const grown = new Uint8Array(Math.max(needed, this.bytes.length * 2, 4096))
        grown.set(this.bytes.subarray(0, this.length))
        this.bytes = grown
      }
      this.bytes.set(chunk, this.length)
      this.length = needed
    } else {
      this.kind ??= 2
      for (let i = 0; i < chunk.length; i++) this.items.push(chunk[i])
      this.length = this.items.length
    }
  }

  private input(): I {
    switch (this.kind) {
      case 1:
        return this.bytes.subarray(0, this.length) as I
      case 2:
        // Items are only appended between attempts, after each state has read its `end`
        return this.items as unknown as I
      default:
        return this.text as I
    }
  }

  push(chunk: I): void {
    if (chunk.length === 0) return
    this.append(chunk)
    if (this.settled !== undefined) return
    // An attempt re-reads what the last one could not finish, from `restart`;
    // waiting until at least half as much new input has arrived keeps the
    // total work linear in the input. Strings are also copied when they are
    // flattened, so they wait for a fraction of the whole input too.
    const added = this.length - this.attempted
    if (added < (this.attempted - this.restart) / 2) return
    if (this.kind === 0 && added < this.attempted / 8) return
    this.attempt()
  }

  /** The step attempts run: the parser's resumable compiled code if it was compiled, else the interpreter. */
  private step(state: State<I>): unknown {
    return Stack.run(Registry.stepFor(this.parser, state, true) ?? this.parser.step, state)
  }

  private attempt(): void {
    const state = new State(this.input(), { partial: true, context: this.context })
    state.resume = this.resume
    const a = this.step(state)
    this.attempted = this.length
    if (a !== Fail) {
      this.settled = { value: a as A, pos: state.pos }
    } else if (state.mode === "Incomplete") {
      this.restart = state.failure.offset
    } else {
      this.settled = "failed"
    }
  }

  finish(): Effect.Effect<A, ParseError.ParseError<E>> {
    const settled = this.settled
    if (settled !== undefined && settled !== "failed") {
      if (settled.pos === this.length) return Effect.succeed(settled.value)
    } else if (settled === undefined) {
      // The last attempt, in complete mode, resumes from the checkpoints too
      const state = new State(this.input(), { context: this.context })
      state.resume = this.resume
      const a = this.step(state)
      if (a !== Fail && state.pos === state.end) return Effect.succeed(a as A)
    }
    // The error comes from an ordinary parse of the whole input, so it is the
    // same as if the input had been parsed in one go
    const all = this.input()
    const state = new State(all, { context: this.context })
    const a = Stack.run(this.parser.step, state)
    if (a !== Fail && state.pos === state.end) return Effect.succeed(a)
    if (a !== Fail) state.backtrack("Eof", ["end of input"])
    return Effect.fail(ParseError.fromFailure<E>(all, state.reportedFailure(), state.mode, state.encoding))
  }
}

/**
 * Parses an entire stream of chunks as a single complete input.
 *
 * Parsing does not wait for the stream to end: each chunk is parsed as it
 * arrives, in partial mode, and when the parser runs out of input its
 * repetitions (`repeat`, `separated`, `fold`, `escaped`, ...) remember how
 * far they got, so that the next attempt resumes there rather than starting
 * over. A large document, such as the body of a `fetch` response, is
 * therefore parsed while it downloads, and is ready soon after its last
 * byte. Use {@link parseReadable} or {@link parseResponse} for web streams.
 *
 * The result and any `ParseError` are those of parsing the whole input at
 * once: errors are reported once the stream has ended, by an ordinary
 * interpreted parse of the whole input. A parser compiled with the
 * `Compiler` module streams compiled too (with a build that handles partial
 * input), which is several times faster. As with compiled parsers,
 * callbacks should be pure: the elements parsed before a checkpoint are
 * not parsed again, and on failure everything is parsed again.
 *
 * @since 0.1.0
 * @category combinators
 */
export const parseAll: {
  <A, E, R, I extends Chunkable>(
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): <E0, R0>(self: Stream.Stream<Source<I>, E0, R0>) => Effect.Effect<A, E0 | ParseError.ParseError<E>, R0 | R>
  <I extends Chunkable, E0, R0, A, E, R>(
    self: Stream.Stream<Source<NoInfer<I>>, E0, R0>,
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): Effect.Effect<A, E0 | ParseError.ParseError<E>, R0 | R>
} = /*#__PURE__*/ dual(
  (args) => Stream.isStream(args[0]),
  <I extends Chunkable, E0, R0, A, E, R>(
    self: Stream.Stream<Source<I>, E0, R0>,
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): Effect.Effect<A, E0 | ParseError.ParseError<E>, R0 | R> =>
    Effect.flatMap(Effect.context<R>(), (context) =>
      Effect.suspend(() => {
        const empty = options?.empty === undefined ? undefined : fromSource<I>(options.empty)
        const incremental = new Incremental(parser, context as Context.Context<never>, empty)
        return Effect.flatMap(
          Stream.runForEach(self, (chunk) => Effect.sync(() => incremental.push(fromSource<I>(chunk)))),
          () => Effect.suspend(() => incremental.finish())
        )
      })
    )
)

/**
 * An error reading a `ReadableStream` given to {@link parseReadable} or
 * {@link parseResponse}.
 *
 * @since 0.1.0
 * @category errors
 */
export class ReadError extends /*#__PURE__*/ Data.TaggedError("ReadError")<{ readonly cause: unknown }> {}

/**
 * Parses a web `ReadableStream` of bytes, such as the body of a `fetch`
 * response, incrementally (see {@link parseAll}): the bytes are parsed as
 * they arrive, without waiting for the end of the stream or decoding them
 * first. Use a byte parser, e.g. one built from `Text.utf8`.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Parser, ParserStream, Text } from "@thomasfosterau/effect-parse"
 *
 * const csvLine = Parser.separated(Text.utf8.takeTill(",\n"), Text.utf8.literal(","))
 * const csv = Parser.separated(csvLine, Text.utf8.literal("\n"))
 *
 * const response = await fetch("https://example.com/data.csv")
 * const rows = await Effect.runPromise(ParserStream.parseReadable(response.body!, csv))
 * ```
 *
 * @since 0.1.0
 * @category combinators
 */
export const parseReadable: {
  <A, E, R>(
    parser: Parser<A, E, R, Uint8Array>
  ): (self: ReadableStream<BinaryInput>) => Effect.Effect<A, ParseError.ParseError<E> | ReadError, R>
  <A, E, R>(
    self: ReadableStream<BinaryInput>,
    parser: Parser<A, E, R, Uint8Array>
  ): Effect.Effect<A, ParseError.ParseError<E> | ReadError, R>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R>(
    self: ReadableStream<BinaryInput>,
    parser: Parser<A, E, R, Uint8Array>
  ): Effect.Effect<A, ParseError.ParseError<E> | ReadError, R> =>
    parseAll(
      Stream.fromReadableStream({ evaluate: () => self, onError: (cause) => new ReadError({ cause }) }),
      parser,
      { empty: new Uint8Array(0) }
    )
)

/**
 * Parses the body of a `fetch` `Response` incrementally, as it downloads
 * (see {@link parseReadable}). A response without a body is parsed as empty
 * input. The status is not checked.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Parser, ParserStream, Text } from "@thomasfosterau/effect-parse"
 *
 * const lines = Parser.separated(Text.utf8.tillLineEnding, Text.utf8.lineEnding)
 *
 * const response = await fetch("https://example.com/log.txt")
 * const value = await Effect.runPromise(ParserStream.parseResponse(response, lines))
 * ```
 *
 * @since 0.1.0
 * @category combinators
 */
export const parseResponse: {
  <A, E, R>(
    parser: Parser<A, E, R, Uint8Array>
  ): (self: Response) => Effect.Effect<A, ParseError.ParseError<E> | ReadError, R>
  <A, E, R>(
    self: Response,
    parser: Parser<A, E, R, Uint8Array>
  ): Effect.Effect<A, ParseError.ParseError<E> | ReadError, R>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R>(
    self: Response,
    parser: Parser<A, E, R, Uint8Array>
  ): Effect.Effect<A, ParseError.ParseError<E> | ReadError, R> =>
    parseReadable(self.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }), parser)
)
