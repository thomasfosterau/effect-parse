/**
 * Running parsers over Effect `Stream`s of input chunks.
 *
 * This is where nom's and winnow's *partial* (streaming) parsing meets
 * Effect: chunks are buffered and the parser runs in partial mode, so a
 * value split across chunk boundaries is reported as `Incomplete` and
 * retried once more data arrives. When the stream ends, the leftover input
 * is parsed in complete mode.
 *
 * Every runner bounds what it buffers: `maxBufferSize` (see
 * {@link BufferOptions}) defaults to 64 MiB ({@link defaultMaxBufferSize}),
 * and a stream that exceeds it fails with a {@link BufferLimitError}, so a
 * socket or an HTTP body can be parsed without wrapping the stream first.
 * Pass `Infinity` for input that is trusted to be large.
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
import * as Predicate from "effect/Predicate"
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
import * as Run from "./internal/run.js"
import * as Stack from "./internal/stack.js"
import { isEmptyUnits } from "./internal/text.js"
import type { Parser } from "./Parser.js"
import { isParser } from "./Parser.js"

/**
 * Input kinds that can be streamed in chunks.
 *
 * @since 0.1.0
 * @category models
 */
export type Chunkable = string | Uint8Array | ReadonlyArray<unknown>

/**
 * The default `maxBufferSize` of {@link parseMany}, {@link parseAll},
 * {@link parseReadable} and {@link parseResponse}: 64 MiB, counted in tokens
 * of the input (UTF-16 code units of a string, bytes of a `Uint8Array`,
 * elements of an array).
 *
 * @since 0.6.0
 * @category constants
 */
export const defaultMaxBufferSize: number = 64 * 1024 * 1024

/**
 * A stream runner would have buffered more than its `maxBufferSize`: `size`
 * tokens against a limit of `limit`. It is a different failure from a
 * `ParseError`: the input is too large, not malformed (an HTTP server
 * answers 413 for the one and 400 for the other), and nothing of the input
 * is attached to it.
 *
 * @example
 * ```ts
 * import { Effect, Stream } from "effect"
 * import { Parser, ParserStream, Token } from "@thomasfosterau/effect-parse"
 *
 * const line = Parser.terminated(Token.takeTill("\n"), Token.literal("\n"))
 *
 * Stream.make("no newline, ", "ever").pipe(
 *   ParserStream.parseMany(line, { maxBufferSize: 8 }),
 *   Stream.runCollect,
 *   Effect.catchTag("BufferLimitError", (e) => Effect.succeed(`too large: ${e.size} > ${e.limit}`))
 * )
 * ```
 *
 * @since 0.6.0
 * @category errors
 */
export class BufferLimitError
  extends /*#__PURE__*/ Data.TaggedError("BufferLimitError")<{
    /** The `maxBufferSize` in force, in tokens. */
    readonly limit: number
    /** The tokens the runner held, or was about to hold (for `parseResponse`, the declared `Content-Length`). */
    readonly size: number
  }>
{
  override get message(): string {
    return `the input is larger than maxBufferSize: ${this.size} tokens, limit ${this.limit}`
  }
}

/**
 * The limit on buffered input that the stream runners share.
 *
 * @since 0.6.0
 * @category models
 */
export interface BufferOptions {
  /**
   * The most tokens a runner buffers (UTF-16 code units of a string, bytes
   * of a `Uint8Array`, elements of an array) before it fails with a
   * {@link BufferLimitError}. Defaults to {@link defaultMaxBufferSize}
   * (64 MiB); `Infinity` turns the limit off.
   *
   * {@link parseMany} counts the input it has not consumed yet, which is one
   * unfinished value: complete values in a chunk are parsed and emitted
   * first, whatever the chunk's size. {@link parseAll},
   * {@link parseReadable} and {@link parseResponse} hold the whole input, so
   * they count all of it.
   */
  readonly maxBufferSize?: number | undefined
}

/** The limit `options` asks for: a positive number of tokens, or `Infinity`. */
const limitOf = (options: BufferOptions | undefined): number => {
  const limit = options?.maxBufferSize ?? defaultMaxBufferSize
  if (!(limit > 0)) throw new RangeError("maxBufferSize must be a positive number of tokens, or Infinity")
  return limit
}

/**
 * Above this many unconsumed tokens, {@link parseMany} stops retrying its
 * unfinished value on every chunk (see {@link Pending.due}).
 */
const BackoffThreshold = 64 * 1024

