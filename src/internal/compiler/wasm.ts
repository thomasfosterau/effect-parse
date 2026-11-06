/**
 * The WebAssembly compiler: scans the input in WebAssembly, then builds the
 * value in JavaScript (see `docs/DESIGN.md`, "The WebAssembly compiler").
 *
 * A parse runs in two passes over one description of the grammar:
 *
 * 1. **Scan.** Generated WebAssembly matches the input, which is copied into
 *    linear memory, with the same control flow as the JIT (labelled blocks
 *    for failure, a function per rule, `state.mode` as a global). Where a
 *    value is used, it appends what the value needs to a _trace_ in linear
 *    memory: slice bounds, which branch or case matched, repetition counts,
 *    floats. When it backtracks it rewinds the trace with the cursor, so the
 *    trace only describes the successful parse.
 * 2. **Build.** A JavaScript function generated for the grammar reads the
 *    trace in order and builds the value, with the same callbacks and the
 *    same object shapes as the JIT, without scanning anything.
 *
 * Parsers with no native form are _islands_: the scan calls back into
 * JavaScript, which runs their JIT-compiled step on the shared state, and the
 * trace records the index of their value. Streaming (resumable) builds,
 * array input, and environments without `WebAssembly` or `new Function` use
 * the JIT.
 */
import * as Arr from "effect/Array"
import * as Predicate from "effect/Predicate"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type { Encoding } from "../../Encoding.js"
import { Fail, State } from "../../Input.js"
import type { Node, NodeOf, ParserLike } from "../node.js"
import { addEntry, flushEntries, fromEntries, isPlainKey } from "../entries.js"
import { nodeOf } from "../node.js"
import { floatTexts, toFloat } from "../numbers.js"
import { charOf, fastLimit, latin1, string, utf16be, utf16le, utf8 } from "../text.js"
import type { Fallback, Step } from "./closure.js"
import { backend as jitBackend, jitSupported } from "./jit.js"
import { buildsEntries, isDiagnostic, pairOf } from "./entries.js"
import { countRefs, isLeaf, isLetter, isSmall, lowerAscii, selectorOf } from "./graph.js"
import type { Backend, Compiled } from "./registry.js"
import type { CharSet } from "./sets.js"
import { kindOfEncoding, TableSize, textSet, tokenSet } from "./sets.js"
import type { Label } from "./wasmAsm.js"
import { Body, encodeModule, F64, I32, Op, Simd } from "./wasmAsm.js"

// -----------------------------------------------------------------------------
// Layout
// -----------------------------------------------------------------------------

/** The encoding of a token node: `undefined` for `Token` / `Ascii`, as in `internal/node.ts`. */
type Enc = NodeOf<"Any">["encoding"]

/** Globals. `F` holds the float of the latest scan, the others are `i32`. */
const G = { mode: 0, end: 1, len: 2, tp: 3, tlim: 4, nv: 5, w: 6, f: 7 } as const

/** Imported functions. */
const Imp = { island: 0, grow: 1, test: 2, float: 3, check: 4 } as const
const importCount = 5

/**
 * Function types: rules and decoders `(i32) -> i32`, imports and helpers of
 * two arguments `(i32, i32) -> i32`, `grow` `() -> i32`, `float` `(i32, i32) -> f64`,
 * `start` `(i32 × 5) -> i32`.
 */
const Ty = { rule: 0, pair: 1, grow: 2, toF64: 3, start: 4 } as const

/** Linear memory: membership tables from 0, powers of ten, then the input, then the trace. */
const TablesEnd = 61440
const Pow10 = 61440
/** The string cache (see `intern`): `StringSlots` slots of a version, a length and `MaxInterned` units. */
const Strings = 65536
const StringSlots = 1024
const MaxInterned = 16
const SlotBytes = 8 + 2 * MaxInterned
const Input = 131072
const PageSize = 65536
/** Headroom kept free above the trace limit: more than the writes between two checks. */
const Slack = 65536
/** Trace words a function may write past the last check that dominates them (see `put`). */
const MaxWrites = 4096

/** Bytes left after the cursor beyond which a driver's parse of the same buffer runs the JIT (see `run`). */
const LargeRest = 4096

/** The most literals a compiled `takeUntilAny` checks at each candidate; more are searched in JavaScript. */
const MaxUntil = 64

/** The most leading bytes of each literal a SIMD search tests at once. */
const MaxPositions = 3

/** Teddy's buckets: one bit each in a nibble table's bytes. */
const Buckets = 8

/** For each low nibble, the high nibbles `from` to `from + 7` of the bytes `set` accepts, as bits from 0. */
/** Whether `set` accepts any byte. */
const accepts = (set: Membership): boolean =>
  Array.from({ length: 256 }, (_, c) => (set.cs.table[c] === 1) !== set.negate).some((ok) => ok)

const nibbleTable = (set: Membership, from: number): Array<number> => {
  const table = new Array<number>(16).fill(0)
  for (let c = from << 4; c < (from + 8) << 4; c++) {
    if ((set.cs.table[c] === 1) !== set.negate) table[c & 15] = (table[c & 15] ?? 0) | (1 << ((c >> 4) - from))
  }
  return table
}

/** The most rejected bytes a vectorised `takeWhile` compares with one by one. */
const MaxStops = 3

/** For a high nibble `h` from 8 up, bit `h - 8`; none below. */
const UpperNibbleBits: ReadonlyArray<number> = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 4, 8, 16, 32, 64, 128]

/** For a high nibble `h`, bit `h` below 8 (ASCII), none above. */
const HighNibbleBits: ReadonlyArray<number> = [1, 2, 4, 8, 16, 32, 64, 128, 0, 0, 0, 0, 0, 0, 0, 0]

const Zeros: ReadonlyArray<number> = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
const LowNibbles: ReadonlyArray<number> = [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15]

/**
 * Teddy's tables for the first `m` bytes of `literals`: for each position,
 * the low- and high-nibble tables, literal `i` in bucket `i % 8`.
 */
const teddyTables = (literals: ReadonlyArray<Uint8Array>, m: number): Array<[Array<number>, Array<number>]> =>
  Array.from({ length: m }, (_, j) => {
    const lo = new Array<number>(16).fill(0)
    const hi = new Array<number>(16).fill(0)
    literals.forEach((lit, i) => {
      const byte = lit[j] ?? 0
      const bit = 1 << (i % Buckets)
      lo[byte & 15] = (lo[byte & 15] ?? 0) | bit
      hi[byte >> 4] = (hi[byte >> 4] ?? 0) | bit
    })
    return [lo, hi]
  })

/**
 * The bytes of literal units (`width` bytes each, little-endian), and the
 * 0x20 to OR into each byte of a caseless letter, which `bytes` holds in
 * lower case.
 */
const unitBytes = (codes: ReadonlyArray<number>, caseless: boolean, width: number) => {
  const bytes: Array<number> = []
  const fold: Array<number> = []
  for (const code of codes) {
    const letter = caseless && isLetter(code)
    const unit = letter ? lowerAscii(code) : code
    for (let k = 0; k < width; k++) {
      bytes.push((unit >> (8 * k)) & 0xff)
      fold.push(letter && k === 0 ? 0x20 : 0)
    }
  }
  return { bytes, fold }
}

/** The widest load, of 16 (with SIMD), 8, 4, 2 or 1 bytes, that `left` bytes fill. */
const chunkSize = (left: number): number => {
  if (left >= 16 && simd()) return 16
  return [8, 4, 2].find((n) => left >= n) ?? 1
}

/**
 * With an address on the stack, pushes whether the 1, 2, 4, 8 or 16 bytes
 * at it (plus `offset`), ORed with `fold`, differ from `bytes`.
 */
const compareChunk = (b: Body, bytes: ReadonlyArray<number>, fold: ReadonlyArray<number>, offset: number): void => {
  const n = bytes.length
  const folds = fold.some((f) => f !== 0)
  if (n === 16) {
    b.simd(Simd.v128Load, 0, offset)
    if (folds) b.v128(fold).simd(Simd.v128Or)
    b.v128(bytes).simd(Simd.i8x16Eq).simd(Simd.i8x16AllTrue).op(Op.i32Eqz)
  } else if (n === 8) {
    b.mem(Op.i64Load, 0, offset)
    if (folds) b.i64(littleEndian(fold, 0, 8)).op(Op.i64Or)
    b.i64(littleEndian(bytes, 0, 8)).op(Op.i64Ne)
  } else {
    b.mem(n === 4 ? Op.i32Load : n === 2 ? Op.i32Load16U : Op.i32Load8U, 0, offset)
    if (folds) b.i32(Number(littleEndian(fold, 0, n))).op(Op.i32Or)
    b.i32(Number(BigInt.asIntN(32, littleEndian(bytes, 0, n)))).op(Op.i32Ne)
  }
}

/** `n` bytes from `bytes[i]` as a little-endian integer (as a load reads them). */
const littleEndian = (bytes: ReadonlyArray<number>, i: number, n: number): bigint => {
  let v = 0n
  for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(bytes[i + k] ?? 0)
  return BigInt.asIntN(64, v)
}

/** Values of `G.mode`. */
const Backtrack = 0
const Cut = 1

/** Whether the scan decodes an encoding itself. */
const isBuiltin = (enc: Encoding<any>): boolean =>
  enc === string || enc === utf8 || enc === utf16le || enc === utf16be || enc === latin1

// -----------------------------------------------------------------------------
// Code units
// -----------------------------------------------------------------------------

/**
 * How the scan reads one code point: `fast` units are whole code points
 * read inline, `width` input units long; the others are decoded by the
 * helper function `decode`, which leaves the width in `G.w`.
 */
interface Reader {
  readonly width: number
  readonly fast: number
  /** Pushes a test that a whole unit starts at local `pos`. */
  readonly guard: (b: Body, pos: number) => void
  /** Pushes the unit at local `pos`. */
  readonly unit: (b: Body, pos: number) => void
  readonly decode: number
}

/** A token set being tested: the set, whether it is negated, and the local holding the code point. */
interface Membership {
  readonly cs: CharSet
  readonly negate: boolean
  readonly c: number
}

/** The locals of an `escaped` (see `WasmCompiler.escaped`). */
interface EscapedLocals {
  readonly r: Option.Option<Reader>
  /** Whether its value is built from pieces: segments and escapes. */
  readonly pieces: boolean
  /** Whether a string of one segment is interned. */
  readonly internsWhole: boolean
  readonly start: number
  readonly seg: number
  readonly ok: number
  readonly ts: number
  readonly count: number
  readonly pieceStart: number
  readonly slot: number
  /** The builder variable of a piece. */
  readonly x: string
}

/**
 * Where code is generated: the parser, the builder variable of its value
 * (`""` when the value is unused), the function body, the label of its
 * failure, the builder function's variables and the depth of inlining.
 */
interface Site {
  readonly p: ParserLike
  readonly out: string
  readonly b: Body
  readonly fail: Label
  readonly bf: Vars
  readonly d: number
}

/** Pushes the code point of the surrogate pair in locals `hi` and `lo`. */
const pair = (b: Body, hi: number, lo: number): void => {
  b.get(hi).i32(0xd800).op(Op.i32Sub).i32(10).op(Op.i32Shl)
  b.get(lo).i32(0xdc00).op(Op.i32Sub).op(Op.i32Add).i32(0x10000).op(Op.i32Add)
}

/** Whether every key of a record of cases is one unit below `size` (a byte, as a numeric key, for `bytes`). */
const closedKeys = (keys: ReadonlyArray<PropertyKey>, size: number, bytes: boolean): boolean =>
  keys.every(
    (k) =>
      Predicate.isString(k) && (bytes ? /^\d+$/.test(k) && Number(k) < size : k.length === 1 && k.charCodeAt(0) < size)
  )

/** Per builder function: its variables. */
class Vars {
  readonly names: Array<string> = []
}

/** A repetition's element: generates it, and returns the builder code that adds it to the result. */
type Element = (b: Body, fail: Label, bf: Vars) => string

const modeOf = (mode: string): number => (mode === "Cut" ? Cut : mode === "Backtrack" ? Backtrack : 2)

/** The inclusive runs of accepted code points of a set, when its ranges are known. */
const acceptedRuns = (cs: CharSet, negate: boolean, max: number): Option.Option<Array<[number, number]>> => {
  if (cs.ranges === undefined) return Option.none()
  const runs: Array<[number, number]> = []
  for (const [a, b] of cs.ranges) if (a <= max) runs.push([a, Math.min(b, max)])
  if (!negate) return Option.some(runs)
  const out: Array<[number, number]> = []
  let next = 0
  for (const [a, b] of runs) {
    if (a > next) out.push([next, a - 1])
    next = b + 1
  }
  if (next <= max) out.push([next, max])
  return Option.some(out)
}

let simdChecked = false
let simdSupported = false

/**
 * Whether WebAssembly SIMD is available, for the widener of strings (checked
 * once): a module of one `v128` load validates.
 */
const simd = (): boolean => {
  if (!simdChecked) {
    simdChecked = true
    simdSupported = validates((probe) => probe.get(0).simd(Simd.v128Load, 0, 0).simd(Simd.i8x16Bitmask))
  }
  return simdSupported
}

let relaxedChecked = false
let relaxedSupported = false

/**
 * Whether relaxed SIMD is available (checked once): its `relaxed_swizzle`
 * is `swizzle` without the fix-up for indices from 16 up, which the nibble
 * lookups never pass.
 */
const relaxed = (): boolean => {
  if (!relaxedChecked) {
    relaxedChecked = true
    relaxedSupported =
      simd() &&
      validates((probe) =>
        probe
          .get(0)
          .simd(Simd.v128Load, 0, 0)
          .get(0)
          .simd(Simd.v128Load, 0, 0)
          .simd(Simd.i8x16RelaxedSwizzle)
          .simd(Simd.i8x16Bitmask)
      )
  }
  return relaxedSupported
}

/** Pushes a swizzle of a table by nibbles (indices below 16): relaxed where it validates. */
const nibbleSwizzle = (b: Body): void => {
  b.simd(relaxed() ? Simd.i8x16RelaxedSwizzle : Simd.i8x16Swizzle)
}

/** Whether a module of one function `(i32) -> i32` with the body `write` writes validates. */
const validates = (write: (probe: Body) => void): boolean => {
  const probe = new Body(1)
  write(probe)
  const bytes = encodeModule({
    types: [{ params: [I32], results: [I32] }],
    imports: [],
    memoryPages: 1,
    functions: [[0, probe]],
    globals: [],
    exports: [],
    data: []
  })
  return WebAssembly.validate(bytes)
}

/** Whether a builder is available: it is generated with `new Function`. */
const supported = (): boolean => Predicate.isObject(globalThis.WebAssembly) && jitSupported()

// -----------------------------------------------------------------------------
// The compiler
// -----------------------------------------------------------------------------

class WasmCompiler {
  readonly functions: Array<[number, Body]> = []
  readonly builders: Array<string> = []
  readonly constants: Array<unknown> = []
  readonly islands: Array<{ readonly parser: ParserLike; readonly used: boolean }> = []
  readonly fallbacks: Array<Fallback> = []
  readonly tables: Array<Uint8Array> = []
  readonly tests: Array<(c: number) => number> = []
  // Keyed by identity: parsers and encodings are compared as objects, never structurally
  private readonly rules = [new WeakMap<ParserLike, number>(), new WeakMap<ParserLike, number>()]
  private readonly pending: Array<readonly [ParserLike, boolean, number]> = []
  private refs = new WeakMap<ParserLike, number>()
  private readonly decoders = new WeakMap<Encoding<any>, number>()
  private readonly floatScanners = new WeakMap<Encoding<any>, number>()
  /** The float scanner of `Token` / `Ascii` text, which has no encoding. */
  private tokenFloatScanner = -1
  private next = 0

  constructor(readonly kind: 0 | 1) {}

  /** Counts the distinct parents of each parser. */
  countRefs(root: ParserLike): void {
    this.refs = countRefs(root)
  }

  /** A constant of the builder, `C[i]`; the same value (by `Object.is`) is stored once. */
  const<T>(value: T): string {
    let i = this.constants.findIndex((c) => Object.is(c, value))
    if (i < 0) i = this.constants.push(value) - 1
    return `C[${i}]`
  }

