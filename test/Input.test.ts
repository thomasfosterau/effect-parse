import * as Arr from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Record from "effect/Record"

import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test"
import { Ascii, Binary, Compiler, Input, Parser, ParseError, ParserStream, Text, Token } from "../src/index.js"

const encode = (s: string) => new TextEncoder().encode(s)

/** An ES2024 resizable `ArrayBuffer`, which this project's `lib` predates. */
interface Resizable extends ArrayBuffer {
  resize(byteLength: number): void
}

/** `new ArrayBuffer(length, { maxByteLength })`, which Node 22 supports (ES2024). */
const resizableBuffer = (length: number, maxByteLength: number): Resizable =>
  Reflect.construct(ArrayBuffer, [length, { maxByteLength }])

describe("binary inputs", () => {
  it("fromSource views binary data as bytes without copying", () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer
    const view = Input.fromSource(buffer)
    expect(view).toBeInstanceOf(Uint8Array)
    expect(view.buffer).toBe(buffer)
    expect(Array.from(Input.fromSource(new DataView(buffer, 1, 2)))).toEqual([2, 3])
    expect(Array.from(Input.fromSource(new Uint16Array([0x0201])))).toEqual([1, 2])
    expect(Input.fromSource(new SharedArrayBuffer(3))).toHaveLength(3)
    // A view of a resizable buffer keeps the length it had when parsing started
    // (`resize` is ES2024, newer than this project's `lib`)
    const resizable = resizableBuffer(2, 8)
    const fixed = Input.fromSource(resizable)
    resizable.resize(6)
    expect(fixed).toHaveLength(2)
    // Other inputs are returned as they are
    const bytes = new Uint8Array(1)
    const tokens = [1, 2]
    expect(Input.fromSource(bytes)).toBe(bytes)
    expect(Input.fromSource(tokens)).toBe(tokens)
    expect(Input.fromSource("abc")).toBe("abc")
  })

  it("runners accept ArrayBuffers, typed arrays and DataViews for byte parsers", () => {
    const buffer = new Uint8Array([0x12, 0x34]).buffer
    expect(Parser.parse(Binary.beU16, buffer)).toEqual(Result.succeed(0x1234))
    expect(Parser.parseSync(Binary.leU16, new DataView(buffer))).toBe(0x3412)
    expect(Parser.parse(Ascii.bytes.decUint, encode("42").buffer)).toEqual(Result.succeed(42))
    expect(Parser.parsePeek(Binary.u8, buffer)).toEqual(Result.succeed([new Uint8Array([0x34]), 0x12]))
    expect(Parser.parsePartial(Binary.beU32, buffer)).toEqual(
      Result.succeed({ _tag: "Incomplete", needed: expect.anything() })
    )
    expect(Effect.runSync(Parser.parseEffect(Binary.beU16, buffer))).toBe(0x1234)
    expect(Parser.parseRecoverable(Binary.beU16, buffer).errors).toEqual([])
    const err = Parser.parse(Token.literal(new Uint8Array([0x12, 0x99])), buffer)
    expect(Result.isFailure(err) && err.failure.input).toEqual(new Uint8Array([0x12, 0x34]))
  })

  it("text parsers read binary data", () => {
    const text = "naïve café, ünïcödé text long enough for TextDecoder"
    const shared = new SharedArrayBuffer(encode(text).length)
    new Uint8Array(shared).set(encode(text))
    expect(Parser.parse(Text.utf8.rest, shared)).toEqual(Result.succeed(text))
    expect(Parser.parse(Text.utf8.rest, encode(text).buffer)).toEqual(Result.succeed(text))

    // A Uint16Array of UTF-16 code units, in the platform's (little endian) byte order
    const s = "héllo 😀"
    const units = Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i))
    expect(Parser.parse(Text.utf16le.rest, units)).toEqual(Result.succeed(s))

    const r = Parser.parse(Text.utf8.alpha1, encode("abc!").buffer)
    expect(Result.isFailure(r) && r.failure.message).toContain("1 | abc!")
  })

  it("streams of binary chunks", () => {
    const chunks = [encode("αβ").buffer, new DataView(encode("γ\nδ").buffer), encode("\n")]
    const line = Parser.terminated(Text.utf8.alpha1, Text.utf8.newline)
    expect(Effect.runSync(Stream.fromIterable(chunks).pipe(ParserStream.parseMany(line), Stream.runCollect))).toEqual([
      "αβγ",
      "δ"
    ])
    expect(Effect.runSync(Stream.fromIterable(chunks).pipe(ParserStream.parseAll(Parser.repeat(line))))).toEqual([
      "αβγ",
      "δ"
    ])
  })
})