/**
 * The input `parseMany` has not consumed yet: what is left of the chunks
 * after the values parsed from them, which is one unfinished value.
 *
 * Appending is amortized constant time per token: text is concatenated (a
 * rope until it is parsed), bytes go into a buffer that doubles, and
 * elements are pushed. Bytes that a parse has seen are never overwritten,
 * since the values parsed from them may be views of the buffer
 * (`Token.take` returns a `subarray`): the buffer is only ever appended to
 * past its end, or replaced by a larger one.
 */
class Pending<I extends Chunkable> {
  private kind: 0 | 1 | 2 | undefined
  private text = ""
  private bytes: Uint8Array = new Uint8Array(0)
  /** Where the unconsumed bytes start and end in `bytes`, and how far `bytes` may be written. */
  private start = 0
  private end = 0
  private capacity = 0
  private items: Array<unknown> = []
  /** The unconsumed size at the last attempt that ran out of input, or 0 when none is outstanding. */
  private attempted = 0

  /** The number of unconsumed tokens. */
  get size(): number {
    return this.kind === 1 ? this.end - this.start : this.kind === 2 ? this.items.length : this.text.length
  }

  get isEmpty(): boolean {
    return this.kind === undefined
  }

  append(chunk: I): void {
    if (Predicate.isString(chunk)) {
      this.kind ??= 0
      this.text += chunk
    } else if (chunk instanceof Uint8Array) {
      this.kind ??= 1
      this.appendBytes(chunk)
    } else {
      this.kind ??= 2
      for (let i = 0; i < chunk.length; i++) this.items.push(chunk[i])
    }
  }

  private appendBytes(chunk: Uint8Array): void {
    const held = this.end - this.start
    if (held === 0) {
      // Nothing is pending: the chunk is the buffer, uncopied. It is the
      // caller's, so it is never written to (`capacity` is its end)
      this.bytes = chunk
      this.start = 0
      this.end = this.capacity = chunk.length
      return
    }
    const needed = held + chunk.length
    if (this.end + chunk.length > this.capacity) {
      // Twice what is needed, so appending costs amortized constant time per byte
      const grown = new Uint8Array(Math.max(needed * 2, 4096))
      grown.set(this.bytes.subarray(this.start, this.end))
      this.bytes = grown
      this.start = 0
      this.end = held
      this.capacity = grown.length
    }
    this.bytes.set(chunk, this.end)
    this.end += chunk.length
  }

  /** The unconsumed input. */
  input(): I {
    if (this.kind === 1) {
      // SAFETY: `kind` 1 is set by the first chunk being a `Uint8Array`, so `I` is `Uint8Array`
      return this.bytes.subarray(this.start, this.end) as I
    }
    if (this.kind === 2) {
      const items: Chunkable = this.items
      // SAFETY: `kind` 2 is set by the first chunk being an array, so `I` is an array of the items' type
      return items as I
    }
    // SAFETY: `kind` 0 is set by the first chunk being a string, so `I` is `string`
    return this.text as I
  }

  /** Drops the first `count` tokens, which values were parsed from. */
  consume(count: number): void {
    if (count === 0) return
    if (this.kind === 1) this.start += count
    // A new array: the one parsed is the `input` of the state that read it
    else if (this.kind === 2) this.items = this.items.slice(count)
    else this.text = this.text.slice(count)
  }

  /** Records whether the attempt just made left an unfinished value. */
  attemptedWith(unfinished: boolean): void {
    this.attempted = unfinished ? this.size : 0
  }

  /**
   * Whether to parse now. A value that is still unfinished is parsed again
   * from its start, so retrying on every chunk costs the square of its
   * size: a megabyte with no delimiter, in 1 KiB chunks, took seconds. Past
   * {@link BackoffThreshold} tokens, the next attempt therefore waits until
   * the buffer has grown by an eighth, which keeps the total work linear
   * (each token is re-read at most about nine times). Smaller values are
   * retried on every chunk, as cheaply as before, so a record is emitted
   * as soon as its last chunk arrives.
   */
  due(): boolean {
    const attempted = this.attempted
    return attempted <= BackoffThreshold || this.size - attempted >= attempted >>> 3
  }
}

const noProgress = (input: Input, offset: number) =>
  ParseError.fromFailure<never>(
    input,
    new Failure(offset, "Assert", [], [], false, undefined, "`parseMany` parsers must always consume", 0),
    "Cut"
  )

/**
 * Options for {@link parseMany} and {@link parseAll}.
 *
 * @since 0.1.0
 * @category models
 */