  /** A JavaScript literal for simple values, otherwise a constant. */
  lit<T>(value: T): string {
    if (value === undefined) return "void 0"
    if (value === null || Predicate.isBoolean(value)) return String(value)
    if (Predicate.isNumber(value) && Number.isFinite(value) && !Object.is(value, -0)) return String(value)
    return this.const(value)
  }

  v(bf: Vars): string {
    const name = `v${this.next++}`
    bf.names.push(name)
    return name
  }

  /** Reserves a function index; its body is filled in later. */
  private reserve(type: number, params = 1): [number, Body] {
    const body = new Body(params)
    this.functions.push([type, body])
    return [importCount + this.functions.length - 1, body]
  }

  /** The function of a rule, generating it later if new. With `used`, it has a builder `b<index>`. */
  rule(p: ParserLike, used: boolean): number {
    const rules = this.rules[used ? 1 : 0]
    const known = rules.get(p)
    if (known !== undefined) return known
    const [index] = this.reserve(Ty.rule)
    rules.set(p, index)
    this.pending.push([p, used, index])
    return index
  }

  /** Generates the pending rules (and the rules they use). */
  flush(): void {
    for (let r = this.pending.shift(); r !== undefined; r = this.pending.shift()) {
      const [p, used, index] = r
      const body = this.functions[index - importCount][1]
      const bf = new Vars()
      const out = used ? this.v(bf) : ""
      // The trace pointer lives in a local, written back before calls and on success
      body.tp = body.local()
      body.gget(G.tp).set(body.tp)
      // So is the end of the input, which never changes during a parse
      body.endLocal = body.local()
      body.gget(G.end).set(body.endLocal)
      this.check(body)
      body.writes = 0
      let built = ""
      body.block((fail) => {
        built = this.inline(p, out, body, fail, bf, 0)
        body.get(body.tp).gset(G.tp)
        body.get(0).op(Op.return)
      })
      body.i32(-1)
      if (used) {
        this.builders.push(
          `function b${index}(i){${Arr.isArrayNonEmpty(bf.names) ? `let ${bf.names.join(",")};` : ""}${built}N=i;return ${out}}`
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers for generated code
  // ---------------------------------------------------------------------------

  /** Fails with a mode. */
  private failWith(b: Body, fail: Label, mode: number): void {
    b.i32(mode).gset(G.mode).br(fail)
  }

  /** Fails with `Backtrack` when the `i32` at the top of the stack is true. */
  private failIf(b: Body, fail: Label): void {
    b.if(() => this.failWith(b, fail, Backtrack))
  }

  /** Propagates a failure unless its mode is `Backtrack`. */
  private unlessBacktrack(b: Body, fail: Label): void {
    b.gget(G.mode).brIf(fail)
  }

  /** Pushes the input unit at local `pos` plus `delta` units. */
  load(b: Body, pos: number, delta = 0): void {
    if (this.kind === 0)
      b.get(pos)
        .i32(1)
        .op(Op.i32Shl)
        .mem(Op.i32Load16U, 1, Input + 2 * delta)
    else b.get(pos).mem(Op.i32Load8U, 0, Input + delta)
  }

  /** Pushes the end of the input: from a local in rule functions, from the global in helpers. */
  private end(b: Body): Body {
    return b.endLocal >= 0 ? b.get(b.endLocal) : b.gget(G.end)
  }

  /** Pushes `p >= E`. */
  private atEnd(b: Body, pos: number): void {
    this.end(b.get(pos)).op(Op.i32GeU)
  }

  /** `p += n`. */
  private advance(b: Body, n: number): void {
    b.get(0).i32(n).op(Op.i32Add).set(0)
  }

  /** Saves the cursor and the trace pointer. */
  private save(b: Body): [number, number] {
    const p = b.local()
    const t = b.local()
    b.get(0).set(p).get(b.tp).set(t)
    return [p, t]
  }

  /** Restores a saved cursor and trace pointer. */
  private restore(b: Body, [p, t]: [number, number]): void {
    b.get(p).set(0).get(t).set(b.tp)
  }

  /** Grows the trace if it is past its limit. */
  private check(b: Body): void {
    b.get(b.tp).gget(G.tlim).op(Op.i32GtU)
    b.if(() => b.call(Imp.grow).gset(G.tlim))
  }

  /**
   * Appends words to the trace. Every function and loop iteration starts
   * with a check, and the limit keeps `Slack` bytes free, so a check is
   * only written here once a function wrote `MaxWrites` words since one.
   */
  put(b: Body, words: ReadonlyArray<() => void>): void {
    b.writes += words.length
    if (b.writes > MaxWrites) this.check(b)
    words.forEach((push, k) => {
      b.get(b.tp)
      push()
      b.mem(Op.i32Store, 2, 4 * k)
    })
    b.get(b.tp)
      .i32(4 * words.length)
      .op(Op.i32Add)
      .set(b.tp)
  }

  /** Reserves a trace word, returning a local holding its address. */
  private slot(b: Body): number {
    const s = b.local()
    b.get(b.tp).set(s)
    this.put(b, [() => b.i32(0)])
    return s
  }

  /** Appends the `f64` in `G.f` to the trace, aligned to 8 bytes. */
  private putF64(b: Body): void {
    b.writes += 4
    if (b.writes > MaxWrites) this.check(b)
    b.get(b.tp).i32(7).op(Op.i32Add).i32(-8).op(Op.i32And).set(b.tp)
    b.get(b.tp).gget(G.f).mem(Op.f64Store, 3, 0)
    b.get(b.tp).i32(8).op(Op.i32Add).set(b.tp)
  }

  /** A loop with a trace check at the start of each iteration. */
  private loop(b: Body, body: (again: Label) => void): void {
    const before = b.writes
    b.loop((again) => {
      this.check(b)
      b.writes = 0
      body(again)
    })
    b.writes += before
  }

  /** Builder code reading the next trace word. */
  private static word = "T[i++]"

  // ---------------------------------------------------------------------------
  // Islands
  // ---------------------------------------------------------------------------

  /**
   * Runs `p`'s JIT-compiled step on the shared state. With `out`, its value
   * is kept by JavaScript and the trace records its index.
   */
  island(p: ParserLike, out: string, b: Body, fail: Label, reason: string): string {
    const id = this.islands.length
    this.islands.push({ parser: p, used: out !== "" })
    this.fallbacks.push({ name: p.name, tag: nodeOf(p)._tag, reason })
    const r = b.local()
    b.i32(id).get(0).call(Imp.island).tee(r).i32(0).op(Op.i32LtS)
    // -1: Backtrack, -2: Cut
    b.if(() => {
      b.i32(-1).get(r).op(Op.i32Sub).gset(G.mode).br(fail)
    })
    b.get(r).set(0)
    if (out === "") return ""
    this.put(b, [() => b.gget(G.nv)])
    b.gget(G.nv).i32(1).op(Op.i32Add).gset(G.nv)
    return `${out}=V[${WasmCompiler.word}];`
  }

  /** Builder functions of the value islands, `w<id>`, and what they apply to the value. */
  readonly valueFns: Array<string> = []
  readonly checks: Array<(value: Value) => Value> = []

  /**
   * A callback that needs `self`'s value while scanning (`filter`,
   * `tryMap`, `filterMap`, `tap`): `self` is scanned here, then JavaScript
   * builds its value from its trace (with a builder function of its own) and
   * applies `apply`, which returns the result or `Fail` (a failure with
   * `Backtrack`). The trace of `self` is then replaced by the index of the
   * result.
   */
  private valueIsland(
    self: ParserLike,
    out: string,
    b: Body,
    fail: Label,
    d: number,
    apply: (value: Value) => Value
  ): string {
    const id = this.valueFns.length
    this.valueFns.push("")
    this.checks.push(apply)
    const ts = b.local()
    b.get(b.tp).set(ts)
    const vars = new Vars()
    const x = this.v(vars)
    const code = this.gen(self, x, b, fail, vars, d)
    this.valueFns[id] = `function w${id}(i){let ${vars.names.join(",")};${code}return ${x}}`
    b.i32(id).get(ts).call(Imp.check).op(Op.i32Eqz)
    this.failIf(b, fail)
    b.get(ts).set(b.tp)
    // JavaScript kept the result, used or not: count it
    if (out !== "") this.put(b, [() => b.gget(G.nv)])
    b.gget(G.nv).i32(1).op(Op.i32Add).gset(G.nv)
    return out === "" ? "" : `${out}=V[T[i++]];`
  }

  // ---------------------------------------------------------------------------
  // Parsers
  // ---------------------------------------------------------------------------

  call(index: number, out: string, b: Body, fail: Label): string {
    b.get(b.tp).gset(G.tp)
    b.get(0).call(index).tee(0).i32(0).op(Op.i32LtS).brIf(fail)
    b.gget(G.tp).set(b.tp)
    return out === "" ? "" : `${out}=b${index}(i);i=N;`
  }

  /**
   * Scan code for `p`, falling through with `p` advanced, or branching to
   * `fail` with `G.mode` set. With `out`, returns the builder code that
   * reads its trace and sets `out` to its value.
   */
  gen(p: ParserLike, out: string, b: Body, fail: Label, bf: Vars, depth: number): string {
    const node = nodeOf(p)
    if (Predicate.isTagged(node, "Suspend")) return this.call(this.rule(node.resolve(), out !== ""), out, b, fail)
    if (!isLeaf(node) && (((this.refs.get(p) ?? 0) > 1 && !isSmall(p)) || depth > 32)) {
      return this.call(this.rule(p, out !== ""), out, b, fail)
    }
    return this.inline(p, out, b, fail, bf, depth)
  }

  /** Whether the scan reads tokens of this encoding itself. */
  private native(enc: Enc): boolean {
    if (enc === undefined) return true
    return isBuiltin(enc) && kindOfEncoding(enc) === this.kind
  }

  inline(p: ParserLike, out: string, b: Body, fail: Label, bf: Vars, depth: number): string {
    const node = nodeOf(p)
    const s: Site = { p, out, b, fail, bf, d: depth + 1 }
    const families: ReadonlyArray<(node: Node, s: Site) => Option.Option<string>> = [
      (n, x) => this.constant(n, x),
      (n, x) => this.slices(n, x),
      (n, x) => this.values(n, x),
      (n, x) => this.control(n, x),
      (n, x) => this.structure(n, x)
    ]
    for (const family of families) {
      const code = family(node, s)
      if (Option.isSome(code)) return code.value
    }
    return this.island(p, out, b, fail, "no WebAssembly form")
  }

  /** `out = value;`, or nothing when the value is unused. */
  private set(s: Site, value: string): string {
    return s.out === "" ? "" : `${s.out}=${value};`
  }

  /** Constants, the end of the input, positions and rules. */
  private constant(node: Node, s: Site): Option.Option<string> {
    const { b, fail } = s
    if (Predicate.isTagged(node, "Succeed")) return Option.some(this.set(s, this.lit(node.value)))
    if (Predicate.isTagged(node, "Sync")) return Option.some(this.set(s, `${this.const(node.evaluate)}()`))
    if (Predicate.isTagged(node, "Fail")) {
      this.failWith(b, fail, modeOf(node.mode))
      return Option.some(this.set(s, "void 0"))
    }
    if (Predicate.isTagged(node, "Eof")) {
      this.atEnd(b, 0)
      b.op(Op.i32Eqz)
      this.failIf(b, fail)
      return Option.some(this.set(s, "void 0"))
    }
    if (Predicate.isTagged(node, "Location") || Predicate.isTagged(node, "RestLen")) {
      if (s.out !== "") this.put(b, [() => b.get(0)])
      return Option.some(this.set(s, Predicate.isTagged(node, "Location") ? "T[i++]" : "E-T[i++]"))
    }
    if (Predicate.isTagged(node, "Suspend")) {
      return Option.some(this.call(this.rule(node.resolve(), s.out !== ""), s.out, b, fail))
    }
    if (Predicate.isTagged(node, "Fixed") && this.kind === 1) {
      // `Binary`'s numbers on bytes: the scan checks there are `size` bytes, the builder reads the number
      this.end(b.get(0).i32(node.size).op(Op.i32Add)).op(Op.i32GtU)
      this.failIf(b, fail)
      if (s.out !== "") this.put(b, [() => b.get(0)])
      this.advance(b, node.size)
      return Option.some(this.set(s, `${this.const(node.read)}(I,T[i++],S)`))
    }
    return Option.none()
  }

  /** Tokens, `escaped`, and parsers whose value is the input they consumed. */
  private slices(node: Node, s: Site): Option.Option<string> {
    if (
      Predicate.isTagged(node, "Any") ||
      Predicate.isTagged(node, "OneOf") ||
      Predicate.isTagged(node, "Literal") ||
      Predicate.isTagged(node, "TakeWhile")
    ) {
      return Option.some(this.token(s, node))
    }
    if (Predicate.isTagged(node, "Escaped")) return Option.some(this.escaped(s, node))
    if (Predicate.isTagged(node, "TakeUntil") || Predicate.isTagged(node, "TakeUntilAny")) {
      return Option.some(this.takeUntil(s, node))
    }
    if (Predicate.isTagged(node, "Taken")) {
      if (node.encoding !== undefined) {
        return Option.some(this.island(s.p, s.out, s.b, s.fail, "text slices are validated in JavaScript"))
      }
      return Option.some(
        this.sliceOf(s, node.self, this.kind === 0 ? "I.slice(T[i],T[i+1])" : "I.subarray(T[i],T[i+1])")
      )
    }
    if (Predicate.isTagged(node, "Span")) return Option.some(this.sliceOf(s, node.self, "{start:T[i],end:T[i+1]}"))
    if (Predicate.isTagged(node, "WithTaken") || Predicate.isTagged(node, "WithSpan")) {
      return Option.some(this.withSlice(s, node))
    }
    return Option.none()
  }

  /** `self`, whose value is `value`, an expression of its start and end `T[i]`, `T[i+1]`. */
  private sliceOf(s: Site, self: ParserLike, value: string): string {
    const { b } = s
    const st = b.local()
    b.get(0).set(st)
    this.gen(self, "", b, s.fail, s.bf, s.d)
    if (s.out === "") return ""
    this.put(b, [() => b.get(st), () => b.get(0)])
    return `${s.out}=${value};i+=2;`
  }

  /** `withTaken` and `withSpan`: the value of `self` and its slice or span. */
  private withSlice(s: Site, node: NodeOf<"WithTaken"> | NodeOf<"WithSpan">): string {
    const { b, out } = s
    if (out === "") return this.gen(node.self, "", b, s.fail, s.bf, s.d)
    const st = b.local()
    b.get(0).set(st)
    this.put(b, [() => b.get(st)])
    const x = this.v(s.bf)
    const start = this.v(s.bf)
    const code = this.gen(node.self, x, b, s.fail, s.bf, s.d)
    this.put(b, [() => b.get(0)])
    const extra = Predicate.isTagged(node, "WithSpan") ? `{start:${start},end:T[i++]}` : `S.slice(${start},T[i++])`
    return `${start}=T[i++];${code}${out}=[${x},${extra}];`
  }

  /** Mapping, and callbacks on values. */
  private values(node: Node, s: Site): Option.Option<string> {
    const { b, fail, d } = s
    if (Predicate.isTagged(node, "Map")) return Option.some(this.map(node, s.out, b, fail, s.bf, d))
    if (Predicate.isTagged(node, "As")) {
      this.gen(node.self, "", b, fail, s.bf, d)
      return Option.some(this.set(s, this.lit(node.value)))
    }
    if (Predicate.isTagged(node, "Filter")) return Option.some(this.filter(s, node))
    if (Predicate.isTagged(node, "TryMap")) {
      const f = node.f
      return Option.some(this.valueIsland(node.self, s.out, b, fail, d, (v) => Result.getOrElse(f(v), () => Fail)))
    }
    if (Predicate.isTagged(node, "FilterMap")) {
      const f = node.f
      return Option.some(this.valueIsland(node.self, s.out, b, fail, d, (v) => Option.getOrElse(f(v), () => Fail)))
    }
    if (Predicate.isTagged(node, "Tap")) {
      const f = node.f
      return Option.some(
        this.valueIsland(node.self, s.out, b, fail, d, (v) => {
          f(v)
          return v
        })
      )
    }
    return Option.none()
  }

  /** `filter`: on a float, a test of the double; otherwise a value island. */
  private filter(s: Site, node: NodeOf<"Filter">): string {
    const predicate = node.predicate
    if (predicate === Number.isFinite) {
      const code = this.finiteFloat(node.self, s.out, s.b, s.fail, s.bf, s.d)
      if (Option.isSome(code)) return code.value
    }
    return this.valueIsland(node.self, s.out, s.b, s.fail, s.d, (v) => (predicate(v) ? v : Fail))
  }

  /** Modes, diagnostics and lookahead. */
  private control(node: Node, s: Site): Option.Option<string> {
    const { b, fail, out, d } = s
    if (Predicate.isTagged(node, "Mode")) {
      return Option.some(this.withMode(b, node, fail, (bad) => this.gen(node.self, out, b, bad, s.bf, d)))
    }
    if (isDiagnostic(node)) return Option.some(this.gen(node.self, out, b, fail, s.bf, d))
    if (Predicate.isTagged(node, "ResumeAfter")) {
      if (out === "") return Option.some(this.gen(node.self, "", b, fail, s.bf, d))
      const x = this.v(s.bf)
      return Option.some(this.gen(node.self, x, b, fail, s.bf, d) + `${out}=R.some(${x});`)
    }
    if (Predicate.isTagged(node, "Opt") || Predicate.isTagged(node, "OrElseSucceed"))
      return Option.some(this.opt(s, node))
    if (Predicate.isTagged(node, "Peek")) {
      const st = b.local()
      b.get(0).set(st)
      const code = this.gen(node.self, out, b, fail, s.bf, d)
      b.get(st).set(0)
      return Option.some(code)
    }
    if (Predicate.isTagged(node, "Not")) return Option.some(this.not(s, node))
    return Option.none()
  }

  /**
   * Runs `body`, which branches to the label it is given on failure; then
   * `failed` runs, and may fall through to the code after both.
   */
  private attempt(b: Body, body: (bad: Label) => void, failed: () => void): void {
    b.block((ok) => {
      b.block((bad) => {
        body(bad)
        b.br(ok)
      })
      failed()
    })
  }

  /** `cut` and `complete`: a failure of `body` with the mode `from` fails with `to`. */
  private withMode(b: Body, node: NodeOf<"Mode">, fail: Label, body: (bad: Label) => string): string {
    let code = ""
    this.attempt(
      b,
      (bad) => {
        code = body(bad)
      },
      () => {
        b.gget(G.mode).i32(modeOf(node.from)).op(Op.i32Eq)
        b.if(() => b.i32(modeOf(node.to)).gset(G.mode))
        b.br(fail)
      }
    )
    return code
  }

  /** `opt` and `orElseSucceed`: the trace holds 1 when `self` matched. */
  private opt(s: Site, node: NodeOf<"Opt"> | NodeOf<"OrElseSucceed">): string {
    const { b, out } = s
    const flag = out === "" ? -1 : this.slot(b)
    const saved = this.save(b)
    const x = out === "" ? "" : this.v(s.bf)
    let code = ""
    this.attempt(
      b,
      (bad) => {
        code = this.gen(node.self, x, b, bad, s.bf, s.d)
        if (flag >= 0) this.putAt(b, flag, 1)
      },
      () => {
        this.unlessBacktrack(b, s.fail)
        this.restore(b, saved)
      }
    )
    if (out === "") return ""
    const some = Predicate.isTagged(node, "Opt") ? `R.some(${x})` : `${x}`
    const none = Predicate.isTagged(node, "Opt") ? "R.none()" : `${this.const(node.value)}()`
    return `if(T[i++]===1){${code}${out}=${some}}else ${out}=${none};`
  }

  /** `not`: succeeds, consuming nothing, where `self` fails with `Backtrack`. */
  private not(s: Site, node: NodeOf<"Not">): string {
    const { b, fail } = s
    const saved = this.save(b)
    this.attempt(
      b,
      (bad) => {
        this.gen(node.self, "", b, bad, s.bf, s.d)
        this.restore(b, saved)
        this.failWith(b, fail, Backtrack)
      },
      () => {
        this.unlessBacktrack(b, fail)
        this.restore(b, saved)
      }
    )
    return this.set(s, "void 0")
  }

  /** Sequences, choice and repetition. */
  private structure(node: Node, s: Site): Option.Option<string> {
    const { p, out, b, fail, bf, d } = s
    if (Predicate.isTagged(node, "Seq")) return Option.some(this.seq(node, out, b, fail, bf, d))
    if (Predicate.isTagged(node, "Struct")) return Option.some(this.struct(s, node))
    if (Predicate.isTagged(node, "ZipWith")) return Option.some(this.zipWith(s, node))
    if (Predicate.isTagged(node, "Alt")) return Option.some(this.alt(node, out, b, fail, bf, d))
    if (Predicate.isTagged(node, "Dispatch")) return Option.some(this.dispatch(p, node, out, b, fail, bf, d))
    if (Predicate.isTagged(node, "Repeat")) {
      return Option.some(this.repeat(node, out, b, fail, bf, this.collect(node.self, out, d)))
    }
    if (Predicate.isTagged(node, "Fold")) {
      return Option.some(
        node.while === undefined
          ? this.fold(node, out, b, fail, bf, d)
          : this.island(p, out, b, fail, "the condition needs the accumulator")
      )
    }
    if (Predicate.isTagged(node, "Separated")) {
      return Option.some(this.separated(node, out, b, fail, bf, d, this.collect(node.self, out, d)))
    }
    return Option.none()
  }

  private struct(s: Site, node: NodeOf<"Struct">): string {
    const { b, out } = s
    if (out === "") {
      for (const q of node.parsers) this.gen(q, "", b, s.fail, s.bf, s.d)
      return ""
    }
    const vars = node.parsers.map(() => this.v(s.bf))
    const code = node.parsers.map((q, i) => this.gen(q, vars[i], b, s.fail, s.bf, s.d)).join("")
    if (node.keys.includes("__proto__")) {
      return code + `${out}={};` + node.keys.map((k, i) => `${out}[${this.const(k)}]=${vars[i]};`).join("")
    }
    return code + `${out}={${node.keys.map((k, i) => `[${this.const(k)}]:${vars[i]}`).join(",")}};`
  }

  private zipWith(s: Site, node: NodeOf<"ZipWith">): string {
    const { b, out } = s
    if (out === "") {
      this.gen(node.self, "", b, s.fail, s.bf, s.d)
      this.gen(node.that, "", b, s.fail, s.bf, s.d)
      return ""
    }
    const x = this.v(s.bf)
    const y = this.v(s.bf)
    return (
      this.gen(node.self, x, b, s.fail, s.bf, s.d) +
      this.gen(node.that, y, b, s.fail, s.bf, s.d) +
      `${out}=${this.const(node.f)}(${x},${y});`
    )
  }

  /** Writes `value` to the trace word at the address in local `slot`. */
  private putAt(b: Body, slot: number, value: number): void {
    b.get(slot).i32(value).mem(Op.i32Store, 2, 0)
  }

  // ---------------------------------------------------------------------------
  // Mapping
  // ---------------------------------------------------------------------------

  private map(node: NodeOf<"Map">, out: string, b: Body, fail: Label, bf: Vars, d: number) {
    if (out === "") return this.gen(node.self, "", b, fail, bf, d)
    if (node.f === toFloat) {
      const code = this.float(node, out, b, fail, bf, d)
      if (Option.isSome(code)) return code.value
    }
    if (node.f === fromEntries && buildsEntries(node.self)) return this.entries(node.self, out, b, fail, bf, d)
    const x = this.v(bf)
    return this.gen(node.self, x, b, fail, bf, d) + `${out}=${this.const(node.f)}(${x});`
  }

  /** Whether `Ascii.float` / `Text.float` (`map(text, toFloat)`) can be scanned and converted in one pass. */
  private floatScans(node: NodeOf<"Map">): boolean {
    return node.f === toFloat && floatTexts.has(node.self) && Option.isSome(this.floatEncoding(node.self))
  }

  /**
   * The encoding of the text parser of `Ascii.float` / `Text.float` (`none`
   * for `Ascii`), when the scan reads it: decimal notation is ASCII, which
   * every built-in encoding read here encodes as one unit per character.
   */
  private floatEncoding(p: ParserLike): Option.Option<Enc> {
    let taken = nodeOf(p)
    while (Predicate.isTagged(taken, "Expected")) taken = nodeOf(taken.self)
    if (!Predicate.isTagged(taken, "Taken")) return Option.none()
    const enc = taken.encoding
    return this.native(enc) ? Option.some(enc) : Option.none()
  }

  /**
   * `Ascii.float` and `Text.float`: decimal numbers are matched and
   * converted in one pass (see `scanFloat`); the other forms (`nan`, `inf`)
   * are matched by the float's text parser and converted by `toFloat`. The
   * trace holds the double.
   */
  private float(node: NodeOf<"Map">, out: string, b: Body, fail: Label, bf: Vars, d: number): Option.Option<string> {
    if (!this.floatScans(node)) return Option.none()
    return Option.some(this.scanFloatThen(node, out, b, fail, false, bf, d))
  }

  /** `filter(float, Number.isFinite)`: the float scan, then a test of the double. */
  private finiteFloat(self: ParserLike, out: string, b: Body, fail: Label, bf: Vars, d: number): Option.Option<string> {
    const node = nodeOf(self)
    if (!Predicate.isTagged(node, "Map") || !this.floatScans(node)) return Option.none()
    return Option.some(this.scanFloatThen(node, out, b, fail, true, bf, d))
  }

  /**
   * The float at `p`: the scan of a decimal number, or else the float's text
   * parser, whose text `toFloat` converts in JavaScript. A failure of the
   * scan fails with `Backtrack`, as the text parser would. With `finite`, a
   * value that isn't finite fails.
   */
  private scanFloatThen(
    map: NodeOf<"Map">,
    out: string,
    b: Body,
    fail: Label,
    finite: boolean,
    bf: Vars,
    d: number
  ): string {
    const enc = Option.getOrUndefined(this.floatEncoding(map.self))
    let taken = nodeOf(map.self)
    while (Predicate.isTagged(taken, "Expected")) taken = nodeOf(taken.self)
    const r = b.local()
    const st = b.local()
    b.get(0).set(st)
    b.get(0).call(this.scanFloat(enc)).tee(r).i32(-1).op(Op.i32Eq)
    b.if(
      () => {
        // Not decimal: the text parser (its text is ASCII, so `taken` has nothing to validate)
        if (Predicate.isTagged(taken, "Taken")) this.gen(taken.self, "", b, fail, bf, d)
        b.get(st).get(0).call(Imp.float).gset(G.f)
      },
      () => {
        b.get(r).i32(-2).op(Op.i32Eq)
        this.failIf(b, fail)
        b.get(r).set(0)
      }
    )
    if (finite) {
      // x - x is 0 for finite doubles, NaN otherwise
      b.gget(G.f).gget(G.f).op(Op.f64Sub).f64(0).op(Op.f64Ne)
      this.failIf(b, fail)
    }
    if (out === "") return ""
    this.putF64(b)
    return `i=(i+1)&-2;${out}=F[i>>1];i+=2;`
  }

  // ---------------------------------------------------------------------------
  // Sequences and choice
  // ---------------------------------------------------------------------------

  private seq(node: NodeOf<"Seq">, out: string, b: Body, fail: Label, bf: Vars, d: number): string {
    const output = node.output
    if (out === "") {
      for (const q of node.parsers) this.gen(q, "", b, fail, bf, d)
      return ""
    }
    if (Predicate.isNumber(output)) {
      return node.parsers.map((q, i) => this.gen(q, i === output ? out : "", b, fail, bf, d)).join("")
    }
    const keep = (i: number) => output === "tuple" || output.includes(i)
    const vars = node.parsers.map((_, i) => (keep(i) ? this.v(bf) : ""))
    const code = node.parsers.map((q, i) => this.gen(q, vars[i], b, fail, bf, d)).join("")
    // A pair keeps its indices' order, which may differ from the parsers'
    const kept = output === "tuple" ? vars.filter((v) => v !== "") : output.map((i) => vars[i])
    return code + `${out}=[${kept.join(",")}];`
  }

  private alt(node: NodeOf<"Alt">, out: string, b: Body, fail: Label, bf: Vars, d: number): string {
    const parsers = node.parsers
    if (Arr.isReadonlyArrayEmpty(parsers)) {
      this.failWith(b, fail, Backtrack)
      return ""
    }
    if (parsers.length === 1) return this.gen(parsers[0], out, b, fail, bf, d)
    const saved = this.save(b)
    const cases: Array<string> = []
    b.block((done) => {
      parsers.forEach((q, i) => {
        b.block((bad) => {
          if (out !== "") this.put(b, [() => b.i32(i)])
          cases.push(this.gen(q, out, b, bad, bf, d))
          b.br(done)
        })
        this.unlessBacktrack(b, fail)
        this.restore(b, saved)
      })
      this.failWith(b, fail, Backtrack)
    })
    if (out === "") return ""
    return `switch(T[i++]){${cases.map((c, i) => `case ${i}:{${c}break}`).join("")}}`
  }

  private dispatch(
    p: ParserLike,
    node: NodeOf<"Dispatch">,
    out: string,
    b: Body,
    fail: Label,
    bf: Vars,
    d: number
  ): string {
    const { node: sel, peek } = selectorOf(node.selector)
    const cases = node.cases
    if (cases === undefined || !Predicate.isTagged(sel, "Any") || !this.native(sel.encoding)) {
      return this.island(p, out, b, fail, "the selector runs in JavaScript")
    }
    const enc = sel.encoding
    const r = Option.map(Option.fromUndefinedOr(enc), (e) => this.reader(e))
    const size = this.dispatchSize(r)
    if (size === 0) return this.island(p, out, b, fail, "the selector runs in JavaScript")
    const bytes = enc === undefined && this.kind === 1
    const choose = (unit: number) => node.choose(bytes ? unit : charOf(unit))
    // The distinct cases, by the units below `size` that select them
    const targets: Array<ParserLike> = []
    for (let unit = 0; unit < size; unit++) {
      const q = choose(unit)
      if (q !== undefined && !targets.includes(q)) targets.push(q)
    }
    const closed = node.otherwise === undefined && closedKeys(Reflect.ownKeys(cases), size, bytes)
    const u = b.local()
    const st = b.local()
    b.get(0).set(st)
    this.selectorUnit(b, r, size)
    b.set(u)
    b.get(u).i32(-1).op(Op.i32Eq)
    this.failIf(b, fail)
    const code: Array<string> = []
    let general = ""
    b.block((done) =>
      // A block per case, then one for a unit that selects no case and one for the units from `size` up
      this.nested(
        b,
        targets.length + 2,
        (labels) => {
          const table = Arr.makeBy(size, (unit) => {
            const q = choose(unit)
            return q === undefined ? labels[targets.length] : labels[targets.indexOf(q)]
          })
          b.get(u).brTable(table, labels[targets.length + 1])
        },
        (j) => {
          if (j < targets.length) {
            if (!peek) this.advance(b, Option.match(r, { onNone: () => 1, onSome: (x) => x.width }))
            if (out !== "") this.put(b, [() => b.i32(j)])
            code[j] = this.gen(targets[j], out, b, fail, bf, d)
            b.br(done)
          } else if (j === targets.length || closed) {
            this.failWith(b, fail, Backtrack)
          } else {
            // The dispatch reads a code point beyond the fast units: it runs in JavaScript
            b.get(st).set(0)
            if (out !== "") this.put(b, [() => b.i32(targets.length)])
            general = this.island(p, out, b, fail, "the selector reads a code point beyond the fast units")
            b.br(done)
          }
        }
      )
    )
    if (out === "") return ""
    return `switch(T[i++]){${code.map((c, j) => `case ${j}:{${c}break}`).join("")}default:{${general}}}`
  }

  /** How many units a `dispatch` switches on: the units that are whole code points, at most `TableSize`. */
  private dispatchSize(r: Option.Option<Reader>): number {
    const limit = Option.match(r, {
      onNone: () => (this.kind === 0 ? 0xd800 : TableSize),
      onSome: (x) => Math.min(x.fast, 0xd800)
    })
    return Math.min(limit, TableSize)
  }

  /** Pushes the unit a `dispatch` switches on: -1 at the end, `size` for a unit cut short. */
  private selectorUnit(b: Body, r: Option.Option<Reader>, size: number): void {
    if (Option.isNone(r)) {
      this.atEnd(b, 0)
      b.ifI32(
        () => b.i32(-1),
        () => this.load(b, 0)
      )
      return
    }
    const reader = r.value
    reader.guard(b, 0)
    b.ifI32(
      () => reader.unit(b, 0),
      () => {
        this.atEnd(b, 0)
        b.ifI32(
          () => b.i32(-1),
          () => b.i32(size)
        )
      }
    )
  }

  /**
   * `n` nested blocks around `inner`, which gets their labels, outermost
   * first; after the end of block `j` (where a branch to its label goes),
   * `after(j)` runs.
   */
  private nested(b: Body, n: number, inner: (labels: ReadonlyArray<Label>) => void, after: (j: number) => void): void {
    const open = (j: number, labels: ReadonlyArray<Label>): void => {
      if (j === n) return inner(labels)
      b.block((l) => open(j + 1, [...labels, l]))
      after(j)
    }
    open(0, [])
  }

  // ---------------------------------------------------------------------------
  // Repetition
  // ---------------------------------------------------------------------------

  /** An element that is pushed to an array (or not kept). */
  private collect(self: ParserLike, out: string, d: number): Element {
    return (b, fail, bf) => {
      if (out === "") {
        this.gen(self, "", b, fail, bf, d)
        return ""
      }
      const x = this.v(bf)
      return `${this.gen(self, x, b, fail, bf, d)}${out}.push(${x});`
    }
  }

  /** The builder of a repetition: its count, then each element. */
  private many(out: string, init: string, element: string, finish: string, bf: Vars): string {
    if (out === "") return ""
    const n = this.v(bf)
    const k = this.v(bf)
    return `${init}${n}=T[i++];for(${k}=0;${k}<${n};${k}++){${element}}${finish}`
  }

  /**
   * After a failed element or separator: fails unless it backtracked and
   * `n` reached `min`; otherwise restores the position and stops.
   */
  private stop(b: Body, fail: Label, n: number, min: number, restore: () => void, done: Label): void {
    this.unlessBacktrack(b, fail)
    if (min > 0) {
      b.get(n).i32(min).op(Op.i32LtU)
      b.if(() => b.br(fail))
    }
    restore()
    b.br(done)
  }

  /** Counts an element in local `n` and goes on to the next. */
  private nextElement(b: Body, n: number, again: Label): void {
    b.get(n).i32(1).op(Op.i32Add).set(n)
    b.br(again)
  }

  /** Writes the count in local `n` to the trace word reserved at `slot`, if any. Returns no builder code. */
  private counted(b: Body, slot: number, n: number): string {
    if (slot >= 0) b.get(slot).get(n).mem(Op.i32Store, 2, 0)
    return ""
  }

  /** An unbounded repetition that consumed nothing since `from` fails with `Cut`, as the interpreter does. */
  private progress(b: Body, fail: Label, from: number): void {
    b.get(0).get(from).op(Op.i32Eq)
    b.if(() => this.failWith(b, fail, Cut))
  }

  repeat(
    node: NodeOf<"Repeat"> | NodeOf<"Fold">,
    out: string,
    b: Body,
    fail: Label,
    bf: Vars,
    element: Element,
    init = out === "" ? "" : `${out}=[];`,
    finish = ""
  ): string {
    const { max, min } = node
    const n = b.local()
    const slot = out === "" ? -1 : this.slot(b)
    let elementCode = ""
    b.i32(0).set(n)
    b.block((done) => {
      this.loop(b, (again) => {
        if (max !== Infinity) b.get(n).i32(max).op(Op.i32GeU).brIf(done)
        const saved = this.save(b)
        this.attempt(
          b,
          (bad) => {
            elementCode = element(b, bad, bf)
            if (max === Infinity) this.progress(b, fail, saved[0])
            this.nextElement(b, n, again)
          },
          () => this.stop(b, fail, n, min, () => this.restore(b, saved), done)
        )
      })
    })
    return this.counted(b, slot, n) + this.many(out, init, elementCode, finish, bf)
  }

  private fold(node: NodeOf<"Fold">, out: string, b: Body, fail: Label, bf: Vars, d: number): string {
    const f = this.const(node.f)
    const element: Element = (body, bad, vars) => {
      if (out === "") {
        this.gen(node.self, "", body, bad, vars, d)
        return ""
      }
      const x = this.v(vars)
      return `${this.gen(node.self, x, body, bad, vars, d)}${out}=${f}(${out},${x});`
    }
    return this.repeat(node, out, b, fail, bf, element, out === "" ? "" : `${out}=${this.const(node.init)}();`)
  }

  separated(
    node: NodeOf<"Separated">,
    out: string,
    b: Body,
    fail: Label,
    bf: Vars,
    d: number,
    element: Element,
    init = out === "" ? "" : `${out}=[];`,
    finish = ""
  ): string {
    const { max, min } = node
    if (max === 0) return out === "" ? "" : `${init}${finish}`
    const n = b.local()
    const st = b.local()
    const t = b.local()
    const slot = out === "" ? -1 : this.slot(b)
    let elementCode = ""
    const mark = () => b.get(0).set(st).get(b.tp).set(t)
    const back = () => b.get(st).set(0).get(t).set(b.tp)
    b.i32(0).set(n)
    b.block((done) => {
      mark()
      this.attempt(
        b,
        (bad) => {
          elementCode = element(b, bad, bf)
          b.i32(1).set(n)
        },
        () => {
          // The first element failed: fatal unless it backtracked and none are needed
          this.unlessBacktrack(b, fail)
          if (min > 0) b.br(fail)
          back()
          b.br(done)
        }
      )
      this.loop(b, (again) => {
        if (max !== Infinity) b.get(n).i32(max).op(Op.i32GeU).brIf(done)
        mark()
        this.attempt(
          b,
          (bad) => this.gen(node.separator, "", b, bad, bf, d),
          () => this.stop(b, fail, n, min, back, done)
        )
        if (max === Infinity) this.progress(b, fail, st)
        this.attempt(
          b,
          (bad) => {
            // The same element code again: its builder code is the same
            element(b, bad, new Vars())
            this.nextElement(b, n, again)
          },
          () => this.stop(b, fail, n, min, back, done)
        )
      })
    })
    return this.counted(b, slot, n) + this.many(out, init, elementCode, finish, bf)
  }

  /**
   * `map(self, Object.fromEntries)` where `buildsEntries(self)`: the scan is
   * the usual one, and the builder assigns each entry as it is read, as the
   * JIT does (see `internal/entries.ts`).
   */
  private entries(p: ParserLike, out: string, b: Body, fail: Label, bf: Vars, d: number): string {
    const node = nodeOf(p)
    if (Predicate.isTagged(node, "Mode")) {
      return this.withMode(b, node, fail, (bad) => this.entries(node.self, out, b, bad, bf, d))
    }
    if (Predicate.isTagged(node, "Seq") && Predicate.isNumber(node.output)) {
      const kept = node.output
      return node.parsers
        .map((q, j) => (j === kept ? this.entries(q, out, b, fail, bf, d) : this.gen(q, "", b, fail, bf, d)))
        .join("")
    }
    if (isDiagnostic(node)) return this.entries(node.self, out, b, fail, bf, d)
    const pair =
      Predicate.isTagged(node, "Repeat") || Predicate.isTagged(node, "Separated") ? pairOf(node.self) : undefined
    if ((Predicate.isTagged(node, "Repeat") || Predicate.isTagged(node, "Separated")) && pair !== undefined) {
      const deferred = this.v(bf)
      // The element's variables are declared in the enclosing builder function
      const element: Element = (body, bad) => {
        const key = this.v(bf)
        const value = this.v(bf)
        const code = pair.parsers
          .map((q, j) => this.gen(q, j === pair.key ? key : j === pair.value ? value : "", body, bad, bf, d))
          .join("")
        return (
          code +
          `if(${deferred}===void 0&&R.isPlainKey(${key}))${out}[${key}]=${value};` +
          `else ${deferred}=R.addEntry(${out},${deferred},${key},${value});`
        )
      }
      const init = `${out}={};${deferred}=void 0;`
      const finish = `if(${deferred}!==void 0)R.flushEntries(${out},${deferred});`
      return Predicate.isTagged(node, "Repeat")
        ? this.repeat(node, out, b, fail, bf, element, init, finish)
        : this.separated(node, out, b, fail, bf, d, element, init, finish)
    }
    const x = this.v(bf)
    return this.gen(p, x, b, fail, bf, d) + `${out}=${this.const(fromEntries)}(${x});`
  }

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  /** How the scan reads an encoding's code points. */
  reader(enc: Encoding<any>): Reader {
    if (enc === utf16le || enc === utf16be) {
      const [lo, hi] = enc === utf16le ? [0, 1] : [1, 0]
      return {
        width: 2,
        fast: 0xd800,
        guard: (b, pos) => this.end(b.get(pos).i32(1).op(Op.i32Add)).op(Op.i32LtU),
        unit: (b, pos) => {
          this.load(b, pos, lo)
          this.load(b, pos, hi)
          b.i32(8).op(Op.i32Shl, Op.i32Or)
        },
        decode: this.decoder(enc)
      }
    }
    return {
      width: 1,
      fast: enc === latin1 ? TableSize : fastLimit(enc),
      guard: (b, pos) => this.end(b.get(pos)).op(Op.i32LtU),
      unit: (b, pos) => this.load(b, pos),
      decode: enc === latin1 ? -1 : this.decoder(enc)
    }
  }

  /**
   * Pushes whether the code point in local `c`, known to be below `below`,
   * is in the set (taking `negate` into account). Known ranges compile to
   * comparisons, testing the accepted runs or the rejected ones, whichever
   * takes fewer; otherwise a table below `TableSize`, then the ranges or the
   * set's test above it.
   */
  private member(cs: CharSet, negate: boolean, c: number, b: Body, below = 0x110000): void {
    const max = Math.min(below, this.kind === 1 && this.tokenBytes ? 256 : 0x110000) - 1
    const runs = acceptedRuns(cs, negate, max)
    const cost = (rs: ReadonlyArray<readonly [number, number]>) =>
      rs.reduce((n, [lo, hi]) => n + (lo === hi || lo === 0 || hi >= max ? 1 : 2), 0)
    /** Pushes whether `c` is in one of the runs. */
    const compare = (rs: ReadonlyArray<readonly [number, number]>) => {
      if (Arr.isReadonlyArrayEmpty(rs)) {
        b.i32(0)
        return
      }
      rs.forEach(([lo, hi], k) => {
        if (lo === hi) b.get(c).i32(lo).op(Op.i32Eq)
        else if (lo === 0) b.get(c).i32(hi).op(Op.i32LeU)
        else if (hi >= max) b.get(c).i32(lo).op(Op.i32GeU)
        else
          b.get(c)
            .i32(lo)
            .op(Op.i32Sub)
            .i32(hi - lo)
            .op(Op.i32LeU)
        if (k > 0) b.op(Op.i32Or)
      })
    }
    if (Option.isSome(runs)) {
      const accept = runs.value
      const reject = Option.getOrElse(acceptedRuns({ ...cs, ranges: accept }, true, max), () => [])
      if (Math.min(cost(accept), cost(reject)) <= 6) {
        if (cost(accept) <= cost(reject)) compare(accept)
        else {
          compare(reject)
          b.op(Op.i32Eqz)
        }
        return
      }
    }
    const table = new Uint8Array(TableSize)
    for (let x = 0; x < TableSize; x++) table[x] = (cs.table[x] === 1) !== negate ? 1 : 0
    const callTest = () => {
      const test = cs.test
      this.tests.push((x) => (test(x) !== negate ? 1 : 0))
      b.i32(this.tests.length - 1)
        .get(c)
        .call(Imp.test)
    }
    const offset = this.table(table)
    if (offset < 0) {
      callTest()
      return
    }
    if (max < TableSize) {
      b.get(c).mem(Op.i32Load8U, 0, offset)
      return
    }
    const high = Option.map(runs, (rs) => rs.filter(([, hi]) => hi >= TableSize))
    b.get(c).i32(TableSize).op(Op.i32LtU)
    b.ifI32(
      () => b.get(c).mem(Op.i32Load8U, 0, offset),
      () => {
        if (Option.isSome(high) && cost(high.value) <= 6) compare(high.value)
        else callTest()
      }
    )
  }

  /** Whether the token being compiled reads bytes as `Token` does (code points never exceed 255). */
  private tokenBytes = false

  /** Places a membership table in memory, returning its address. */
  private table(t: Uint8Array): number {
    for (let i = 0; i < this.tables.length; i++) {
      if (this.tables[i].every((x, j) => x === t[j])) return i * TableSize
    }
    // Full: -1, and the set is tested by its function
    if ((this.tables.length + 1) * TableSize > TablesEnd) return -1
    this.tables.push(t)
    return (this.tables.length - 1) * TableSize
  }

  /** Pushes whether a whole unit below `r.fast` is at `p`, leaving it in local `c`. `p < E` holds. */
  private fastUnit(r: Reader, b: Body, c: number): void {
    if (r.width === 1) {
      r.unit(b, 0)
      b.tee(c).i32(r.fast).op(Op.i32LtU)
      return
    }
    r.guard(b, 0)
    b.ifI32(
      () => {
        r.unit(b, 0)
        b.tee(c).i32(r.fast).op(Op.i32LtU)
      },
      () => b.i32(0)
    )
  }

  /**
   * Reads the code point at `p` into local `c` and its width into `w`,
   * branching to `stop` when it is malformed or cut short. `p < E` holds.
   */
  private readCodePoint(enc: Enc, b: Body, c: number, w: number, stop: Label): void {
    if (enc === undefined) {
      this.load(b, 0)
      b.set(c).i32(1).set(w)
      // Token on strings: code points, with lenient surrogates
      if (this.kind === 0) this.lenientPair(b, c, w)
      return
    }
    const r = this.reader(enc)
    if (r.decode < 0) {
      r.unit(b, 0)
      b.set(c).i32(1).set(w)
      return
    }
    this.fastUnit(r, b, c)
    b.if(
      () => b.i32(r.width).set(w),
      () => {
        b.get(0).call(r.decode).tee(c).i32(0).op(Op.i32LtS).brIf(stop)
        b.gget(G.w).set(w)
      }
    )
  }

  /** `Token` on strings: a high surrogate in `c` followed by a low one is read as their pair. */
  private lenientPair(b: Body, c: number, w: number): void {
    b.get(c).i32(0xfc00).op(Op.i32And).i32(0xd800).op(Op.i32Eq)
    b.if(() => {
      b.get(0).i32(1).op(Op.i32Add).gget(G.len).op(Op.i32LtU)
      b.if(() => {
        this.load(b, 0, 1)
        const lo = b.local()
        b.tee(lo).i32(0xfc00).op(Op.i32And).i32(0xdc00).op(Op.i32Eq)
        b.if(() => {
          pair(b, c, lo)
          b.set(c)
          b.i32(2).set(w)
        })
      })
    })
  }

  private token(s: Site, node: NodeOf<"Any" | "Literal" | "OneOf" | "TakeWhile">): string {
    const enc = node.encoding
    if (!this.native(enc)) return this.island(s.p, s.out, s.b, s.fail, "the encoding is decoded in JavaScript")
    this.tokenBytes = enc === undefined && this.kind === 1
    if (Predicate.isTagged(node, "Literal")) return this.literal(s, node)
    if (Predicate.isTagged(node, "TakeWhile")) return this.takeWhile(s, node)
    return this.single(s, node)
  }

  /** `any` and `oneOf`: one code point. */
  private single(s: Site, node: NodeOf<"Any" | "OneOf">): string {
    const { b } = s
    const enc = node.encoding
    const c = b.local()
    const w = b.local()
    const st = b.local()
    b.get(0).set(st)
    this.attempt(
      b,
      (bad) => {
        this.atEnd(b, 0)
        b.brIf(bad)
        this.readCodePoint(enc, b, c, w, bad)
        if (Predicate.isTagged(node, "OneOf")) {
          this.member(enc === undefined ? tokenSet(node.set, this.kind) : textSet(node.set), node.negate, c, b)
          b.op(Op.i32Eqz).brIf(bad)
        }
        b.get(0).get(w).op(Op.i32Add).set(0)
      },
      () => this.failWith(b, s.fail, Backtrack)
    )
    if (s.out === "") return ""
    if (enc !== undefined) {
      this.put(b, [() => b.get(c)])
      return this.set(s, "R.charOf(T[i++])")
    }
    this.put(b, [() => b.get(st), () => b.get(0)])
    return this.set(s, this.kind === 0 ? "I.slice(T[i],T[i+1]);i+=2" : "I[T[i]];i+=2")
  }

  private takeWhile(s: Site, node: NodeOf<"TakeWhile">): string {
    const { b } = s
    const enc = node.encoding
    const { max, min } = node
    const set: Membership = {
      cs: enc === undefined ? tokenSet(node.set, this.kind) : textSet(node.set),
      negate: node.negate,
      c: b.local()
    }
    const w = b.local()
    const st = b.local()
    b.get(0).set(st)
    const counted = max !== Infinity || min > 1
    const n = b.local()
    if (counted) b.i32(0).set(n)
    // UTF-8: whether the slice has a byte from 0x80 up, traced in the sign bit of its start
    const wide = enc === utf8 && s.out !== "" ? b.local() : -1
    if (wide >= 0) b.i32(0).set(wide)
    b.block((stop) => {
      if (!counted && this.vectorRun(enc, set)) this.byteRun(b, set, stop)
      b.loop((again) => {
        this.atEnd(b, 0)
        b.brIf(stop)
        if (max !== Infinity) b.get(n).i32(max).op(Op.i32GeU).brIf(stop)
        this.whileStep(enc, b, set, w, wide, stop)
        if (counted) b.get(n).i32(1).op(Op.i32Add).set(n)
        b.br(again)
      })
    })
    if (min > 0) {
      if (counted) b.get(n).i32(min).op(Op.i32LtU)
      else b.get(0).get(st).op(Op.i32Eq)
      this.failIf(b, s.fail)
    }
    return this.sliceValue(s, enc, st, wide)
  }

  /**
   * The vector steps of an unbounded `takeWhile` on bytes, where every
   * byte is a token: sixteen bytes, up to the first that is not accepted,
   * which ends the run (most runs, tokens, end in the first sixteen); after
   * sixteen accepted, thirty-two at a time while all are. The
   * scalar loop takes the last fifteen bytes. Applies to `Token` and
   * Latin-1 text on bytes, where SIMD validates. (UTF-8, whose bytes from
   * 0x80 up are parts of code points, and strings, whose units are
   * sixteen-bit, stay scalar: on the JSON benchmark, whose runs are short,
   * a vector step there costs more than it saves.)
   */
  private byteRun(b: Body, set: Membership, stop: Label): void {
    const x = b.localV128()
    const y = b.localV128()
    const accepted = this.acceptedBytes(b, set)
    b.block((done) => {
      b.loop((again) => {
        this.end(b).get(0).op(Op.i32Sub).i32(16).op(Op.i32LtS).brIf(done)
        b.get(0).simd(Simd.v128Load, 0, Input).set(x)
        accepted(x)
        b.tee(x).simd(Simd.i8x16AllTrue)
        b.if(() => {
          this.advance(b, 16)
          // A run this long may be longer: thirty-two bytes at a time
          b.block((short) => {
            b.loop((more) => {
              this.end(b).get(0).op(Op.i32Sub).i32(32).op(Op.i32LtS).brIf(short)
              b.get(0).simd(Simd.v128Load, 0, Input).set(x)
              b.get(0)
                .simd(Simd.v128Load, 0, Input + 16)
                .set(y)
              accepted(x)
              accepted(y)
              b.simd(Simd.v128And).simd(Simd.i8x16AllTrue).op(Op.i32Eqz).brIf(short)
              this.advance(b, 32)
              b.br(more)
            })
          })
          b.br(again)
        })
        // Up to the first byte that is not accepted: the end of the run
        b.get(0).get(x).simd(Simd.i8x16Bitmask).i32(-1).op(Op.i32Xor).op(Op.i32Ctz).op(Op.i32Add).set(0)
        b.br(stop)
      })
    })
  }

  /** Whether a `takeWhile` of `set` in `enc` has vector steps (see {@link byteRun}). */
  private vectorRun(enc: Enc, set: Membership): boolean {
    return this.kind === 1 && (enc === undefined || enc === latin1) && simd() && accepts(set)
  }

  /**
   * Code that pushes, for the sixteen bytes in a local, 0xFF where the byte
   * is accepted and 0 where not: comparisons with the rejected bytes when
   * there are at most three of them (`takeTill` of a few stops), else two
   * swizzles of nibble tables for each half of the byte values. Its
   * constants are set up here, in locals.
   */
  private acceptedBytes(b: Body, set: Membership): (x: number) => void {
    const rejected: Array<number> = []
    for (let c = 0; c < 256 && rejected.length <= MaxStops; c++) {
      if ((set.cs.table[c] === 1) === set.negate) rejected.push(c)
    }
    if (rejected.length <= MaxStops) {
      const stops = rejected.map((c) => {
        const l = b.localV128()
        b.i32(c).simd(Simd.i8x16Splat).set(l)
        return l
      })
      return (x) => {
        b.v128(Zeros)
        for (const l of stops) b.get(x).get(l).simd(Simd.i8x16Eq).simd(Simd.v128Or)
        b.simd(Simd.v128Not)
      }
    }
    const tables = [nibbleTable(set, 0), nibbleTable(set, 8)].map((table, k) => {
      const lo = b.localV128()
      const bits = b.localV128()
      b.v128(table)
        .set(lo)
        .v128(k === 0 ? HighNibbleBits : UpperNibbleBits)
        .set(bits)
      return [lo, bits] as const
    })
    return (x) => {
      tables.forEach(([lo, bits], k) => {
        b.get(lo).get(x).v128(LowNibbles).simd(Simd.v128And)
        nibbleSwizzle(b)
        b.get(bits).get(x).i32(4).simd(Simd.i8x16ShrU)
        nibbleSwizzle(b)
        b.simd(Simd.v128And)
        if (k > 0) b.simd(Simd.v128Or)
      })
      b.v128(Zeros).simd(Simd.i8x16Ne)
    }
  }

  /** One code point of a `takeWhile`: advances past it, or branches to `stop`. */
  private whileStep(enc: Enc, b: Body, set: Membership, w: number, wide: number, stop: Label): void {
    const r = Option.map(Option.fromUndefinedOr(enc), (e) => this.reader(e))
    if (Option.isSome(r) && r.value.decode >= 0) {
      // Text: the encoding's single-unit code points inline, the rest decoded
      const reader = r.value
      this.fastUnit(reader, b, set.c)
      b.if(
        () => {
          this.member(set.cs, set.negate, set.c, b, reader.fast)
          b.op(Op.i32Eqz).brIf(stop)
          this.advance(b, reader.width)
        },
        () => {
          b.get(0).call(reader.decode).tee(set.c).i32(0).op(Op.i32LtS).brIf(stop)
          if (wide >= 0) b.i32(1).set(wide)
          this.member(set.cs, set.negate, set.c, b)
          b.op(Op.i32Eqz).brIf(stop)
          b.get(0).gget(G.w).op(Op.i32Add).set(0)
        }
      )
      return
    }
    if (enc === undefined && this.kind === 0) {
      // Token on strings: a unit that isn't a surrogate is a code point
      this.load(b, 0)
      b.tee(set.c).i32(0xf800).op(Op.i32And).i32(0xd800).op(Op.i32Ne)
      b.if(
        () => {
          this.member(set.cs, set.negate, set.c, b, 0x10000)
          b.op(Op.i32Eqz).brIf(stop)
          this.advance(b, 1)
        },
        () => this.codePointStep(enc, b, set, w, stop)
      )
      return
    }
    this.codePointStep(enc, b, set, w, stop)
  }

  /** Reads a code point and tests it, advancing past it, or branches to `stop`. */
  private codePointStep(enc: Enc, b: Body, set: Membership, w: number, stop: Label): void {
    this.readCodePoint(enc, b, set.c, w, stop)
    this.member(set.cs, set.negate, set.c, b)
    b.op(Op.i32Eqz).brIf(stop)
    b.get(0).get(w).op(Op.i32Add).set(0)
  }

  /**
   * `takeUntil` and `takeUntilAny` on bytes: Teddy (as in ripgrep). Sixteen
   * starts at a time, the first `m` bytes of every literal (up to three)
   * are tested at once, with nibble tables: a byte belongs to bucket k at
   * position j when bit k is set both in the low-nibble table at its low
   * nibble and in the high-nibble table at its high nibble, and a start is
   * a candidate when one bucket holds at every position. Each candidate is
   * checked against the literals in full; the last starts, fewer than
   * sixteen, are checked one at a time. Without SIMD, with a range, or on
   * other input, the search runs in JavaScript.
   */
  private takeUntil(s: Site, node: NodeOf<"TakeUntil" | "TakeUntilAny">): string {
    const literals = Predicate.isTagged(node, "TakeUntil") ? [node.literal] : node.literals
    const bytes = literals.filter(Predicate.isUint8Array)
    const shortest = Math.min(...bytes.map((lit) => lit.length))
    const searchable =
      this.kind === 1 &&
      node.encoding === undefined &&
      node.min === 0 &&
      node.max === Infinity &&
      bytes.length === literals.length &&
      shortest > 0 &&
      shortest !== Infinity &&
      bytes.length <= MaxUntil &&
      simd()
    if (!searchable) return this.island(s.p, s.out, s.b, s.fail, "the search runs in JavaScript")
    const { b, fail } = s
    const m = Math.min(MaxPositions, shortest)
    const st = b.local()
    const c = b.local()
    const mask = b.local()
    const acc = b.localV128()
    // The tables and the nibble mask, in locals for the loop
    const position = this.teddyPosition(b, bytes, m, acc)
    b.get(0).set(st)
    b.block((found) => {
      b.block((tail) => {
        b.loop((again) => {
          // Sixteen starts need their `m` bytes inside the input
          this.end(b)
            .get(0)
            .op(Op.i32Sub)
            .i32(15 + m)
            .op(Op.i32LtS)
            .brIf(tail)
          for (let j = 0; j < m; j++) {
            position(j)
            if (j > 0) b.simd(Simd.v128And)
          }
          b.tee(acc).simd(Simd.v128AnyTrue).op(Op.i32Eqz)
          b.if(() => {
            this.advance(b, 16)
            b.br(again)
          })
          // Each candidate of the sixteen, in order, checked in full
          b.get(acc).v128(Zeros).simd(Simd.i8x16Ne).simd(Simd.i8x16Bitmask).set(mask)
          b.loop((bits) => {
            b.get(0).get(mask).op(Op.i32Ctz).op(Op.i32Add).set(c)
            this.literalAt(b, bytes, c, found)
            b.get(mask).get(mask).i32(1).op(Op.i32Sub).op(Op.i32And).tee(mask).brIf(bits)
          })
          this.advance(b, 16)
          b.br(again)
        })
      })
      b.loop((again) => {
        this.end(b).get(0).op(Op.i32Sub).i32(shortest).op(Op.i32LtS)
        this.failIf(b, fail)
        b.get(0).set(c)
        this.literalAt(b, bytes, c, found)
        this.advance(b, 1)
        b.br(again)
      })
    })
    return this.sliceValue(s, undefined, st, -1)
  }

  /**
   * Code that pushes, for the sixteen starts from the cursor, what position
   * `j` of the literals says: with at most three distinct bytes there,
   * 0xFF where the byte is one of them (`i8x16.eq`); otherwise Teddy's
   * bucket bits, from two nibble-table swizzles. Either way a start is a
   * candidate where the AND over the positions is not zero. The constants
   * are set up here, in locals; `v` is a scratch local.
   */
  private teddyPosition(b: Body, literals: ReadonlyArray<Uint8Array>, m: number, v: number): (j: number) => void {
    const distinct = Array.from({ length: m }, (_, j) => Arr.dedupe(literals.map((lit) => lit[j] ?? 0)))
    if (distinct.every((bytes) => bytes.length <= MaxStops)) {
      const splats = distinct.map((bytes) =>
        bytes.map((byte) => {
          const l = b.localV128()
          b.i32(byte).simd(Simd.i8x16Splat).set(l)
          return l
        })
      )
      return (j) => {
        b.get(0)
          .simd(Simd.v128Load, 0, Input + j)
          .set(v)
        b.v128(Zeros)
        for (const l of splats[j] ?? []) b.get(v).get(l).simd(Simd.i8x16Eq).simd(Simd.v128Or)
      }
    }
    const nibbles = b.localV128()
    b.v128(LowNibbles).set(nibbles)
    const tables = teddyTables(literals, m).map(([lo, hi]) => {
      const l = b.localV128()
      const h = b.localV128()
      b.v128(lo).set(l).v128(hi).set(h)
      return [l, h] as const
    })
    return (j) => {
      const [lo, hi] = tables[j] ?? [-1, -1]
      b.get(0)
        .simd(Simd.v128Load, 0, Input + j)
        .set(v)
      b.get(lo).get(v).get(nibbles).simd(Simd.v128And)
      nibbleSwizzle(b)
      b.get(hi).get(v).i32(4).simd(Simd.i8x16ShrU)
      nibbleSwizzle(b)
      b.simd(Simd.v128And)
    }
  }

  /** Moves the cursor to `c` and branches to `found` when one of `literals` starts at `c`. */
  private literalAt(b: Body, literals: ReadonlyArray<Uint8Array>, c: number, found: Label): void {
    for (const lit of literals) {
      b.block((next) => {
        this.end(b).get(c).op(Op.i32Sub).i32(lit.length).op(Op.i32LtS).brIf(next)
        // Compared as many bytes at a time as the literal fills
        const bytes = Array.from(lit)
        for (let i = 0; i < bytes.length;) {
          const n = chunkSize(bytes.length - i)
          b.get(c)
          compareChunk(b, bytes.slice(i, i + n), [], Input + i)
          b.brIf(next)
          i += n
        }
        b.get(c).set(0).br(found)
      })
    }
  }

  /** The trace and builder code of a `takeWhile`'s slice `[st, p)`. */
  private sliceValue(s: Site, enc: Enc, st: number, wide: number): string {
    const { b } = s
    if (s.out === "") return ""
    if (enc === undefined && this.kind === 1) {
      this.put(b, [() => b.get(st), () => b.get(0)])
      return this.set(s, "I.subarray(T[i],T[i+1]);i+=2")
    }
    const start = () => {
      b.get(st)
      if (wide >= 0) b.get(wide).i32(31).op(Op.i32Shl).op(Op.i32Or)
    }
    // A string: short ones are interned, unless they are pieces of an `escaped`, which interns its own
    if (this.plainStrings) {
      this.put(b, [start, () => b.get(0)])
      return this.set(s, `${this.decodeSlice(enc)};i+=2`)
    }
    this.put(b, [start, () => b.get(0), () => this.internCall(b, st), () => b.gget(G.w)])
    return this.interned(s.out, this.decodeSlice(enc))
  }

  /** Pushes the cache slot of `[st, p)` (see `intern`), testing the length inline: most long slices aren't hashed. */
  private internCall(b: Body, st: number): void {
    b.get(0).get(st).op(Op.i32Sub).i32(MaxInterned).op(Op.i32GtU)
    b.ifI32(
      () => b.i32(-1),
      () => b.get(st).get(0).call(this.intern())
    )
  }

  /**
   * Builder code for the string of the slice of a `takeWhile` at `T[i]`,
   * `T[i+1]`. A UTF-8 slice whose start is not negative is ASCII, which
   * `R.ascii` decodes without looking for longer sequences.
   */
  private decodeSlice(enc: Enc): string {
    if (enc === utf8 && this.kind === 1) {
      return `(T[i]<0?${this.const(enc.text)}(I,T[i]&2147483647,T[i+1]):R.ascii(I,T[i],T[i+1]))`
    }
    return enc !== undefined && this.kind === 1 ? `${this.const(enc.text)}(I,T[i],T[i+1])` : "I.slice(T[i],T[i+1])"
  }

  /** While generating the pieces of an `escaped` whose single-piece strings are interned. */
  private plainStrings = false

  private literal(s: Site, node: NodeOf<"Literal">): string {
    const { b, fail } = s
    const units = this.literalUnits(node)
    if (Result.isFailure(units)) return this.island(s.p, s.out, b, fail, units.failure)
    const { codes, constant } = units.success
    const len = codes.length
    const st = b.local()
    b.get(0).set(st)
    if (len > 0) {
      this.end(b).get(0).op(Op.i32Sub).i32(len).op(Op.i32LtS)
      this.failIf(b, fail)
      this.compareUnits(b, codes, node.caseless, fail)
      this.advance(b, len)
    }
    if (s.out === "") return ""
    if (constant) return this.set(s, this.lit(node.literal))
    this.put(b, [() => b.get(st)])
    return this.set(s, this.kind === 0 ? `I.slice(T[i],T[i]+${len});i++` : `I.subarray(T[i],T[i]+${len});i++`)
  }

  /**
   * The units a literal matches, and whether its value is the literal itself
   * (rather than the input it matched, as a caseless one returns), or why it
   * runs in JavaScript.
   */
  /**
   * Fails unless the input at the cursor holds `codes` (folding ASCII
   * letters with `caseless`): the units' bytes compared sixteen, eight,
   * four, two and one at a time, with `v128`, `i64` and `i32` loads, a
   * caseless letter's byte ORed with 0x20 first.
   */
  private compareUnits(b: Body, codes: ReadonlyArray<number>, caseless: boolean, fail: Label): void {
    const { bytes, fold } = unitBytes(codes, caseless, this.kind === 0 ? 2 : 1)
    // The address of the cursor's byte, once
    const at = b.local()
    if (this.kind === 0) b.get(0).i32(1).op(Op.i32Shl).set(at)
    else b.get(0).set(at)
    for (let i = 0; i < bytes.length;) {
      const n = chunkSize(bytes.length - i)
      b.get(at)
      compareChunk(b, bytes.slice(i, i + n), fold.slice(i, i + n), Input + i)
      this.failIf(b, fail)
      i += n
    }
  }

  private literalUnits(
    node: NodeOf<"Literal">
  ): Result.Result<{ readonly codes: ReadonlyArray<number>; readonly constant: boolean }, string> {
    const lit = node.literal
    const enc = node.encoding
    if (enc !== undefined) {
      if (node.caseless || !Predicate.isString(lit)) return Result.fail("caseless text literal")
      const encoded = enc.encode(lit)
      return Result.succeed({
        codes: Predicate.isString(encoded) ? unitsOf(encoded) : Array.from(encoded),
        constant: true
      })
    }
    const constant = !node.caseless
    if (Predicate.isString(lit)) {
      return Result.succeed(
        this.kind === 0
          ? { codes: unitsOf(lit), constant }
          : { codes: Array.from(utf8Encoder.encode(lit)), constant: false }
      )
    }
    if (lit instanceof Uint8Array && this.kind === 1) return Result.succeed({ codes: Array.from(lit), constant })
    return Result.fail("the literal is not of the input's kind")
  }

  /** `escaped`: segments of `normal` and escapes after the control character. */
  private escaped(s: Site, node: NodeOf<"Escaped">): string {
    const { b } = s
    const enc = node.encoding
    if (!this.native(enc)) return this.island(s.p, s.out, b, s.fail, "the encoding is decoded in JavaScript")
    const r = Option.map(Option.fromUndefinedOr(enc), (e) => this.reader(e))
    if (Option.isSome(r) && !(node.control < r.value.fast)) {
      return this.island(s.p, s.out, b, s.fail, "the control character is decoded")
    }
    const pieces = !node.raw && s.out !== ""
    const e: EscapedLocals = {
      r,
      pieces,
      // A string of one piece of `takeWhile` is interned as a whole
      internsWhole:
        pieces && Predicate.isTagged(nodeOf(node.normal), "TakeWhile") && (enc !== undefined || this.kind === 0),
      start: b.local(),
      seg: b.local(),
      ok: b.local(),
      ts: b.local(),
      count: b.local(),
      pieceStart: b.local(),
      slot: pieces ? this.slot(b) : -1,
      x: pieces ? this.v(s.bf) : ""
    }
    let normal = ""
    let escape = ""
    b.get(0).set(e.start)
    b.i32(0).set(e.count)
    b.block((exit) => {
      this.loop(b, (again) => {
        this.atEnd(b, 0)
        b.brIf(exit)
        normal = this.escapedNormal(s, node, e, again)
        // The control character?
        if (Option.isNone(r)) {
          this.atEnd(b, 0)
          b.brIf(exit)
          this.load(b, 0)
        } else {
          r.value.guard(b, 0)
          b.op(Op.i32Eqz).brIf(exit)
          r.value.unit(b, 0)
        }
        b.i32(node.control).op(Op.i32Ne).brIf(exit)
        this.advance(b, Option.match(r, { onNone: () => 1, onSome: (x) => x.width }))
        if (pieces) this.put(b, [() => b.i32(1)])
        escape = this.gen(node.escape, e.x, b, s.fail, s.bf, s.d)
        b.get(e.count).i32(1).op(Op.i32Add).set(e.count)
        b.br(again)
      })
    })
    return this.escapedValue(s, node, e, normal, escape)
  }

  /**
   * A segment of `normal`: one that consumed input continues the loop; one
   * that matched nothing, or failed with `Backtrack`, is dropped (with its
   * trace) for the control character to be tested.
   */
  private escapedNormal(s: Site, node: NodeOf<"Escaped">, e: EscapedLocals, again: Label): string {
    const { b } = s
    let code = ""
    b.get(0).set(e.seg).get(b.tp).set(e.ts).i32(0).set(e.ok)
    b.block((bad) => {
      if (e.pieces) this.put(b, [() => b.i32(0)])
      const plain = this.plainStrings
      this.plainStrings = e.internsWhole
      code = this.gen(node.normal, e.x, b, bad, s.bf, s.d)
      this.plainStrings = plain
      b.i32(1).set(e.ok)
    })
    b.get(e.ok)
    b.if(
      () => {
        b.get(0)
          .get(e.seg)
          .op(node.raw ? Op.i32Eq : Op.i32Ne)
        if (node.raw) {
          // `takeEscaped`: a segment that matched nothing is an error
          b.if(() => this.failWith(b, s.fail, Cut))
          b.br(again)
          return
        }
        b.if(() => {
          b.get(e.count).i32(1).op(Op.i32Add).set(e.count)
          b.get(e.seg).set(e.pieceStart)
          b.br(again)
        })
        b.get(e.ts).set(b.tp)
      },
      () => {
        this.unlessBacktrack(b, s.fail)
        b.get(e.seg).set(0).get(e.ts).set(b.tp)
      }
    )
    return code
  }

  /** The trace and builder code of an `escaped`'s value, from its pieces' code. */
  private escapedValue(s: Site, node: NodeOf<"Escaped">, e: EscapedLocals, normal: string, escape: string): string {
    const { b, out } = s
    const enc = node.encoding
    if (out === "") return ""
    if (node.raw) {
      this.put(b, [() => b.get(e.start), () => b.get(0)])
      if (enc !== undefined && this.kind === 1) return `${out}=${this.const(enc.text)}(I,T[i],T[i+1]);i+=2;`
      return `${out}=${this.kind === 0 ? "I.slice(T[i],T[i+1])" : "I.subarray(T[i],T[i+1])"};i+=2;`
    }
    b.get(e.slot).get(e.count).mem(Op.i32Store, 2, 0)
    const n = this.v(s.bf)
    const k = this.v(s.bf)
    const loop = `${out}="";for(${k}=0;${k}<${n};${k}++){` + `if(T[i++]===0){${normal}}else{${escape}}${out}+=${e.x};}`
    if (!e.internsWhole) {
      // Most strings are one segment without escapes
      return `${n}=T[i++];if(${n}===1&&T[i]===0){i++;${normal}${out}=${e.x}}else{${loop}}`
    }
    // One piece, not an escape: its slice is followed by its cache slot and version
    b.get(e.count).i32(1).op(Op.i32Eq)
    b.if(() => {
      b.get(e.slot).mem(Op.i32Load, 2, 4).op(Op.i32Eqz)
      b.if(() => this.put(b, [() => this.internCall(b, e.pieceStart), () => b.gget(G.w)]))
    })
    return `${n}=T[i++];if(${n}===1&&T[i]===0){i++;${this.interned(out, this.decodeSlice(enc))}}else{${loop}}`
  }

  // ---------------------------------------------------------------------------
  // Interned strings
  // ---------------------------------------------------------------------------

  /** The strings of the cache slots, and the version of the slot each was decoded from. */
  // Only read for a slot whose version the builder decoded, so the placeholders are never returned
  // Allocated when a grammar first interns a string
  private interning = false
  private internedStrings: Array<string> = []
  private internedVersions = /*#__PURE__*/ new Int32Array(0)
  private internIndex = -1

  /**
   * Builder code for a string slice traced as start, end, slot and version
   * (see `intern`): the string decoded from that slot's version if there is
   * one, else `decode`, which is then kept for the slot.
   */
  private interned(out: string, decode: string): string {
    if (!this.interning) {
      this.interning = true
      this.internedStrings = new Array<string>(StringSlots).fill("")
      this.internedVersions = new Int32Array(StringSlots).fill(-1)
    }
    const ks = this.const(this.internedStrings)
    const kv = this.const(this.internedVersions)
    return (
      `${out}=T[i+2];if(${out}>=0&&${kv}[${out}]===T[i+3])${out}=${ks}[${out}];` +
      `else if(${out}>=0){${kv}[${out}]=T[i+3];${out}=${ks}[${out}]=${decode}}else ${out}=${decode};i+=4;`
    )
  }

  /**
   * `(start, end) -> slot`: the cache slot of the units of `[start, end)`,
   * or -1 if there are more than `MaxInterned`, with the slot's version in
   * `G.w`. A slot holds the units of the latest slice hashed to it, and its
   * version changes whenever they do, so every slice traced with a slot and
   * a version has the same units, and the same string: the builder decodes
   * it once per version. The cache outlives a parse, and backtracking can't
   * invalidate it.
   */
  private intern(): number {
    if (this.internIndex >= 0) return this.internIndex
    const [index, b] = this.reserve(Ty.pair, 2)
    this.internIndex = index
    const start = 0
    const end = 1
    const len = b.local()
    const h = b.local()
    const k = b.local()
    const addr = b.local()
    const ver = b.local()
    const width = this.kind === 0 ? 2 : 1
    const unitAt = (pos: () => void) =>
      this.kind === 0
        ? (pos(), b.i32(1).op(Op.i32Shl).mem(Op.i32Load16U, 1, Input))
        : (pos(), b.mem(Op.i32Load8U, 0, Input))
    const cached = (j: () => void) => {
      b.get(addr)
      j()
      if (width === 2) b.i32(1).op(Op.i32Shl)
      b.op(Op.i32Add)
      b.mem(width === 2 ? Op.i32Load16U : Op.i32Load8U, width === 2 ? 1 : 0, 8)
    }
    b.get(end).get(start).op(Op.i32Sub).tee(len).i32(MaxInterned).op(Op.i32GtU)
    b.if(() => b.i32(-1).op(Op.return))
    b.get(len).set(h)
    b.get(start).set(k)
    b.block((done) =>
      b.loop((again) => {
        b.get(k).get(end).op(Op.i32GeU).brIf(done)
        b.get(h).i32(31).op(Op.i32Mul)
        unitAt(() => b.get(k))
        b.op(Op.i32Add).set(h)
        b.get(k).i32(1).op(Op.i32Add).set(k)
        b.br(again)
      })
    )
    b.get(h)
      .get(h)
      .i32(10)
      .op(Op.i32ShrU)
      .op(Op.i32Xor)
      .i32(StringSlots - 1)
      .op(Op.i32And)
      .set(h)
    b.get(h).i32(SlotBytes).op(Op.i32Mul).i32(Strings).op(Op.i32Add).set(addr)
    // The same units?
    b.block((differ) => {
      b.get(addr).mem(Op.i32Load, 2, 4).get(len).op(Op.i32Ne).brIf(differ)
      b.i32(0).set(k)
      b.block((same) =>
        b.loop((again) => {
          b.get(k).get(len).op(Op.i32GeU).brIf(same)
          cached(() => b.get(k))
          unitAt(() => b.get(start).get(k).op(Op.i32Add))
          b.op(Op.i32Ne).brIf(differ)
          b.get(k).i32(1).op(Op.i32Add).set(k)
          b.br(again)
        })
      )
      b.get(addr).mem(Op.i32Load, 2, 0).gset(G.w)
      b.get(h).op(Op.return)
    })
    // No: install them under a new version
    b.get(addr).mem(Op.i32Load, 2, 0).i32(1).op(Op.i32Add).set(ver)
    b.get(addr).get(ver).mem(Op.i32Store, 2, 0)
    b.get(addr).get(len).mem(Op.i32Store, 2, 4)
    b.i32(0).set(k)
    b.block((done) =>
      b.loop((again) => {
        b.get(k).get(len).op(Op.i32GeU).brIf(done)
        b.get(addr).get(k)
        if (width === 2) b.i32(1).op(Op.i32Shl)
        b.op(Op.i32Add)
        unitAt(() => b.get(start).get(k).op(Op.i32Add))
        b.mem(width === 2 ? Op.i32Store16 : Op.i32Store8, width === 2 ? 1 : 0, 8)
        b.get(k).i32(1).op(Op.i32Add).set(k)
        b.br(again)
      })
    )
    b.get(ver).gset(G.w)
    b.get(h)
    return index
  }

  // ---------------------------------------------------------------------------
  // Helper functions
  // ---------------------------------------------------------------------------

  /**
   * `(pos, end, len, tp, tlim) -> p | -1`: sets up the globals of a parse
   * and runs the root, in one call from JavaScript (setting a global from
   * JavaScript costs about as much as a call).
   */
  starter(root: number): number {
    const [index, b] = this.reserve(Ty.start, 5)
    b.get(1).gset(G.end).get(2).gset(G.len).get(3).gset(G.tp).get(4).gset(G.tlim)
    b.i32(0).gset(G.nv).i32(0).gset(G.mode)
    b.get(0).call(root)
    return index
  }

  /**
   * `(src, n) -> count`, for string input: widens the `n` bytes of UTF-8 at
   * `src`, which `TextEncoder#encodeInto` wrote, to the string's UTF-16
   * units at `Input`, sixteen ASCII bytes at a time with SIMD (where it is
   * available) and eight without. `encodeInto` writes each
   * lone surrogate as U+FFFD, which is one unit as well, so every unit is in
   * place; the units that are U+FFFD (or were a lone surrogate) are listed
   * as 32-bit indices from `(src + n + 3) & -4`, for JavaScript to copy from
   * the string. Returns their number.
   */
  widener(): number {
    const [index, b] = this.reserve(Ty.pair, 2)
    const src = 0
    const n = 1
    const end = b.local()
    const k = b.local()
    const c = b.local()
    const cp = b.local()
    const count = b.local()
    const list = b.local()
    const x = b.localI64()
    const byte = (at: number) => b.get(src).mem(Op.i32Load8U, 0, at)
    const cont = (at: number, shift: number) => {
      byte(at)
      b.i32(0x3f).op(Op.i32And)
      if (shift > 0) b.i32(shift).op(Op.i32Shl)
      b.op(Op.i32Or)
    }
    const unit = (delta: number, push: () => void) => {
      b.get(k).i32(1).op(Op.i32Shl)
      push()
      b.mem(Op.i32Store16, 1, Input + 2 * delta)
    }
    const step = (bytes: number, units: number, again: Label) => {
      b.get(src).i32(bytes).op(Op.i32Add).set(src)
      b.get(k).i32(units).op(Op.i32Add).set(k)
      b.br(again)
    }
    /** Spreads four bytes (the low 32 bits of `x`, shifted right by `shift`) to four 16-bit units. */
    const spread = (shift: number) => {
      b.get(x)
      if (shift > 0) b.i64(BigInt(shift)).op(Op.i64ShrU)
      b.i64(0xffffffffn).op(Op.i64And)
      b.tee(x).get(x).i64(16n).op(Op.i64Shl).op(Op.i64Or).i64(0x0000ffff0000ffffn).op(Op.i64And)
      b.tee(x).get(x).i64(8n).op(Op.i64Shl).op(Op.i64Or).i64(0x00ff00ff00ff00ffn).op(Op.i64And)
    }
    b.get(src).get(n).op(Op.i32Add).tee(end).i32(3).op(Op.i32Add).i32(-4).op(Op.i32And).set(list)
    b.block((done) =>
      b.loop((again) => {
        b.get(src).get(end).op(Op.i32GeU).brIf(done)
        // Eight ASCII bytes
        if (simd()) {
          // Sixteen ASCII bytes, with SIMD
          b.get(src).i32(16).op(Op.i32Add).get(end).op(Op.i32LeU)
          b.if(() => {
            b.get(src).simd(Simd.v128Load, 0, 0).simd(Simd.i8x16Bitmask).op(Op.i32Eqz)
            b.if(() => {
              b.get(k).i32(1).op(Op.i32Shl)
              b.get(src).simd(Simd.v128Load, 0, 0).simd(Simd.i16x8ExtendLowI8x16U).simd(Simd.v128Store, 0, Input)
              b.get(k).i32(1).op(Op.i32Shl)
              b.get(src)
                .simd(Simd.v128Load, 0, 0)
                .simd(Simd.i16x8ExtendHighI8x16U)
                .simd(Simd.v128Store, 0, Input + 16)
              step(16, 16, again)
            })
          })
        }
        b.get(src).i32(8).op(Op.i32Add).get(end).op(Op.i32LeU)
        b.if(() => {
          b.get(src).mem(Op.i64Load, 0, 0).tee(x).i64(-0x7f7f7f7f7f7f7f80n).op(Op.i64And).op(Op.i64Eqz)
          b.if(() => {
            const word = b.localI64()
            b.get(x).set(word)
            b.get(k).i32(1).op(Op.i32Shl)
            spread(0)
            b.mem(Op.i64Store, 0, Input)
            b.get(word).set(x)
            b.get(k).i32(1).op(Op.i32Shl)
            spread(32)
            b.mem(Op.i64Store, 0, Input + 8)
            step(8, 8, again)
          })
        })
        byte(0)
        b.tee(c).i32(0x80).op(Op.i32LtU)
        b.if(() => {
          unit(0, () => b.get(c))
          step(1, 1, again)
        })
        b.get(c).i32(0xe0).op(Op.i32LtU)
        b.if(() => {
          unit(0, () => {
            b.get(c).i32(0x1f).op(Op.i32And).i32(6).op(Op.i32Shl)
            cont(1, 0)
          })
          step(2, 1, again)
        })
        b.get(c).i32(0xf0).op(Op.i32LtU)
        b.if(() => {
          b.get(c).i32(0x0f).op(Op.i32And).i32(12).op(Op.i32Shl)
          cont(1, 6)
          cont(2, 0)
          b.tee(cp).i32(0xfffd).op(Op.i32Eq)
          b.if(() => {
            b.get(count).i32(2).op(Op.i32Shl).get(list).op(Op.i32Add).get(k).mem(Op.i32Store, 2, 0)
            b.get(count).i32(1).op(Op.i32Add).set(count)
          })
          unit(0, () => b.get(cp))
          step(3, 1, again)
        })
        b.get(c).i32(0x07).op(Op.i32And).i32(18).op(Op.i32Shl)
        cont(1, 12)
        cont(2, 6)
        cont(3, 0)
        b.i32(0x10000).op(Op.i32Sub).set(cp)
        unit(0, () => b.get(cp).i32(10).op(Op.i32ShrU).i32(0xd800).op(Op.i32Or))
        unit(1, () => b.get(cp).i32(0x3ff).op(Op.i32And).i32(0xdc00).op(Op.i32Or))
        step(4, 2, again)
      })
    )
    b.get(count)
    return index
  }

  /** The decoder of a built-in encoding: `(p) -> code point | -1 | -2`, the width in `G.w`. */
  private decoder(enc: Encoding<any>): number {
    const known = this.decoders.get(enc)
    if (known !== undefined) return known
    const [index, b] = this.reserve(Ty.rule)
    this.decoders.set(enc, index)
    const c = b.local()
    const d = b.local()
    const ret = (code: () => void, width: number) => {
      b.i32(width).gset(G.w)
      code()
      b.op(Op.return)
    }
    const fail = (code: number) => b.i32(code).op(Op.return)
    const at = (k: number) => this.load(b, 0, k)
    const inRange = (k: number) => this.end(b.get(0).i32(k).op(Op.i32Add)).op(Op.i32GeU)
    if (enc === string) {
      at(0)
      b.tee(c).i32(0xf800).op(Op.i32And).i32(0xd800).op(Op.i32Ne)
      b.if(() => ret(() => b.get(c), 1))
      b.get(c).i32(0xdbff).op(Op.i32LeU)
      b.if(() => {
        inRange(1)
        b.if(() => fail(-2))
        at(1)
        b.tee(d).i32(0xfc00).op(Op.i32And).i32(0xdc00).op(Op.i32Eq)
        b.if(() => ret(() => pair(b, c, d), 2))
      })
      fail(-1)
    } else if (enc === utf16le || enc === utf16be) {
      const [lo, hi] = enc === utf16le ? [0, 1] : [1, 0]
      const unitAt = (k: number) => {
        at(k + lo)
        at(k + hi)
        b.i32(8).op(Op.i32Shl, Op.i32Or)
      }
      inRange(1)
      b.if(() => fail(-2))
      unitAt(0)
      b.tee(c).i32(0xf800).op(Op.i32And).i32(0xd800).op(Op.i32Ne)
      b.if(() => ret(() => b.get(c), 2))
      b.get(c).i32(0xdbff).op(Op.i32GtU)
      b.if(() => fail(-1))
      inRange(3)
      b.if(() => fail(-2))
      unitAt(2)
      b.tee(d).i32(0xfc00).op(Op.i32And).i32(0xdc00).op(Op.i32Eq)
      b.if(() => ret(() => pair(b, c, d), 4))
      fail(-1)
    } else {
      // UTF-8, as `decodeUtf8`
      const e = b.local()
      const f = b.local()
      const cont = (l: number) => b.get(l).i32(0xc0).op(Op.i32And).i32(0x80).op(Op.i32Ne)
      /** Fails unless the second byte, in `d`, may follow the lead byte: `a` and `b` are the leads with a range of their own. */
      const second = (a: readonly [number, number, number], z: readonly [number, number, number]) => {
        b.get(c).i32(a[0]).op(Op.i32Eq)
        b.ifI32(
          () => b.get(d).i32(a[1]).op(Op.i32Sub).i32(a[2]).op(Op.i32GtU),
          () => {
            b.get(c).i32(z[0]).op(Op.i32Eq)
            b.ifI32(
              () => b.get(d).i32(z[1]).op(Op.i32Sub).i32(z[2]).op(Op.i32GtU),
              () => cont(d)
            )
          }
        )
        b.if(() => fail(-1))
      }
      /** Reads the continuation byte `k` into local `l`, failing if it is missing or malformed. */
      const next = (k: number, l: number) => {
        inRange(k)
        b.if(() => fail(-2))
        at(k)
        b.set(l)
        cont(l)
        b.if(() => fail(-1))
      }
      at(0)
      b.tee(c).i32(0x80).op(Op.i32LtU)
      b.if(() => ret(() => b.get(c), 1))
      b.get(c).i32(0xc2).op(Op.i32LtU)
      b.if(() => fail(-1))
      inRange(1)
      b.if(() => fail(-2))
      at(1)
      b.set(d)
      b.get(c).i32(0xe0).op(Op.i32LtU)
      b.if(() => {
        cont(d)
        b.if(() => fail(-1))
        ret(() => {
          b.get(c).i32(0x1f).op(Op.i32And).i32(6).op(Op.i32Shl)
          b.get(d).i32(0x3f).op(Op.i32And).op(Op.i32Or)
        }, 2)
      })
      b.get(c).i32(0xf0).op(Op.i32LtU)
      b.if(() => {
        // Overlong (E0 80..9F) and surrogates (ED A0..BF)
        second([0xe0, 0xa0, 0x1f], [0xed, 0x80, 0x1f])
        next(2, e)
        ret(() => {
          b.get(c).i32(0x0f).op(Op.i32And).i32(12).op(Op.i32Shl)
          b.get(d).i32(0x3f).op(Op.i32And).i32(6).op(Op.i32Shl).op(Op.i32Or)
          b.get(e).i32(0x3f).op(Op.i32And).op(Op.i32Or)
        }, 3)
      })
      b.get(c).i32(0xf5).op(Op.i32LtU)
      b.if(() => {
        // Overlong (F0 80..8F) and above U+10FFFF (F4 90..BF)
        second([0xf0, 0x90, 0x2f], [0xf4, 0x80, 0x0f])
        next(2, e)
        next(3, f)
        ret(() => {
          b.get(c).i32(0x07).op(Op.i32And).i32(18).op(Op.i32Shl)
          b.get(d).i32(0x3f).op(Op.i32And).i32(12).op(Op.i32Shl).op(Op.i32Or)
          b.get(e).i32(0x3f).op(Op.i32And).i32(6).op(Op.i32Shl).op(Op.i32Or)
          b.get(f).i32(0x3f).op(Op.i32And).op(Op.i32Or)
        }, 4)
      })
      fail(-1)
    }
    return index
  }

  /**
   * `scanFloatString` / `scanFloatBytes` at `p`: returns where the number
   * ends, with its value in `G.f`; -1 when the text doesn't start like a
   * decimal number; -2 when the float parser fails there. Numbers with more
   * than 15 significant digits or an exponent beyond ±22 are converted by
   * the JavaScript scan, so the value is always `Number`'s.
   */
  private scanFloat(enc: Enc): number {
    const known = enc === undefined ? this.tokenFloatScanner : (this.floatScanners.get(enc) ?? -1)
    if (known >= 0) return known
    const [index, b] = this.reserve(Ty.rule)
    if (enc === undefined) this.tokenFloatScanner = index
    else this.floatScanners.set(enc, index)
    // Decimal notation is ASCII: one unit per character in every encoding read here
    const r = enc === undefined ? undefined : this.reader(enc)
    const width = r?.width ?? 1
    const unit = (k: number) => (r === undefined ? this.load(b, k) : r.unit(b, k))
    const i = 0
    const c = b.local()
    const digits = b.local()
    const e10 = b.local()
    const e = b.local()
    const j = b.local()
    const neg = b.local()
    const start = b.local()
    const high = b.localF64()
    const low = b.localF64()
    const v = b.localF64()
    const isDigit = () => b.get(c).i32(48).op(Op.i32Sub).i32(9).op(Op.i32LeU)
    /** `c = unit(k)`, or -1 if there is no whole unit at `k` */
    const read = (k: number) => {
      if (r === undefined) this.end(b.get(k)).op(Op.i32LtU)
      else r.guard(b, k)
      b.ifI32(
        () => unit(k),
        () => b.i32(-1)
      )
      b.set(c)
    }
    const adv = (l: number) => b.get(l).i32(width).op(Op.i32Add).set(l)
    const inc = (l: number) => b.get(l).i32(1).op(Op.i32Add).set(l)
    const digit = (frac: boolean) => {
      b.get(digits).i32(15).op(Op.i32LtU)
      b.if(
        () => {
          b.get(c).i32(48).op(Op.i32Ne).get(high).f64(0).op(Op.f64Ne).op(Op.i32Or)
          b.if(() => {
            b.get(high).f64(10).op(Op.f64Mul).get(c).i32(48).op(Op.i32Sub).op(Op.f64ConvertI32U).op(Op.f64Add)
            b.set(high)
            inc(digits)
          })
          if (frac) b.get(e10).i32(1).op(Op.i32Sub).set(e10)
        },
        () => {
          // Digits 16 to 19 go to `low`; the rest only scale the number
          const addLow = () =>
            b.get(low).f64(10).op(Op.f64Mul).get(c).i32(48).op(Op.i32Sub).op(Op.f64ConvertI32U).op(Op.f64Add).set(low)
          b.get(digits).i32(19).op(Op.i32LtU)
          if (frac) {
            b.if(() => {
              addLow()
              b.get(e10).i32(1).op(Op.i32Sub).set(e10)
            })
          } else b.if(addLow, () => inc(e10))
          inc(digits)
        }
      )
    }
    b.get(i).set(start)
    read(i)
    b.get(c).i32(45).op(Op.i32Eq).get(c).i32(43).op(Op.i32Eq).op(Op.i32Or)
    b.if(
      () => {
        b.get(i).i32(width).op(Op.i32Add).set(j)
        read(j)
        isDigit()
        b.get(c).i32(46).op(Op.i32Eq).op(Op.i32Or).op(Op.i32Eqz)
        b.if(() => b.i32(-1).op(Op.return))
        adv(i)
      },
      () => {
        isDigit()
        b.get(c).i32(46).op(Op.i32Eq).op(Op.i32Or).op(Op.i32Eqz)
        b.if(() => b.i32(-1).op(Op.return))
      }
    )
    b.get(c).i32(46).op(Op.i32Ne)
    b.if(
      () => {
        b.loop((more) => {
          digit(false)
          adv(i)
          read(i)
          isDigit()
          b.brIf(more)
        })
        b.get(c).i32(46).op(Op.i32Eq)
        b.if(() => {
          adv(i)
          read(i)
        })
      },
      () => {
        adv(i)
        read(i)
        isDigit()
        b.op(Op.i32Eqz)
        b.if(() => b.i32(-2).op(Op.return))
      }
    )
    b.block((done) =>
      b.loop((more) => {
        isDigit()
        b.op(Op.i32Eqz).brIf(done)
        digit(true)
        adv(i)
        read(i)
        b.br(more)
      })
    )
    b.get(c).i32(32).op(Op.i32Or).i32(101).op(Op.i32Eq)
    b.if(() => {
      b.get(i).i32(width).op(Op.i32Add).set(j)
      read(j)
      b.get(c).i32(45).op(Op.i32Eq).set(neg)
      b.get(neg).get(c).i32(43).op(Op.i32Eq).op(Op.i32Or)
      b.if(() => {
        adv(j)
        read(j)
      })
      isDigit()
      b.if(() => {
        b.i32(0).set(e)
        b.loop((more) => {
          b.get(e).i32(1000000).op(Op.i32LtS)
          b.if(() => b.get(e).i32(10).op(Op.i32Mul).get(c).i32(48).op(Op.i32Sub).op(Op.i32Add).set(e))
          adv(j)
          read(j)
          isDigit()
          b.brIf(more)
        })
        b.get(e10).i32(0).get(e).op(Op.i32Sub).get(e).get(neg).op(Op.select).op(Op.i32Add).set(e10)
        b.get(j).set(i)
      })
    })
    // The value
    unit(start)
    b.i32(45).op(Op.i32Eq).set(neg)
    b.get(high).f64(0).op(Op.f64Eq)
    b.if(() => {
      b.f64(-0).f64(0).get(neg).op(Op.select).gset(G.f)
      b.get(i).op(Op.return)
    })
    /** `exact[k]`, for `k` in local `l` (or `-l` when `negate`). */
    const pow = (l: number, negate = false) => {
      if (negate) b.i32(0).get(l).op(Op.i32Sub)
      else b.get(l)
      b.i32(3).op(Op.i32Shl).mem(Op.f64Load, 3, Pow10)
    }
    // As `decimal` (internal/numbers.ts): the same double operations, so the same doubles
    const [ph, pl, t, ah, al, bh, bl, wh, wl, xh, xl, pp, err] = Array.from({ length: 13 }, () => b.localF64())
    const lowDigits = b.local()
    /** `twoProduct(a, b)`: `ph + pl` is exactly `a * b`. */
    const twoProduct = (x: () => void, y: () => void) => {
      x()
      y()
      b.op(Op.f64Mul).set(ph)
      b.f64(134217729)
      x()
      b.op(Op.f64Mul).set(t)
      b.get(t).get(t)
      x()
      b.op(Op.f64Sub).op(Op.f64Sub).set(ah)
      x()
      b.get(ah).op(Op.f64Sub).set(al)
      b.f64(134217729)
      y()
      b.op(Op.f64Mul).set(t)
      b.get(t).get(t)
      y()
      b.op(Op.f64Sub).op(Op.f64Sub).set(bh)
      y()
      b.get(bh).op(Op.f64Sub).set(bl)
      b.get(ah).get(bh).op(Op.f64Mul).get(ph).op(Op.f64Sub)
      b.get(ah).get(bl).op(Op.f64Mul).op(Op.f64Add)
      b.get(al).get(bh).op(Op.f64Mul).op(Op.f64Add)
      b.get(al).get(bl).op(Op.f64Mul).op(Op.f64Add).set(pl)
    }
    b.block((slow) => {
      b.get(digits).i32(19).op(Op.i32GtU).brIf(slow)
      b.get(e10).i32(22).op(Op.i32Add).i32(44).op(Op.i32GtU).brIf(slow)
      b.get(digits).i32(15).op(Op.i32LeU)
      b.if(
        () => {
          // Up to 15 digits: one exact multiplication or division (Clinger's fast path)
          b.get(e10).i32(0).op(Op.i32Eq)
          b.if(
            () => b.get(high).set(v),
            () => {
              b.get(e10).i32(0).op(Op.i32GtS)
              b.if(
                () => {
                  b.get(high)
                  pow(e10)
                  b.op(Op.f64Mul).set(v)
                },
                () => {
                  b.get(high)
                  pow(e10, true)
                  b.op(Op.f64Div).set(v)
                }
              )
            }
          )
        },
        () => {
          // 16 to 19 digits: double-double, kept when its error bound rounds to one double
          b.get(digits).i32(15).op(Op.i32Sub).set(lowDigits)
          twoProduct(
            () => b.get(high),
            () => pow(lowDigits)
          )
          b.get(ph).get(low).op(Op.f64Add).set(wh)
          b.get(pl).get(low).get(wh).get(ph).op(Op.f64Sub).op(Op.f64Sub).op(Op.f64Add).set(wl)
          b.get(e10).i32(0).op(Op.i32GeS)
          b.if(
            () => {
              pow(e10)
              b.set(pp)
              twoProduct(
                () => b.get(wh),
                () => b.get(pp)
              )
              b.get(ph).set(xh)
              b.get(pl).get(wl).get(pp).op(Op.f64Mul).op(Op.f64Add).set(xl)
            },
            () => {
              pow(e10, true)
              b.set(pp)
              b.get(wh).get(pp).op(Op.f64Div).set(xh)
              twoProduct(
                () => b.get(xh),
                () => b.get(pp)
              )
              b.get(wh).get(ph).op(Op.f64Sub).get(pl).op(Op.f64Sub).get(wl).op(Op.f64Add).get(pp).op(Op.f64Div).set(xl)
            }
          )
          b.get(xh).get(xl).op(Op.f64Add).set(v)
          b.get(xh)
            .op(Op.f64Abs)
            .f64(1 / 2 ** 96)
            .op(Op.f64Mul)
            .set(err)
          b.get(xh).get(xl).get(err).op(Op.f64Add).op(Op.f64Add).get(v).op(Op.f64Ne).brIf(slow)
          b.get(xh).get(xl).get(err).op(Op.f64Sub).op(Op.f64Add).get(v).op(Op.f64Ne).brIf(slow)
        }
      )
      b.get(v).op(Op.f64Neg).get(v).get(neg).op(Op.select).gset(G.f)
      b.get(i).op(Op.return)
    })
    // Anything else: `Number`, in JavaScript
    b.get(start).get(i).call(Imp.float).gset(G.f)
    b.get(i)
    return index
  }
}

const unitsOf = (s: string): Array<number> => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i))

const utf8Encoder = /*#__PURE__*/ new TextEncoder()

/** The powers of ten that doubles represent exactly, as stored at `Pow10`. */
const powersOfTen: Uint8Array = /*#__PURE__*/ new Uint8Array(
  /*#__PURE__*/ new Float64Array(/*#__PURE__*/ Array.from({ length: 23 }, (_, k) => 10 ** k)).buffer
)

// -----------------------------------------------------------------------------
// Building and running
// -----------------------------------------------------------------------------

/** Runtime helpers of the builder (`R`). */
const fromCharCode = String.fromCharCode

/**
 * The text of ASCII bytes. Short ones are built from their codes, about a
 * third faster than `utf8.text`, which tests every byte for a longer
 * sequence; long ones are decoded by `TextDecoder`.
 */
const ascii = (b: Uint8Array, start: number, end: number): string => {
  const n = end - start
  if (n > 24) return utf8.text(b, start, end)
  if (n <= 4) {
    if (n === 0) return ""
    if (n === 1) return charOf(b[start])
    if (n === 2) return fromCharCode(b[start], b[start + 1])
    if (n === 3) return fromCharCode(b[start], b[start + 1], b[start + 2])
    return fromCharCode(b[start], b[start + 1], b[start + 2], b[start + 3])
  }
  let s = fromCharCode(b[start], b[start + 1], b[start + 2], b[start + 3])
  for (let i = start + 4; i < end; i++) s += charOf(b[i])
  return s
}

const runtime = { some: Option.some, none: Option.none, charOf, isPlainKey, addEntry, flushEntries, ascii }

/** A parser's value, as steps return it. */
type Value = ReturnType<Step>

/**
 * The generated builder. `bind` gives it the views of the memory, the
 * input and the state of a parse (again whenever the memory grows, which
 * replaces the views), `unbind` drops them; then `root` builds the value of
 * the root and `value` that of value island `w`, from the trace at index `i`.
 */
interface Builder {
  readonly bind: (
    t: Int32Array,
    f: Float64Array,
    input: string | Uint8Array,
    end: number,
    values: Array<Value>,
    state: State<any>
  ) => void
  readonly unbind: () => void
  readonly root: (i: number) => Value
  readonly value: (w: number, i: number) => Value
}

/** The state outside a parse: islands only run during one. */
const idle = /*#__PURE__*/ new State("")

const compileWasm = (root: ParserLike, kind: 0 | 1): Result.Result<Compiled, string> => {
  const c = new WasmCompiler(kind)
  c.countRefs(root)
  const rootIndex = c.rule(root, true)
  c.flush()
  const widen = kind === 0 ? c.widener() : -1
  const start = c.starter(rootIndex)
  if (c.functions.some(([, body]) => body.invalid)) return Result.fail("a branch to a label out of scope")
  const globals = [
    { type: I32, init: 0 },
    { type: I32, init: 0 },
    { type: I32, init: 0 },
    { type: I32, init: 0 },
    { type: I32, init: 0 },
    { type: I32, init: 0 },
    { type: I32, init: 0 },
    { type: F64, init: 0 }
  ]
  const tables = new Uint8Array(c.tables.length * TableSize)
  c.tables.forEach((t, i) => tables.set(t, i * TableSize))
  const bytes = encodeModule({
    types: [
      { params: [I32], results: [I32] },
      { params: [I32, I32], results: [I32] },
      { params: [], results: [I32] },
      { params: [I32, I32], results: [F64] },
      { params: [I32, I32, I32, I32, I32], results: [I32] }
    ],
    imports: [
      ["env", "island", Ty.pair],
      ["env", "grow", Ty.grow],
      ["env", "test", Ty.pair],
      ["env", "float", Ty.toF64],
      ["env", "check", Ty.pair]
    ],
    memoryPages: 2,
    functions: c.functions,
    globals,
    exports: [
      ["root", 0, rootIndex],
      ...(widen < 0 ? [] : [["widen", 0, widen] as const]),
      ["start", 0, start],
      ["mode", 3, G.mode],
      ["end", 3, G.end],
      ["len", 3, G.len],
      ["tp", 3, G.tp],
      ["tlim", 3, G.tlim],
      ["nv", 3, G.nv]
    ],
    data: [
      [0, tables],
      [Pow10, powersOfTen]
    ]
  })
  const source =
    `"use strict";let T,F,I,E,V,S,N=0;${c.builders.join("")}${c.valueFns.join("")}` +
    `const W=[${c.valueFns.map((_, k) => `w${k}`).join(",")}];` +
    `return{bind(t,f,inp,e,vals,s){T=t;F=f;I=inp;E=e;V=vals;S=s},unbind(){T=F=I=V=S=void 0},` +
    `root(i){return b${rootIndex}(i)},value(w,i){return W[w](i)}}`
  const build: Builder = new globalThis.Function("C", "R", source)(c.constants, runtime)
  return run(root, c, bytes, kind, build, source)
}

/** A global of a module's exports. */
const exportedGlobal = (exports: WebAssembly.Exports, name: string): Result.Result<WebAssembly.Global, string> => {
  const g = exports[name]
  return g instanceof WebAssembly.Global ? Result.succeed(g) : Result.fail(`no global ${name}`)
}

const run = (
  root: ParserLike,
  c: WasmCompiler,
  bytes: Uint8Array<ArrayBuffer>,
  kind: 0 | 1,
  build: Builder,
  source: string
): Result.Result<Compiled, string> => {
  const memory = new WebAssembly.Memory({ initial: 2 })
  // `memory.buffer` is slow to read: its size, as of the latest growth
  let size = memory.buffer.byteLength
  let i32 = new Int32Array(memory.buffer)
  let f64 = new Float64Array(memory.buffer)
  let u8 = new Uint8Array(memory.buffer)
  const views = () => {
    i32 = new Int32Array(memory.buffer)
    f64 = new Float64Array(memory.buffer)
    u8 = new Uint8Array(memory.buffer)
  }
  /** Grows the memory to at least `bytes`, doubling it. */
  const reserve = (bytes: number) => {
    const have = size
    if (have >= bytes) return
    memory.grow(Math.ceil((Math.max(bytes, have * 2) - have) / PageSize))
    size = memory.buffer.byteLength
    views()
  }
  const steps: Array<Step> = c.islands.map(({ parser }) => jitBackend.build(parser, kind, false).step ?? parser.step)
  const used = c.islands.map(({ used }) => used)
  const tests = c.tests
  const checks = c.checks
  let state: State<any> = idle
  const values: Array<Value> = []
  const imports = {
    env: {
      mem: memory,
      island: (id: number, pos: number): number => {
        const s = state
        s.pos = pos
        const a = steps[id](s)
        if (a === Fail) return s.mode === "Cut" ? -2 : -1
        if (used[id]) values.push(a)
        return s.pos
      },
      // Doubles the memory, returning the new limit of the trace
      grow: (): number => {
        reserve(size * 2)
        // The views changed
        build.bind(i32, f64, state.input, state.end, values, state)
        return size - Slack
      },
      test: (id: number, cp: number): number => tests[id](cp),
      // A value island: the value of its parser, built from its trace at `from`, and the callback
      check: (id: number, from: number): number => {
        const s = state
        const a = checks[id](build.value(id, from >> 2))
        if (a === Fail) {
          s.mode = "Backtrack"
          return 0
        }
        values.push(a)
        return 1
      },
      // The value of the float text at `[start, end)`, which is ASCII: one byte each, or a
      // byte and a zero byte in UTF-16
      float: (start: number, end: number): number => {
        const input: string | Uint8Array = state.input
        return toFloat(
          Predicate.isString(input) ? input.slice(start, end) : latin1.text(input, start, end).replace(/\0/g, "")
        )
      }
    }
  }
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports)
  const exported = instance.exports
  const rootFn = exported.root
  if (!Predicate.isFunction(rootFn)) return Result.fail("no root function")
  const widenFn = kind === 0 ? exported.widen : rootFn
  if (!Predicate.isFunction(widenFn)) return Result.fail("no widen function")
  const startFn = exported.start
  if (!Predicate.isFunction(startFn)) return Result.fail("no start function")
  const names = ["mode"] as const
  const globals = Result.all(names.map((name) => exportedGlobal(exported, name)))
  if (Result.isFailure(globals)) return Result.fail(globals.failure)
  const [mode] = globals.success
  let busy = false
  /** The JIT's step for the parser, built on first use. */
  let fallback: Step = (s) => {
    fallback = jitBackend.build(root, kind, false).step ?? root.step
    return fallback(s)
  }
  /** Copies the input into memory, scans it and builds the value. */
  /**
   * Copies a string's UTF-16 units into memory, at `staging` for its UTF-8
   * (see `widener`): standard `ArrayBuffer` views and `TextEncoder`, so the
   * same code runs everywhere, and a memory backed by a `SharedArrayBuffer`
   * would take it as well.
   */
  const copyString = (input: string, staging: number) => {
    const { written } = utf8Encoder.encodeInto(input, u8.subarray(staging, staging + 3 * input.length))
    const replaced: number = widenFn(staging, written)
    if (replaced === 0) return
    // U+FFFD in the string, or a lone surrogate that `encodeInto` replaced by it: its unit, as it is
    const view = new DataView(memory.buffer)
    const list = (staging + written + 3) >> 2
    for (let r = 0; r < replaced; r++) {
      const at = i32[list + r]
      view.setUint16(Input + 2 * at, input.charCodeAt(at), true)
    }
  }
  /** The string whose units are in memory, if any (`""`: none). */
  let copied = ""
  const parse = (s: State<any>): Value => {
    const input: string | Uint8Array = s.input
    const n = input.length
    const inputBytes = kind === 0 ? 2 * n : n
    const traceStart = (Input + inputBytes + 15) & -16
    // Strings are staged where the trace goes: 3 bytes of UTF-8 and 4 of list at most per unit
    reserve(traceStart + Math.max(Slack * 4, inputBytes * 4, kind === 0 ? 7 * n + 16 : 0))
    if (Predicate.isString(input)) {
      // Strings never change: one already in memory (parsed again, or from another offset) stays there
      if (input !== copied) {
        copied = ""
        copyString(input, traceStart)
        copied = input
      }
    } else {
      // Bytes may change between parses: copy what the scan can read, from the cursor to the end
      u8.set(s.pos === 0 && s.end === n ? input : input.subarray(s.pos, s.end), Input + s.pos)
    }
    values.length = 0
    state = s
    build.bind(i32, f64, input, s.end, values, s)
    const r: number = startFn(s.pos, s.end, n, traceStart, size - Slack)
    if (r < 0) {
      s.mode = mode.value === Cut ? "Cut" : "Backtrack"
      return Fail
    }
    s.pos = r
    return build.root(traceStart >> 2)
  }
  /** The bytes copied by the latest parse: parsing them again from further on is a driver at work. */
  let lastBytes: Uint8Array = new Uint8Array(0)
  /** The state of the parse `parsePending` runs: `Result.try` takes a function without arguments. */
  let pending: State<any> = idle
  const parsePending = () => parse(pending)
  const step: Step = (s) => {
    // A callback that parses with the same parser, while this one runs, runs the JIT
    if (busy) return fallback(s)
    const input: string | Uint8Array = s.input
    if (!Predicate.isString(input)) {
      // Bytes can change, so they are copied on every parse; a driver parsing one token at a time
      // from a large buffer would copy the rest of it for each token, where the JIT copies nothing
      const again = input === lastBytes && s.pos > 0 && s.end - s.pos > LargeRest
      lastBytes = input
      if (again) return fallback(s)
    }
    busy = true
    // Whatever happens (a callback may throw), the next parse starts afresh
    pending = s
    const result = Result.try(parsePending)
    build.unbind()
    state = idle
    pending = idle
    busy = false
    values.length = 0
    if (Result.isFailure(result)) throw result.failure
    return result.success
  }
  return Result.succeed({ backend: "wasm", step, guarded: false, fallbacks: c.fallbacks, error: undefined, source })
}

/**
 * The WebAssembly compiler as a backend. Streaming builds, array input and
 * environments without `WebAssembly` or `new Function` use the JIT, as does
 * a parser whose module fails to build.
 */
export const backend: Backend = {
  build: (p, kind, resumable) => {
    if (resumable || kind === 2 || !supported()) return jitBackend.build(p, kind, resumable)
    // `compileWasm` fails when the module can't be built here; a throw is a bug, and both use the JIT
    const built = Result.flatMap(
      Result.try(() => compileWasm(p, kind)),
      (r) => r
    )
    return Result.match(built, {
      onSuccess: (compiled) => compiled,
      onFailure: (error) => ({ ...jitBackend.build(p, kind, resumable), wasmError: error })
    })
  }
}