describe("State.reset", () => {
  // Everything a driver can observe after a step
  const observe = <I extends Input.Input, A>(
    state: Input.State<I>,
    step: (state: Input.State<I>) => A | Input.Fail
  ) => {
    const a = step(state)
    if (a !== Input.Fail) return { value: a, pos: state.pos }
    const failure = state.reportedFailure()
    return {
      mode: state.mode,
      failure,
      message: ParseError.fromFailure(state.input, failure, state.mode, state.encoding).message
    }
  }

  const word = Parser.alt(Ascii.decUint, Ascii.alpha1)
  const list = Parser.delimited(
    Token.literal("["),
    Parser.separated(Ascii.decUint, Token.literal(",")),
    Token.literal("]")
  )
  const cut = Parser.preceded(Token.literal("#"), Parser.cut(Ascii.decUint)).pipe(Parser.context("tag"))
  const traced = Parser.trace(list, "list")

  type Run = {
    readonly parser: Parser.Parser<unknown, unknown, never, string>
    readonly offset: number
    readonly partial?: boolean
  }

  const input = "abc 123 [1,2,] #x [4,5] 99"
  const runs: ReadonlyArray<Run> = [
    { parser: word, offset: 0 },
    { parser: list, offset: 8 }, // fails with a hint and a deeper swallowed failure
    { parser: word, offset: 4 },
    { parser: cut, offset: 15 }, // Cut, with a context label
    { parser: list, offset: 18 },
    { parser: word, offset: 24, partial: true }, // Incomplete: more digits may follow
    { parser: word, offset: 24 },
    { parser: list, offset: 3 },
    { parser: traced, offset: 18 },
    { parser: word, offset: 3, partial: true }
  ]

  it("a reused state gives the same results and errors as a fresh one", () => {
    const reused = new Input.State(input)
    runs.forEach((run) => {
      const options = { partial: run.partial ?? false }
      const fresh = observe(new Input.State(input, { ...options, offset: run.offset }), run.parser.step)
      expect(observe(reused.reset(run.offset, options), run.parser.step)).toEqual(fresh)
    })
    // The runs above did fail, return Incomplete and succeed
    const outcomes = runs.map((run) =>
      observe(new Input.State(input, { partial: run.partial ?? false, offset: run.offset }), run.parser.step)
    )
    expect(outcomes.map((o) => ("mode" in o ? o.mode : "Ok"))).toEqual(
      expect.arrayContaining(["Ok", "Backtrack", "Cut", "Incomplete"])
    )
  })

  it("resets every per-run field", () => {
    const bytes = encode("café ")
    const state = new Input.State(bytes, { partial: true, offset: 6 })
    // Leave the state as a run might: failed, mid-trace, recording, encoded,
    // and with `end` changed by a step that threw
    expect(Text.utf8.alpha1.step(state)).toBe(Input.Fail)
    state.setHint(2, ["x"])
    state.recovered = []
    state.tracer = () => {}
    state.depth = 3
    state.resume = new Map()
    state.end = 2
    state.context = Context.add(Context.empty(), Context.Service<never, number>("n"), 1)
    expect([state.mode, state.encoding]).toEqual(["Incomplete", Text.utf8.encoding])

    state.reset(2)
    const fresh = new Input.State(bytes, { offset: 2 })
    Record.keys(fresh).forEach((key) => {
      expect([key, state[key]]).toEqual([key, fresh[key]])
    })
    expect(state.context).toBe(fresh.context)
    expect(state.failure).toBe(fresh.failure)

    const context = Context.empty()
    expect(state.reset(0, { partial: true, context })).toBe(state)
    expect([state.pos, state.partial, state.context]).toEqual([0, true, context])
  })

  it("returns the same results as the runners", () => {
    const state = new Input.State(input)
    ;(
      [
        [4, 123],
        [24, 99]
      ] as const
    ).forEach(([offset, expected]) => {
      expect(Ascii.decUint.step(state.reset(offset))).toBe(expected)
      expect(Parser.parsePeek(Ascii.decUint, input.slice(offset))).toEqual(
        Result.succeed([input.slice(state.pos), expected])
      )
    })
  })
})