export interface ParseManyOptions<I> extends BufferOptions {
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
 * A parser compiled with the `Compiler` module runs compiled, with the
 * build that handles partial input (see `Parser.run`); a value that fails
 * is parsed again interpreted, so errors are the interpreter's. A value
 * cut short by its chunk is not: compiled code reports `Incomplete` where
 * the interpreter does.
 *
 * **Untrusted streams.** The input not yet consumed (one unfinished value)
 * is limited to `maxBufferSize` tokens, 64 MiB by default
 * ({@link defaultMaxBufferSize}); past it the stream fails with a
 * {@link BufferLimitError}, so a peer that never sends the delimiter cannot
 * grow the buffer without bound. An unfinished value is parsed again from
 * its start when more input arrives. Up to 64 KiB that happens on every
 * chunk; a larger one is retried only once the buffer has grown by an
 * eighth, so the work stays linear in its size. The cost: the last chunk of
 * a value larger than 64 KiB may not complete it in the output until more
 * input arrives or the stream ends, when everything left is parsed.
 *
 * @example
 * ```ts
 * import { Effect, Stream } from "effect"
 * import { Ascii, Parser, ParserStream, Token } from "@thomasfosterau/effect-parse"
 *
 * const line = Parser.terminated(Ascii.decInt, Token.literal("\n"))
 *
 * const program = Stream.make("1\n2", "3\n", "4\n").pipe(
 *   ParserStream.parseMany(line, { maxBufferSize: 1024 }),
 *   Stream.runCollect
 * )
 * // Effect.runSync(program) => [1, 23, 4]
 * ```
 *
 * @since 0.1.0
 * @category combinators
 */
export const parseMany: {
  <A, E, R, I extends Chunkable>(
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): <E0, R0>(
    self: Stream.Stream<Source<I>, E0, R0>
  ) => Stream.Stream<A, E0 | ParseError.ParseError<E> | BufferLimitError, R0 | R>
  <I extends Chunkable, E0, R0, A, E, R>(
    self: Stream.Stream<Source<NoInfer<I>>, E0, R0>,
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): Stream.Stream<A, E0 | ParseError.ParseError<E> | BufferLimitError, R0 | R>
} = /*#__PURE__*/ dual(
  (args) => Stream.isStream(args[0]),
  <I extends Chunkable, E0, R0, A, E, R>(
    self: Stream.Stream<Source<I>, E0, R0>,
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): Stream.Stream<A, E0 | ParseError.ParseError<E> | BufferLimitError, R0 | R> => {
    const limit = limitOf(options)
    return Stream.suspend(() => {
      const step = parser.step
      const pending = new Pending<I>()
      if (options?.empty !== undefined) pending.append(fromSource<I>(options.empty))

      const drain = (
        context: any,
        partial: boolean
      ): Effect.Effect<Array<A>, ParseError.ParseError<E> | BufferLimitError> => {
        const out: Array<A> = []
        if (pending.isEmpty) return Effect.succeed(out)
        const input = pending.input()
        // One state for the whole buffer, reset before each value
        const state = new State(input)
        let offset = 0
        while (offset < input.length) {
          state.reset(offset, { partial, context })
          // A compiled `Incomplete` is the interpreter's: only an error needs the interpreted run
          const a = Run.runOn(parser, step, state, false)
          if (a === Fail) {
            if (partial && state.mode === "Incomplete") break
            state.reset(offset, { partial, context })
            Run.runOn(parser, step, state)
            return Effect.fail(ParseError.fromFailure<E>(input, state.reportedFailure(), state.mode, state.encoding))
          }
          if (state.pos === offset) return Effect.fail(noProgress(input, offset))
          out.push(a)
          offset = state.pos
        }
        pending.consume(offset)
        pending.attemptedWith(offset < input.length)
        // Only what no value consumed counts: an unfinished value larger than the limit
        const size = input.length - offset
        return size > limit ? Effect.fail(new BufferLimitError({ limit, size })) : Effect.succeed(out)
      }

      const feed = (source: Source<I>) =>
        Effect.flatMap(Effect.context<R>(), (context) =>
          Effect.suspend((): Effect.Effect<Array<A>, ParseError.ParseError<E> | BufferLimitError> => {
            pending.append(fromSource<I>(source))
            // Over the limit, parse whatever the back-off says, so that complete values are not counted
            return pending.due() || pending.size > limit ? drain(context, true) : Effect.succeed([])
          })
        )

      const finish = Effect.flatMap(Effect.context<R>(), (context) => Effect.suspend(() => drain(context, false)))

      return self.pipe(
        Stream.mapEffect(feed),
        Stream.flattenIterable,
        Stream.concat(Stream.unwrap(Effect.map(finish, Stream.fromIterable)))
      )
    })
  }
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
  private pushed = 0
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
    if (Predicate.isString(chunk)) {
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
    if (this.kind === 1) {
      // SAFETY: `kind` 1 is set by the first chunk being a `Uint8Array`, so `I` is `Uint8Array`
      return this.bytes.subarray(0, this.length) as I
    }
    if (this.kind === 2) {
      // Items are only appended between attempts, after each state has read its `end`
      const items: Chunkable = this.items
      // SAFETY: `kind` 2 is set by the first chunk being an array, so `I` is an array of the items' type
      return items as I
    }
    // SAFETY: `kind` 0 means the first chunk was a string, so `I` is `string`; while `kind` is unset (no
    // chunk arrived) `I` is unknown and the empty string stands for the empty input
    return this.text as I
  }

  /** The tokens held: the whole input so far. */
  get size(): number {
    return this.length
  }

  push(chunk: I): void {
    if (isEmptyUnits(chunk)) return
    this.append(chunk)
    if (this.settled !== undefined) return
    // The first attempt waits for a second chunk: an input that arrives in
    // one chunk (most small responses) is parsed once, by `finish`, instead
    // of once in partial mode and again in complete mode, since a repetition
    // that completes without resuming keeps no checkpoint
    if (++this.pushed === 1) return
    // An attempt re-reads what the last one could not finish, from `restart`;
    // waiting until at least half as much new input has arrived keeps the
    // total work linear in the input. Strings are also copied when they are
    // flattened, so they wait for a fraction of the whole input too.
    const added = this.length - this.attempted
    if (added < (this.attempted - this.restart) / 2) return
    if (this.kind === 0 && added < this.attempted / 8) return
    this.attempt()
  }

  /**
   * The step attempts run: the parser's compiled code if it was compiled
   * (the resumable build, unless `resumable` is false), else the interpreter.
   */
  private step(state: State<I>, resumable = true): A | Fail {
    // SAFETY: a compiled step (typed `any` by the compilers) returns what the parser's own step returns
    return Stack.run(Registry.stepFor(this.parser, state, resumable) ?? this.parser.step, state) as A | Fail
  }

  private attempt(): void {
    const state = new State(this.input(), { partial: true, context: this.context })
    state.resume = this.resume
    const a = this.step(state)
    this.attempted = this.length
    if (a !== Fail) {
      this.settled = { value: a, pos: state.pos }
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
      // The last attempt, in complete mode, resumes from the checkpoints too;
      // with no attempt before it, it is an ordinary parse
      const state = new State(this.input(), { context: this.context })
      const resumable = this.attempted > 0
      if (resumable) state.resume = this.resume
      const a = this.step(state, resumable)
      if (a !== Fail && state.pos === state.end) return Effect.succeed(a)
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
 * The whole input is held until the stream ends, so it is limited to
 * `maxBufferSize` tokens (64 MiB by default, see {@link BufferOptions}):
 * a stream that would exceed it fails with a {@link BufferLimitError}
 * before the chunk that crosses the limit is buffered.
 *
 * @since 0.1.0
 * @category combinators
 */
export const parseAll: {
  <A, E, R, I extends Chunkable>(
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): <E0, R0>(
    self: Stream.Stream<Source<I>, E0, R0>
  ) => Effect.Effect<A, E0 | ParseError.ParseError<E> | BufferLimitError, R0 | R>
  <I extends Chunkable, E0, R0, A, E, R>(
    self: Stream.Stream<Source<NoInfer<I>>, E0, R0>,
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): Effect.Effect<A, E0 | ParseError.ParseError<E> | BufferLimitError, R0 | R>
} = /*#__PURE__*/ dual(
  (args) => Stream.isStream(args[0]),
  <I extends Chunkable, E0, R0, A, E, R>(
    self: Stream.Stream<Source<I>, E0, R0>,
    parser: Parser<A, E, R, I>,
    options?: ParseManyOptions<I>
  ): Effect.Effect<A, E0 | ParseError.ParseError<E> | BufferLimitError, R0 | R> => {
    const limit = limitOf(options)
    return Effect.flatMap(Effect.context<R>(), (context) =>
      Effect.suspend(() => {
        const empty = options?.empty === undefined ? undefined : fromSource<I>(options.empty)
        const incremental = new Incremental(parser, context, empty)
        return Effect.flatMap(
          Stream.runForEach(self, (source) =>
            Effect.suspend(() => {
              const chunk = fromSource<I>(source)
              // Checked before the chunk is copied in: the whole input is held, so all of it counts
              const size = incremental.size + chunk.length
              if (size > limit) return Effect.fail(new BufferLimitError({ limit, size }))
              incremental.push(chunk)
              return Effect.void
            })
          ),
          () => Effect.suspend(() => incremental.finish())
        )
      })
    )
  }
)

/**
 * An error reading a `ReadableStream` given to {@link parseReadable} or
 * {@link parseResponse}.
 *
 * @since 0.1.0
 * @category errors
 */
export class ReadError extends /*#__PURE__*/ Data.TaggedError("ReadError")<{ readonly cause: unknown }> {}

/** Whether a web-stream runner was called with its stream first: the other form starts with the parser. */
const isDataFirst = (args: IArguments): boolean => !isParser(args[0])

/**
 * Parses a web `ReadableStream` of bytes, such as the body of a `fetch`
 * response, incrementally (see {@link parseAll}): the bytes are parsed as
 * they arrive, without waiting for the end of the stream or decoding them
 * first. Use a byte parser, e.g. one built from `Text.utf8`. The stream is
 * limited to `maxBufferSize` bytes (64 MiB by default, see
 * {@link BufferOptions}), past which it fails with a
 * {@link BufferLimitError}.
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
    parser: Parser<A, E, R, Uint8Array>,
    options?: BufferOptions
  ): (self: ReadableStream<BinaryInput>) => Effect.Effect<A, ParseError.ParseError<E> | ReadError | BufferLimitError, R>
  <A, E, R>(
    self: ReadableStream<BinaryInput>,
    parser: Parser<A, E, R, Uint8Array>,
    options?: BufferOptions
  ): Effect.Effect<A, ParseError.ParseError<E> | ReadError | BufferLimitError, R>
} = /*#__PURE__*/ dual(
  isDataFirst,
  <A, E, R>(
    self: ReadableStream<BinaryInput>,
    parser: Parser<A, E, R, Uint8Array>,
    options?: BufferOptions
  ): Effect.Effect<A, ParseError.ParseError<E> | ReadError | BufferLimitError, R> =>
    parseAll(
      Stream.fromReadableStream({ evaluate: () => self, onError: (cause) => new ReadError({ cause }) }),
      parser,
      { empty: new Uint8Array(0), maxBufferSize: options?.maxBufferSize }
    )
)

/**
 * The length a response declares for the body as it will be read, if it
 * declares one: `Content-Length` counts the encoded body, so a response
 * with a `Content-Encoding` (which `fetch` decodes) declares nothing about
 * the bytes parsed.
 */
const declaredLength = (response: Response): number | undefined => {
  if (response.headers.has("content-encoding")) return undefined
  const header = response.headers.get("content-length")
  if (header === null || !/^[0-9]+$/.test(header)) return undefined
  return Number(header)
}

/**
 * Parses the body of a `fetch` `Response` incrementally, as it downloads
 * (see {@link parseReadable}). A response without a body is parsed as empty
 * input. The status is not checked.
 *
 * The body is limited to `maxBufferSize` bytes (64 MiB by default, see
 * {@link BufferOptions}). A response whose `Content-Length` already exceeds
 * the limit fails with a {@link BufferLimitError} before any of the body is
 * read; the limit is enforced on the bytes read as well, since the header
 * may be absent or wrong.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Parser, ParserStream, Text } from "@thomasfosterau/effect-parse"
 *
 * const lines = Parser.separated(Text.utf8.tillLineEnding, Text.utf8.lineEnding)
 *
 * const response = await fetch("https://example.com/log.txt")
 * const value = await Effect.runPromise(
 *   ParserStream.parseResponse(response, lines, { maxBufferSize: 8 * 1024 * 1024 })
 * )
 * ```
 *
 * @since 0.1.0
 * @category combinators
 */
export const parseResponse: {
  <A, E, R>(
    parser: Parser<A, E, R, Uint8Array>,
    options?: BufferOptions
  ): (self: Response) => Effect.Effect<A, ParseError.ParseError<E> | ReadError | BufferLimitError, R>
  <A, E, R>(
    self: Response,
    parser: Parser<A, E, R, Uint8Array>,
    options?: BufferOptions
  ): Effect.Effect<A, ParseError.ParseError<E> | ReadError | BufferLimitError, R>
} = /*#__PURE__*/ dual(
  isDataFirst,
  <A, E, R>(
    self: Response,
    parser: Parser<A, E, R, Uint8Array>,
    options?: BufferOptions
  ): Effect.Effect<A, ParseError.ParseError<E> | ReadError | BufferLimitError, R> =>
    Effect.suspend(() => {
      const limit = limitOf(options)
      const size = declaredLength(self)
      if (size !== undefined && size > limit) return Effect.fail(new BufferLimitError({ limit, size }))
      return parseReadable(self.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }), parser, options)
    })
)