describe("State.reset keeps what the state learnt about its input (#126)", () => {
  const text = () => Parser.terminated(Token.takeTill("<&", { min: 1 }), Token.literal("<"))
  /** The tokens of `input`, one run per token, on one state reset before each or on a new state each time. */
  const lex = (p: Parser.Parser<string>, input: string, reuse: boolean) => {
    const state = new Input.State(input)
    return Arr.unfold(0, (pos) => {
      if (pos >= input.length) return Option.none()
      const s = reuse ? state.reset(pos) : new Input.State(input, { offset: pos })
      const a = Parser.run(p, s)
      return a === Input.Fail ? Option.none() : Option.some([a, s.pos] as const)
    })
  }
  const line = `${"ordinary text, long enough that the compiled takeTill searches with indexOf".padEnd(90, ".")}<`

  it("searches for a stop character that never occurs once, not once per token", () => {
    const input = line.repeat(2000)
    const compiled = Compiler.jit(text())
    // Warm: compiled, and the expected tokens known
    const expected = lex(compiled, input, false)
    expect(expected).toHaveLength(2000)
    const indexOf = vi.spyOn(String.prototype, "indexOf")
    onTestFinished(() => indexOf.mockRestore())
    const before = indexOf.mock.calls.length
    const tokens = lex(compiled, input, true)
    const searches = indexOf.mock.calls.length - before
    indexOf.mockRestore()
    expect(tokens).toEqual(expected)
    // One search per `<` found, and one for `&`: it was two per token, each `&` search running to the end
    expect(searches).toBeLessThanOrEqual(2010)
    expect(searches).toBeGreaterThanOrEqual(2000)
  })

  it.each(["closure", "jit", "wasm"] as const)("gives the tokens of a new state per run (%s)", (backend) => {
    const inputs = [
      line.repeat(50),
      `${line.repeat(3)}a &amp; b long enough to search past the head of the run.....<${line.repeat(3)}`,
      `${"x".repeat(40)}<${"y".repeat(40)}&${"z".repeat(40)}<tail without an end`,
      `&${line}`,
      ""
    ]
    const compiled = Compiler[backend](text())
    inputs.forEach((input) => {
      expect(lex(compiled, input, true), input.slice(0, 30)).toEqual(lex(text(), input, false))
      // Backwards too: a memo from a later offset must not answer for an earlier one
      const state = new Input.State(input)
      const offsets = Array.from({ length: Math.min(input.length, 300) }, (_, i) => (i * 7919) % (input.length || 1))
      offsets.forEach((offset) => {
        const a = Parser.run(compiled, state.reset(offset))
        const fresh = new Input.State(input, { offset })
        expect([a, state.pos], `offset ${offset}`).toEqual([Parser.run(text(), fresh), fresh.pos])
      })
    })
  })

  it("still resets everything that belongs to a run", () => {
    const state = new Input.State("abc<", { partial: true })
    expect(Parser.run(Compiler.jit(text()), state)).toBe("abc")
    state.reset(1)
    expect([state.pos, state.end, state.partial, state.mode, state.resume, state.encoding]).toEqual([
      1,
      4,
      false,
      "Backtrack",
      undefined,
      undefined
    ])
  })
})
