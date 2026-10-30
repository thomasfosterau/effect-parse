// fallow-ignore-file duplicate-export -- every compiler module exports its `backend` under the same name,
// which the Compiler module imports by path; no barrel re-exports both.
/**
 * The JIT: emits JavaScript source for a parser's description and builds
 * it with `new Function`.
 *
 * Every rule (the root, every `suspend` target and every non-leaf parser
 * with several parents) becomes a function `f(p)` taking the cursor and
 * returning the value, or `Fail`, leaving the new cursor in the register
 * `P`. Everything else is inlined as straight-line code, with labelled
 * blocks for failure. The cursor is a local; the input and its end are
 * hoisted into locals. Failures only set `state.mode`, as in the closure
 * compiler.
 *
 * Nodes without an inline form run their closure-compiled steps (which run
 * the interpreter for what they can't compile) on the shared state, with
 * `state.pos` kept in sync.
 */
import * as Arr from "effect/Array"
import * as Predicate from "effect/Predicate"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type { Encoding } from "../../Encoding.js"
import type { State } from "../../Input.js"
import { Fail } from "../../Input.js"
import type { Node, NodeOf, ParserLike } from "../node.js"
import { addEntry, flushEntries, fromEntries, isPlainKey } from "../entries.js"
import { children, nodeOf, scansFloat } from "../node.js"
import { floatScan, floatTexts, scanFloatBytes, scanFloatString, toFloat } from "../numbers.js"
import { compileAny } from "../tokens.js"
import { Key } from "../key.js"
import * as Resume from "../resume.js"
import { charOf, fastLimit, latin1, string, utf16be, utf16le, utf8, validate } from "../text.js"
import type { ClosureCompiler, CompiledRoot, Fallback, Step } from "./closure.js"
import { backend as closureBackend, createClosureCompiler } from "./closure.js"
import { buildsEntries, pairOf } from "./entries.js"
import type { Backend } from "./registry.js"
import type { First } from "./first.js"
import { planAlt, Strict } from "./first.js"
import type { CharSet } from "./sets.js"
import { acceptTable, kindOfEncoding, reachesAbove, TableSize, textSet, tokenSet } from "./sets.js"

/** Helpers available to generated code as `R`. */
const runtime = {
  take: Resume.take,
  save: Resume.save,
  Done: Resume.Done,
  /** Records the result of a resumed repetition (see `Resume.done`). */
  done: (state: State<any>, key: Key, entry: number, value: unknown, pos: number): void =>
    Resume.save(state, key, entry, new Resume.Done(value, pos)),
  some: Option.some,
  none: Option.none,
  charOf,
  scanFloatString,
  scanFloatBytes,
  isPlainKey,
  addEntry,
  flushEntries,
  /** `Text.taken`: the text of `[start, end)`, or `Fail` if it is malformed. */
  textOf: (enc: Encoding<any>, fast: number, s: State<any>, start: number, end: number): unknown => {
    const input = s.input
    let i = start
    if (s.inputKind === 0) while (i < end && (input as string).charCodeAt(i) < fast) i++
    else while (i < end && (input as Uint8Array)[i] < fast) i++
    if (i < end && validate(enc, s, i, end) < 0) {
      s.mode = "Backtrack"
      return Fail
    }
    return enc.text(input, start, end)
  }
}

let checked: FunctionConstructor | undefined
let supported = false

/**
 * Whether `new Function` works here (it doesn't under a Content Security
 * Policy). Checked once, and again if `globalThis.Function` is replaced.
 */
const jitSupported = (): boolean => {
  if (checked !== globalThis.Function) {
    checked = globalThis.Function
    const fn = checked
    supported = Result.getOrElse(
      Result.try(() => fn("return true")() === true),
      () => false
    )
  }
  return supported
}

const BT = `$S.mode="Backtrack";`

const builtinEncodings: ReadonlySet<Encoding<any>> = /*#__PURE__*/ new Set([string, utf8, utf16le, utf16be, latin1])

/** How many units past the cursor a single token can depend on (see the closure compiler). */
const Margin = 4

/** How generated code reads the code units of an encoding (see `Emitter.reader`). */
interface Reader {
  readonly width: number
  readonly fast: number
  readonly guard: (i: string) => string
  readonly unit: (i: string) => string
}

/** Per generated function: its local variables. */
class Fn {
  readonly vars: Array<string> = []
}

const isLeaf = (node: Node): boolean => {
  switch (node._tag) {
    case "Succeed":
    case "Fail":
    case "Eof":
    case "Location":
    case "RestLen":
    case "Any":
    case "Literal":
    case "OneOf":
    case "TakeWhile":
      return true
    default:
      return false
  }
}

const lowerAscii = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c)
const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)

/** The inclusive ranges of 1s in a table. */
const runsOf = (table: Uint8Array): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  for (let i = 0; i < table.length; i++) {
    if (table[i] !== 1) continue
    let j = i
    while (j + 1 < table.length && table[j + 1] === 1) j++
    out.push([i, j])
    i = j
  }
  return out
}

/** A JavaScript expression testing `v` against ranges, or `undefined` if too long. */
const rangeTest = (runs: ReadonlyArray<readonly [number, number]>, v: string): string | undefined => {
  if (Arr.isReadonlyArrayEmpty(runs)) return "false"
  if (runs.length > 4) return undefined
  return runs.map(([a, b]) => (a === b ? `${v}===${a}` : `(${v}>=${a}&&${v}<=${b})`)).join("||")
}

/** The inclusive ranges of `[0, size)` where `table[c] === value`. */
const runsWhere = (table: Uint8Array, size: number, value: 0 | 1): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  for (let i = 0; i < size; i++) {
    if (table[i] !== value) continue
    let j = i
    while (j + 1 < size && table[j + 1] === value) j++
    out.push([i, j])
    i = j
  }
  return out
}

/** How many comparisons it takes to test a run of `[0, size)`. */
const runCost = ([a, b]: readonly [number, number], size: number): number =>
  a === b || a === 0 || b === size - 1 ? 1 : 2

/**
 * A JavaScript expression testing whether `v`, known to be in `[0, size)`,
 * is accepted by `table`, or `undefined` if that takes too many comparisons.
 * It tests the accepted runs or the rejected ones, whichever is cheaper:
 * `c!==34&&c!==92&&c>=32` rather than three two-sided ranges.
 */
const tableTest = (table: Uint8Array, v: string, size: number): string | undefined => {
  const accept = runsWhere(table, size, 1)
  const reject = runsWhere(table, size, 0)
  if (Arr.isReadonlyArrayEmpty(accept)) return "false"
  if (Arr.isReadonlyArrayEmpty(reject)) return "true"
  const cost = (runs: ReadonlyArray<readonly [number, number]>) => runs.reduce((n, r) => n + runCost(r, size), 0)
  const acceptCost = cost(accept)
  const rejectCost = cost(reject)
  if (Math.min(acceptCost, rejectCost) > 6) return undefined
  const terms =
    acceptCost <= rejectCost
      ? accept
          .map(([a, b]) =>
            a === b
              ? `${v}===${a}`
              : a === 0
                ? `${v}<=${b}`
                : b === size - 1
                  ? `${v}>=${a}`
                  : `(${v}>=${a}&&${v}<=${b})`
          )
          .join("||")
      : reject
          .map(([a, b]) =>
            a === b ? `${v}!==${a}` : a === 0 ? `${v}>${b}` : b === size - 1 ? `${v}<${a}` : `(${v}<${a}||${v}>${b})`
          )
          .join("&&")
  return `(${terms})`
}

/**
 * A repetition that builds its own result (see `Emitter.entries`): `init`
 * starts it, `element(fail, check)` parses one element, runs `check` (the
 * repetition's loop check) and adds the element, and `finish` ends it.
 */
interface Collect {
  readonly init: string
  readonly element: (fail: string, check: string) => string
  readonly finish: string
}

class Emitter {
  readonly constants: Array<unknown> = []
  private readonly constantIndex = new Map<unknown, number>()
  readonly functions: Array<string> = []
  private readonly rules = [new Map<ParserLike, string>(), new Map<ParserLike, string>()]
  private readonly refs = new Map<ParserLike, number>()
  private readonly closure: ClosureCompiler
  private next = 0

  constructor(
    readonly root: ParserLike,
    readonly kind: 0 | 1 | 2,
    readonly resumable = false
  ) {
    this.closure = createClosureCompiler(kind, resumable)
    this.countRefs(root)
  }

  get fallbacks(): ReadonlyArray<Fallback> {
    return this.closure.fallbacks
  }

  /** Counts the distinct parents of each parser. */
  private countRefs(root: ParserLike): void {
    const seen = new Set<ParserLike>()
    const stack = [root]
    for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
      if (seen.has(p)) continue
      seen.add(p)
      for (const c of new Set(children(nodeOf(p)))) {
        this.refs.set(c, (this.refs.get(c) ?? 0) + 1)
        stack.push(c)
      }
    }
  }

  const(value: unknown): string {
    let i = this.constantIndex.get(value)
    if (i === undefined) {
      i = this.constants.length
      this.constants.push(value)
      this.constantIndex.set(value, i)
    }
    return `C[${i}]`
  }

  /** A JavaScript literal for simple values, otherwise a constant. */
  lit(value: unknown): string {
    if (value === undefined) return "void 0"
    if (value === null || Predicate.isBoolean(value)) return String(value)
    if (Predicate.isNumber(value) && Number.isFinite(value) && !Object.is(value, -0)) return String(value)
    if (Predicate.isString(value) && value.length < 64) return JSON.stringify(value)
    return this.const(value)
  }

  v(fn: Fn): string {
    const name = `v${this.next++}`
    fn.vars.push(name)
    return name
  }

  label(): string {
    return `L${this.next++}`
  }

  unit(i: string): string {
    return this.kind === 0 ? `I.charCodeAt(${i})` : `I[${i}]`
  }

  /**
   * How generated code reads an encoding's code units: units below `fast`
   * are whole code points, `width` input units long. `guard(i)` says that a
   * whole unit is available at `i`.
   */
  reader(enc: Encoding<any>): Reader {
    if (enc === utf16le || enc === utf16be) {
      const [lo, hi] = enc === utf16le ? ["", "+1"] : ["+1", ""]
      return {
        width: 2,
        fast: 0xd800,
        guard: (i) => `${i}+1<E`,
        unit: (i) => `(I[${i}${lo}]|I[${i}${hi}]<<8)`
      }
    }
    return { width: 1, fast: enc.unit === 1 ? fastLimit(enc) : 0, guard: (i) => `${i}<E`, unit: (i) => this.unit(i) }
  }

  /** The function implementing a rule, generating it on first use. */
  rule(p: ParserLike, used: boolean): string {
    const rules = this.rules[used ? 1 : 0]
    let name = rules.get(p)
    if (name !== undefined) return name
    name = `f${this.next++}`
    rules.set(p, name)
    const fn = new Fn()
    const out = used ? this.v(fn) : null
    const done = this.label()
    const body = this.inline(p, used, out, `break ${done};`, fn, 0)
    this.functions.push(
      `function ${name}(p){const I=$I,E=$E;${Arr.isArrayNonEmpty(fn.vars) ? `let ${fn.vars.join(",")};` : ""}` +
        `${done}:{${body}P=p;return ${out ?? "void 0"}}return F}`
    )
    return name
  }

  /**
   * Code for `p`: on success it falls through with `p` advanced and, when
   * `out` is given, the value in `out`; on failure it runs `fail`.
   */
  gen(p: ParserLike, used: boolean, out: string | null, fail: string, fn: Fn, depth: number): string {
    const node = nodeOf(p)
    if (Predicate.isTagged(node, "Suspend")) return this.call(this.rule(node.resolve(), used), out, fail)
    if (!isLeaf(node) && (((this.refs.get(p) ?? 0) > 1 && !this.small(p)) || depth > 32)) {
      return this.call(this.rule(p, used), out, fail)
    }
    return this.inline(p, used, out, fail, fn, depth)
  }

  /** Whether a parser is small enough to inline wherever it is used. */
  private small(p: ParserLike): boolean {
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

  /**
   * In a resumable build: token code (which fails by breaking out of `bad`)
   * that read within `lookahead` units of the end of a partial input re-runs
   * interpreted, since it may have to report `Incomplete` there. Token code
   * leaves `p` where it stopped reading, even when it fails.
   */
  private partialSafe(
    p: ParserLike,
    code: string,
    bad: string,
    lookahead: number,
    out: string | null,
    fail: string,
    fn: Fn
  ): string {
    const ahead = Math.max(lookahead, Margin)
    const st = this.v(fn)
    const ok = this.v(fn)
    const t = this.v(fn)
    const leaf = this.label()
    return (
      `${st}=p;${ok}=false;${leaf}:{${bad}:{${code}${ok}=true;}` +
      `if(!$S.partial||p+${ahead}<=E){if(${ok})break ${leaf};${fail}}` +
      `p=${st};$S.pos=p;${t}=${this.const(p.step)}($S);if(${t}===F){${fail}}p=$S.pos;${out === null ? "" : `${out}=${t};`}}`
    )
  }

  /**
   * Token code for string and byte input, or the parser's step for input
   * the code can't read. In a resumable build, code that read within
   * `lookahead` units of the end of a partial input re-runs interpreted.
   */
  private leaf(
    p: ParserLike,
    node: NodeOf<"Any" | "Literal" | "OneOf" | "TakeWhile">,
    used: boolean,
    out: string | null,
    fail: string,
    fn: Fn,
    lookahead: number = Margin
  ): string {
    if (!this.native(node.encoding)) return this.delegate(p, used, out, fail, fn)
    if (!this.resumable) return this.token(node, out, fail, fn) ?? this.delegate(p, used, out, fail, fn)
    const bad = this.label()
    const code = this.token(node, out, `break ${bad};`, fn)
    if (code === undefined) return this.delegate(p, used, out, fail, fn)
    return this.partialSafe(p, code, bad, lookahead, out, fail, fn)
  }

  /** Whether a token parser reads array input as such (`Token`'s, on an array). */
  private array(enc: Encoding<any> | undefined): boolean {
    return this.kind === 2 && enc === undefined
  }

  /**
   * Token code for array input, built by `code` with its failure code. Its
   * set's predicate (or membership test) is called on the element, as the
   * interpreter calls it. In a resumable build, code that read the last
   * element of a partial input re-runs interpreted.
   */
  private arrayLeaf(p: ParserLike, code: (fail: string) => string, out: string | null, fail: string, fn: Fn): string {
    if (!this.resumable) return code(fail)
    const bad = this.label()
    return this.partialSafe(p, code(`break ${bad};`), bad, 1, out, fail, fn)
  }

  private arrayAny(out: string | null, fail: string): string {
    return `if(p>=E){${BT}${fail}}${out === null ? "" : `${out}=I[p];`}p++;`
  }

  private arrayOneOf(node: NodeOf<"OneOf">, out: string | null, fail: string): string {
    const m = this.const(compileAny(node.set).forCode.token)
    return `if(p>=E||${m}(I[p])===${node.negate}){${BT}${fail}}${out === null ? "" : `${out}=I[p];`}p++;`
  }

  private arrayTakeWhile(node: NodeOf<"TakeWhile">, out: string | null, fail: string, fn: Fn): string {
    const m = this.const(compileAny(node.set).forCode.token)
    const st = this.v(fn)
    const max = node.max === Infinity ? "" : `&&p-${st}<${node.max}`
    return (
      `${st}=p;while(p<E${max}&&${m}(I[p])!==${node.negate})p++;` +
      (node.min > 0 ? `if(p-${st}<${node.min}){${BT}${fail}}` : "") +
      (out === null ? "" : `${out}=I.slice(${st},p);`)
    )
  }

  call(name: string, out: string | null, fail: string): string {
    if (out === null) return `if(${name}(p)===F){${fail}}p=P;`
    return `${out}=${name}(p);if(${out}===F){${fail}}p=P;`
  }

  /** Runs the closure-compiled step of `p` on the shared state. */
  delegate(p: ParserLike, used: boolean, out: string | null, fail: string, fn: Fn): string {
    const step = this.const(this.closure.compile(p, used))
    const t = out ?? this.v(fn)
    return `$S.pos=p;${t}=${step}($S);if(${t}===F){${fail}}p=$S.pos;`
  }

  private native(enc: Encoding<any> | undefined): boolean {
    return enc === undefined ? this.kind !== 2 : kindOfEncoding(enc) === this.kind
  }

  inline(p: ParserLike, used: boolean, out: string | null, fail: string, fn: Fn, depth: number): string {
    const node = nodeOf(p)
    const set = (value: string) => (out === null ? "" : `${out}=${value};`)
    const d = depth + 1
    switch (node._tag) {
      case "Succeed":
        return set(this.lit(node.value))
      case "Sync":
        return used ? set(`${this.const(node.evaluate)}()`) : ""
      case "Fail":
        return `$S.mode=${JSON.stringify(node.mode)};${fail}`
      case "Eof":
        return (
          `if(p<E){${BT}${fail}}` +
          (this.resumable ? `if($S.partial){$S.mode="Incomplete";${fail}}` : "") +
          set("void 0")
        )
      case "Location":
        return set("p")
      case "RestLen":
        return set("E-p")
      case "Suspend":
        return this.call(this.rule(node.resolve(), used), out, fail)
      case "Any":
        if (this.array(node.encoding)) return this.arrayLeaf(p, (f) => this.arrayAny(out, f), out, fail, fn)
        return this.leaf(p, node, used, out, fail, fn)
      case "OneOf":
        if (this.array(node.encoding)) return this.arrayLeaf(p, (f) => this.arrayOneOf(node, out, f), out, fail, fn)
        return this.leaf(p, node, used, out, fail, fn)
      case "TakeWhile":
        if (this.array(node.encoding))
          return this.arrayLeaf(p, (f) => this.arrayTakeWhile(node, out, f, fn), out, fail, fn)
        return this.leaf(p, node, used, out, fail, fn)
      case "Literal":
        return this.leaf(p, node, used, out, fail, fn, node.literal.length * 4)
      case "Escaped": {
        if (!this.native(node.encoding)) return this.delegate(p, used, out, fail, fn)
        return this.escaped(p, node, out, fail, fn, d)
      }
      case "Map": {
        if (!used) return this.gen(node.self, false, null, fail, fn, d)
        if (node.f === toFloat && out !== null) {
          const code = this.float(node, out, fail, fn, d)
          if (code !== undefined) return code
        }
        // Streaming builds keep the array, which their checkpoints hold
        if (node.f === fromEntries && out !== null && !this.resumable && buildsEntries(node.self)) {
          return this.entries(node.self, out, fail, fn, d)
        }
        const t = this.v(fn)
        return this.gen(node.self, true, t, fail, fn, d) + set(`${this.const(node.f)}(${t})`)
      }
      case "As":
        return this.gen(node.self, false, null, fail, fn, d) + (used ? set(this.lit(node.value)) : "")
      case "Tap": {
        const t = out ?? this.v(fn)
        return this.gen(node.self, true, t, fail, fn, d) + `${this.const(node.f)}(${t});`
      }
      case "TryMap":
      case "FilterMap": {
        const t = this.v(fn)
        const r = this.v(fn)
        const [tag, field] = Predicate.isTagged(node, "TryMap") ? ["Success", "success"] : ["Some", "value"]
        return (
          this.gen(node.self, true, t, fail, fn, d) +
          `${r}=${this.const(node.f)}(${t});if(${r}._tag!=="${tag}"){${BT}${fail}}${set(`${r}.${field}`)}`
        )
      }
      case "Filter": {
        const t = out ?? this.v(fn)
        return this.gen(node.self, true, t, fail, fn, d) + `if(!${this.const(node.predicate)}(${t})){${BT}${fail}}`
      }
      case "FlatMap": {
        const t = this.v(fn)
        const r = out ?? this.v(fn)
        this.closure.note(p, node, "the parser returned by the function runs interpreted")
        return (
          this.gen(node.self, true, t, fail, fn, d) +
          `$S.pos=p;${r}=${this.const(node.f)}(${t}).step($S);if(${r}===F){${fail}}p=$S.pos;`
        )
      }
      case "Taken": {
        if (node.encoding !== undefined && !this.native(node.encoding)) return this.delegate(p, used, out, fail, fn)
        const st = this.v(fn)
        const body = `${st}=p;` + this.gen(node.self, false, null, fail, fn, d)
        if (out === null && node.encoding === undefined) return body
        if (node.encoding === undefined) {
          return (
            body +
            set(this.kind === 0 ? `I.slice(${st},p)` : this.kind === 1 ? `I.subarray(${st},p)` : `$S.slice(${st},p)`)
          )
        }
        const t = out ?? this.v(fn)
        const enc = this.const(node.encoding)
        return body + `${t}=R.textOf(${enc},${fastLimit(node.encoding)},$S,${st},p);if(${t}===F){${fail}}`
      }
      case "WithTaken":
      case "WithSpan": {
        const st = this.v(fn)
        const t = this.v(fn)
        const extra = Predicate.isTagged(node, "WithSpan") ? `{start:${st},end:p}` : `$S.slice(${st},p)`
        return `${st}=p;` + this.gen(node.self, true, t, fail, fn, d) + set(`[${t},${extra}]`)
      }
      case "Span": {
        const st = this.v(fn)
        return `${st}=p;` + this.gen(node.self, false, null, fail, fn, d) + set(`{start:${st},end:p}`)
      }
      case "Mode": {
        const ok = this.label()
        const bad = this.label()
        return (
          `${ok}:{${bad}:{${this.gen(node.self, used, out, `break ${bad};`, fn, d)}break ${ok};}` +
          `if($S.mode===${JSON.stringify(node.from)})$S.mode=${JSON.stringify(node.to)};${fail}}`
        )
      }
      case "Context":
      case "Expected":
      case "MapError":
      case "OrFail":
      case "Trace":
      case "Syntax":
      case "RetryAfter":
        return this.gen(node.self, used, out, fail, fn, d)
      case "ResumeAfter": {
        if (!used) return this.gen(node.self, false, null, fail, fn, d)
        const t = this.v(fn)
        return this.gen(node.self, true, t, fail, fn, d) + set(`R.some(${t})`)
      }
      case "Opt":
      case "OrElseSucceed": {
        const st = this.v(fn)
        const ok = this.label()
        const bad = this.label()
        const t = out === null ? null : this.v(fn)
        const some = Predicate.isTagged(node, "Opt") ? `R.some(${t})` : `${t}`
        const orElse = Predicate.isTagged(node, "Opt") ? "R.none()" : `${this.const(node.value)}()`
        return (
          `${st}=p;${ok}:{${bad}:{${this.gen(node.self, used, t, `break ${bad};`, fn, d)}${set(some)}break ${ok};}` +
          `if($S.mode!=="Backtrack"){${fail}}p=${st};${set(orElse)}}`
        )
      }
      case "Peek": {
        const st = this.v(fn)
        return `${st}=p;${this.gen(node.self, used, out, fail, fn, d)}p=${st};`
      }
      case "Not": {
        const st = this.v(fn)
        const ok = this.label()
        const bad = this.label()
        return (
          `${st}=p;${ok}:{${bad}:{${this.gen(node.self, false, null, `break ${bad};`, fn, d)}p=${st};${BT}${fail}}` +
          `if($S.mode!=="Backtrack"){${fail}}p=${st};}${set("void 0")}`
        )
      }
      case "Seq":
        return this.seq(node, used, out, fail, fn, d)
      case "Struct": {
        if (out === null) return node.parsers.map((q) => this.gen(q, false, null, fail, fn, d)).join("")
        const vars = node.parsers.map(() => this.v(fn))
        const code = node.parsers.map((q, i) => this.gen(q, true, vars[i], fail, fn, d)).join("")
        if (node.keys.includes("__proto__")) {
          return code + `${out}={};` + node.keys.map((k, i) => `${out}[${JSON.stringify(k)}]=${vars[i]};`).join("")
        }
        return code + `${out}={${node.keys.map((k, i) => `${JSON.stringify(k)}:${vars[i]}`).join(",")}};`
      }
      case "ZipWith": {
        if (out === null)
          return this.gen(node.self, false, null, fail, fn, d) + this.gen(node.that, false, null, fail, fn, d)
        const x = this.v(fn)
        const y = this.v(fn)
        return (
          this.gen(node.self, true, x, fail, fn, d) +
          this.gen(node.that, true, y, fail, fn, d) +
          `${out}=${this.const(node.f)}(${x},${y});`
        )
      }
      case "Alt":
        return this.alt(node, used, out, fail, fn, d)
      case "Dispatch":
        return this.dispatch(p, node, used, out, fail, fn, d)
      case "Repeat":
      case "Fold":
        return this.repeat(node, used, out, fail, fn, d)
      case "Separated":
        return this.separated(node, used, out, fail, fn, d)
      default:
        return this.delegate(p, used, out, fail, fn)
    }
  }

  /**
   * `Ascii.float` and `Text.float` (`map(floatText, toFloat)`): numbers in
   * decimal notation are matched and converted in one pass by
   * `scanFloatString` or `scanFloatBytes`, without slicing the input; the
   * rest (`nan`, `inf`, failures before a digit) runs the parser. Returns
   * `undefined` when this does not apply.
   */
  private float(node: NodeOf<"Map">, out: string, fail: string, fn: Fn, d: number): string | undefined {
    if (!floatTexts.has(node.self) || this.kind === 2) return undefined
    if (!scansFloat(node.self, (enc) => this.native(enc))) return undefined
    const t = this.v(fn)
    const scan = this.const(floatScan)
    // Near the end of a partial input, the parser may have to report `Incomplete`
    const near = this.resumable ? `||$S.partial&&${scan}.read+${Margin}>E` : ""
    return (
      `${out}=${this.kind === 0 ? "R.scanFloatString" : "R.scanFloatBytes"}(I,p,E);` +
      `if(${out}===void 0${near}){${this.gen(node.self, true, t, fail, fn, d)}${out}=${this.const(toFloat)}(${t})}` +
      `else if(${out}===F){${BT}${fail}}else p=${scan}.end;`
    )
  }

  seq(node: NodeOf<"Seq">, used: boolean, out: string | null, fail: string, fn: Fn, d: number): string {
    const output = node.output
    if (out === null || !used) return node.parsers.map((q) => this.gen(q, false, null, fail, fn, d)).join("")
    if (Predicate.isNumber(output)) {
      return node.parsers.map((q, i) => this.gen(q, i === output, i === output ? out : null, fail, fn, d)).join("")
    }
    const keep = (i: number) => output === "tuple" || output.includes(i)
    const vars = node.parsers.map((_, i) => (keep(i) ? this.v(fn) : null))
    const code = node.parsers.map((q, i) => this.gen(q, keep(i), vars[i], fail, fn, d)).join("")
    return code + `${out}=[${vars.filter((v) => v !== null).join(",")}];`
  }

  /** A test that the unit `u` may start `first` (false for -1, the end of the input). */
  private startTest(first: First, u: string): string {
    const runs = runsOf(first.units)
    const small = rangeTest(runs, u)
    const low = small ?? `${this.const(first.units)}[${u}]===1`
    if (!first.high) return small !== undefined ? `(${low})` : `(${u}<${TableSize}&&${low})`
    return `(${u}>=${TableSize}||${low})`
  }

  alt(node: NodeOf<"Alt">, used: boolean, out: string | null, fail: string, fn: Fn, d: number): string {
    const parsers = node.parsers
    if (Arr.isReadonlyArrayEmpty(parsers)) return `${BT}${fail}`
    if (parsers.length === 1) return this.gen(parsers[0], used, out, fail, fn, d)
    const firsts = this.kind === 2 ? undefined : parsers.map((q) => this.closure.firsts.of(q))
    const prune = firsts !== undefined && planAlt(firsts) !== undefined
    const st = this.v(fn)
    const u = prune ? this.v(fn) : ""
    const done = this.label()
    // Near the end of a partial input, no branch is skipped: it may be incomplete rather than fail
    const read = this.resumable ? `$S.partial&&p+${Margin}>E?-2:p<E?${this.unit("p")}:-1` : `p<E?${this.unit("p")}:-1`
    let code = `${st}=p;${prune ? `${u}=${read};` : ""}${done}:{`
    parsers.forEach((q, i) => {
      const bad = this.label()
      const branch =
        `${bad}:{${this.gen(q, used, out, `break ${bad};`, fn, d)}break ${done};}` +
        `if($S.mode!=="Backtrack"){${fail}}p=${st};`
      const f = firsts?.[i]
      code +=
        prune && f !== undefined && f.mode === Strict
          ? `if(${this.resumable ? `${u}===-2||` : ""}${this.startTest(f, u)}){${branch}}`
          : branch
    })
    return code + `${BT}${fail}}`
  }

  dispatch(
    p: ParserLike,
    node: NodeOf<"Dispatch">,
    used: boolean,
    out: string | null,
    fail: string,
    fn: Fn,
    d: number
  ): string {
    const choose = this.const(node.choose)
    if (node.cases === undefined) {
      // The general path: run the selector, choose, then run the case's step
      this.closure.note(p, node, "the parser returned by the function of cases runs interpreted")
      const st = this.v(fn)
      const k = this.v(fn)
      const q = this.v(fn)
      const r = out ?? this.v(fn)
      return (
        `${st}=p;${this.gen(node.selector, true, k, fail, fn, d)}${q}=${choose}(${k});` +
        `if(${q}===void 0){p=${st};${BT}${fail}}$S.pos=p;${r}=${q}.step($S);` +
        `if(${r}===F){${fail}}p=$S.pos;`
      )
    }
    // The cases are known: number them, and run the chosen one inline
    const cases = new Map<ParserLike, number>()
    for (const key of Reflect.ownKeys(node.cases)) {
      const q = node.cases[key as any]
      if (!cases.has(q)) cases.set(q, cases.size)
    }
    if (node.otherwise !== undefined && !cases.has(node.otherwise)) cases.set(node.otherwise, cases.size)
    const index = this.const(cases)
    // `inline`: the cases' code goes here; otherwise (a fallback next to the
    // switch on units below, which inlines them already) they are called as rules
    const general = (inline: boolean): string => {
      const st = this.v(fn)
      const k = this.v(fn)
      const q = this.v(fn)
      const sw = this.label()
      let code =
        `${st}=p;${this.gen(node.selector, true, k, fail, fn, d)}${q}=${choose}(${k});` +
        `if(${q}===void 0){p=${st};${BT}${fail}}${sw}:switch(${index}.get(${q})){`
      for (const [c, i] of cases) {
        const body = inline ? this.gen(c, used, out, fail, fn, d) : this.call(this.rule(c, used), out, fail)
        code += `case ${i}:{${body}break ${sw};}`
      }
      // Unreachable unless the record of cases changed after `dispatch` read it
      const r = out ?? this.v(fn)
      return code + `default:{$S.pos=p;${r}=${q}.step($S);if(${r}===F){${fail}}p=$S.pos;}}`
    }
    let sel = nodeOf(node.selector)
    const peek = Predicate.isTagged(sel, "Peek")
    if (peek) sel = nodeOf((sel as NodeOf<"Peek">).self)
    if (!Predicate.isTagged(sel, "Any") || !this.native(sel.encoding)) return general(true)
    const enc = sel.encoding
    const r = enc === undefined ? undefined : this.reader(enc)
    const limit = r === undefined ? (this.kind === 0 ? 0xd800 : TableSize) : Math.min(r.fast, 0xd800)
    const size = Math.min(limit, TableSize)
    if (size === 0) return general(true)
    // Group the units by the case they select
    const groups = new Map<ParserLike, Array<number>>()
    for (let unit = 0; unit < size; unit++) {
      const q = node.choose(enc === undefined && this.kind === 1 ? unit : charOf(unit))
      if (q === undefined) continue
      let g = groups.get(q)
      if (g === undefined) groups.set(q, (g = []))
      g.push(unit)
    }
    const u = this.v(fn)
    const sw = this.label()
    // A unit cut short by the end of the input takes the general path
    const read = r === undefined ? `p<E?${this.unit("p")}:-1` : `${r.guard("p")}?${r.unit("p")}:p<E?${size}:-1`
    // Near the end of a partial input, the general path handles incomplete units
    const near = this.resumable ? `$S.partial&&p+${Margin}>E?${size}:` : ""
    let code = `${u}=${near}${read};${sw}:switch(${u}){`
    for (const [q, units] of groups) {
      code +=
        units.map((x) => `case ${x}:`).join("") +
        `{${peek ? "" : `p+=${r?.width ?? 1};`}${this.gen(q, used, out, fail, fn, d)}break ${sw};}`
    }
    code += `case -1:{${BT}${fail}}default:{if(${u}<${size}){${BT}${fail}}${general(false)}}}`
    return code
  }

  repeat(
    node: NodeOf<"Repeat"> | NodeOf<"Fold">,
    used: boolean,
    out: string | null,
    fail: string,
    fn: Fn,
    d: number,
    collect?: Collect
  ): string {
    const { max, min } = node
    const loop = this.label()
    const bad = this.label()
    const n = this.v(fn)
    const st = this.v(fn)
    const isFold = Predicate.isTagged(node, "Fold")
    const cond = isFold ? (node as NodeOf<"Fold">).while : undefined
    const keep = out !== null && used && collect === undefined
    // `while` needs the accumulator even when the output is unused
    const tracked = keep || cond !== undefined
    const x = tracked ? this.v(fn) : null
    const acc = out !== null && keep ? out : this.v(fn)
    let init = collect?.init ?? ""
    let add = ""
    if (tracked) {
      if (isFold) {
        init = `${acc}=${this.const((node as NodeOf<"Fold">).init)}();`
        add = `${acc}=${this.const((node as NodeOf<"Fold">).f)}(${acc},${x});`
      } else {
        init = `${acc}=[];`
        add = `${acc}.push(${x});`
      }
    }
    const check = max === Infinity ? `if(p===${st}){$S.mode="Cut";${fail}}` : ""
    const bound = max === Infinity ? "" : `${n}<${max}`
    const r = this.resumable ? this.resumePoint(fn) : undefined
    const save =
      r === undefined
        ? ""
        : `if($S.mode==="Incomplete"&&$S.resume!==void 0)R.save($S,${r.key},${r.entry},{acc:${acc},count:${n},pos:${st}});`
    // With `collect` (never in resumable builds), the element adds itself once the loop check passed
    const element =
      collect === undefined
        ? `${this.gen(node.self, tracked, x, `break ${bad};`, fn, d)}${check}${add}`
        : collect.element(`break ${bad};`, check)
    const stop =
      cond === undefined ? "" : `if(${min > 0 ? `${n}>=${min}&&` : ""}!${this.const(cond)}(${acc}))break ${loop};`
    const body =
      `${loop}:for(;${bound};${n}++){${stop}${st}=p;` +
      `${bad}:{${element}continue ${loop};}` +
      `${save}if($S.mode!=="Backtrack"${min > 0 ? `||${n}<${min}` : ""}){${fail}}p=${st};break ${loop};}`
    if (r === undefined) return `${init}${n}=0;${body}${collect?.finish ?? ""}`
    return r.wrap(acc, `${acc}=cp.acc;${n}=cp.count;p=cp.pos;`, `${init}${n}=0;`, body)
  }

  /**
   * In a resumable build, a repetition entered at `entry` may restart from a
   * checkpoint (`restore`, with the checkpoint in `cp`), or return the result
   * of a `Done` one; a resumed repetition records its result when it ends.
   */
  private resumePoint(fn: Fn) {
    const key = this.const(new Key())
    const entry = this.v(fn)
    const resumed = this.v(fn)
    const done = this.label()
    return {
      key,
      entry,
      resumed,
      wrap: (value: string, restore: string, fresh: string, body: string) =>
        `${entry}=p;${resumed}=false;${done}:{if($S.resume!==void 0){const cp=R.take($S,${key},p);` +
        `if(cp instanceof R.Done){p=cp.pos;${value}=cp.value;break ${done};}` +
        `if(cp!==void 0){${restore}${resumed}=true;}}if(!${resumed}){${fresh}}${body}` +
        `if(${resumed})R.done($S,${key},${entry},${value},p);}`
    }
  }

  separated(
    node: NodeOf<"Separated">,
    used: boolean,
    out: string | null,
    fail: string,
    fn: Fn,
    d: number,
    collect?: Collect
  ): string {
    const { max, min } = node
    const keep = out !== null && used && collect === undefined
    if (max === 0) return collect !== undefined ? collect.init + collect.finish : keep ? `${out}=[];` : ""
    const x = keep ? this.v(fn) : null
    const acc = out !== null && keep ? out : this.v(fn)
    const n = this.v(fn)
    const st = this.v(fn)
    const done = this.label()
    const loop = this.label()
    const push = keep ? `${acc}.push(${x});` : ""
    const r = this.resumable ? this.resumePoint(fn) : undefined
    const save =
      r === undefined
        ? ""
        : `if($S.mode==="Incomplete"&&$S.resume!==void 0)R.save($S,${r.key},${r.entry},{acc:${acc},count:${n},pos:${st}});`
    // Runs `body`; on its failure, stops the repetition (or fails if `fatal`)
    const attempt = (body: (fail: string) => string, success: string, fatal: string, checkpoint: string) => {
      const ok = this.label()
      const bad = this.label()
      return (
        `${ok}:{${bad}:{${body(`break ${bad};`)}${success}break ${ok};}` +
        `${checkpoint}if($S.mode!=="Backtrack"${fatal}){${fail}}p=${st};break ${done};}`
      )
    }
    const self = (f: string) =>
      collect === undefined ? this.gen(node.self, keep, x, f, fn, d) : collect.element(f, "")
    const sep = (f: string) => this.gen(node.separator, false, null, f, fn, d)
    const check = max === Infinity ? `if(p===${st}){$S.mode="Cut";${fail}}` : ""
    const first =
      `${collect?.init ?? (keep ? `${acc}=[];` : "")}${n}=0;${st}=p;` +
      attempt(self, `${push}${n}++;`, min > 0 ? "||true" : "", "")
    const rest =
      `${loop}:while(${max === Infinity ? "true" : `${n}<${max}`}){${st}=p;` +
      attempt(sep, "", `||${n}<${min}`, save) +
      check +
      attempt(self, `${push}${n}++;continue ${loop};`, `||${n}<${min}`, save) +
      `}`
    if (r === undefined) return `${done}:{${first}${rest}}${collect?.finish ?? ""}`
    // `done` ends the repetition; the checkpoint wrapper records the result after it
    return r.wrap(acc, `${acc}=cp.acc;${n}=cp.count;p=cp.pos;`, "", `${done}:{if(!${r.resumed}){${first}}${rest}}`)
  }

  /**
   * `map(self, Object.fromEntries)`, where `buildsEntries(self)`: builds the
   * object directly, assigning each entry as it is parsed (see
   * `internal/entries.ts`), without the pairs and their array. `cut`,
   * `preceded`, `terminated` and diagnostics around the repetition are
   * compiled as usual around it.
   */
  private entries(p: ParserLike, out: string, fail: string, fn: Fn, d: number): string {
    const node = nodeOf(p)
    switch (node._tag) {
      case "Mode": {
        const ok = this.label()
        const bad = this.label()
        return (
          `${ok}:{${bad}:{${this.entries(node.self, out, `break ${bad};`, fn, d)}break ${ok};}` +
          `if($S.mode===${JSON.stringify(node.from)})$S.mode=${JSON.stringify(node.to)};${fail}}`
        )
      }
      case "Seq": {
        const i = node.output as number
        return node.parsers
          .map((q, j) => (j === i ? this.entries(q, out, fail, fn, d) : this.gen(q, false, null, fail, fn, d)))
          .join("")
      }
      case "Repeat":
      case "Separated": {
        const pair = pairOf(node.self)
        if (pair === undefined) {
          // Not reached (`buildsEntries` found the pair): build the pairs, then the object
          const t = this.v(fn)
          return this.gen(p, true, t, fail, fn, d) + `${out}=${this.const(fromEntries)}(${t});`
        }
        const deferred = this.v(fn)
        const key = this.v(fn)
        const value = this.v(fn)
        const collect: Collect = {
          init: `${out}={};${deferred}=void 0;`,
          element: (f, check) =>
            pair.parsers
              .map((q, j) =>
                this.gen(
                  q,
                  j === pair.key || j === pair.value,
                  j === pair.key ? key : j === pair.value ? value : null,
                  f,
                  fn,
                  d
                )
              )
              .join("") +
            check +
            `if(${deferred}===void 0&&R.isPlainKey(${key}))${out}[${key}]=${value};` +
            `else ${deferred}=R.addEntry(${out},${deferred},${key},${value});`,
          finish: `if(${deferred}!==void 0)R.flushEntries(${out},${deferred});`
        }
        return Predicate.isTagged(node, "Repeat")
          ? this.repeat(node, true, out, fail, fn, d, collect)
          : this.separated(node, true, out, fail, fn, d, collect)
      }
      default:
        return this.entries((node as { readonly self: ParserLike }).self, out, fail, fn, d)
    }
  }

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  /** An expression: is the unit `c`, known to be below `size` (at most `TableSize`), accepted? */
  private member(accept: Uint8Array, c: string, size: number = TableSize): string {
    return tableTest(accept, c, size) ?? `${this.const(accept)}[${c}]===1`
  }

  /** An expression: is the code point `c` (at least `TableSize`) accepted? */
  private memberHigh(set: CharSet, negate: boolean, c: string): string {
    if (set.ranges !== undefined && !set.ranges.some(([, b]) => b >= TableSize)) return negate ? "true" : "false"
    return `${this.const(set.test)}(${c})!==${negate}`
  }

  /**
   * An expression: does a `Text` set accept the unit `c`, known to be below
   * `r.fast`? Code points from `TableSize` up are tested by the set's
   * function, unless its ranges show they are all rejected.
   */
  private textAccepts(r: Reader, cs: CharSet, accept: Uint8Array, negate: boolean, c: string): string {
    if (r.fast <= TableSize) return `(${this.member(accept, c, r.fast)})`
    const member = this.member(accept, c)
    if (reachesAbove(cs, TableSize)) return `(${c}<${TableSize}?${member}:${this.const(cs.test)}(${c})!==${negate})`
    return negate ? `(${c}>=${TableSize}||${member})` : `(${c}<${TableSize}&&${member})`
  }

  /**
   * An expression: does a `Text` set reject `c`, a code point that `decode`
   * returned? The built-in encodings only decode code points from `r.fast`
   * up there.
   */
  private textRejectsDecoded(enc: Encoding<any>, r: Reader, cs: CharSet, negate: boolean, c: string): string {
    if (r.fast > 0 && builtinEncodings.has(enc) && !reachesAbove(cs, r.fast)) return String(!negate)
    return `${this.const(cs.test)}(${c})===${negate}`
  }

  token(
    node: NodeOf<"Any" | "Literal" | "OneOf" | "TakeWhile">,
    out: string | null,
    fail: string,
    fn: Fn
  ): string | undefined {
    const set = (value: string) => (out === null ? "" : `${out}=${value};`)
    const enc = node.encoding
    const kind = this.kind as 0 | 1
    const failBT = `{${BT}${fail}}`
    switch (node._tag) {
      case "Any": {
        if (enc === undefined) {
          if (kind === 1) return `if(p>=E)${failBT}${set("I[p]")}p++;`
          const c = this.v(fn)
          return (
            `if(p>=E)${failBT}${c}=I.charCodeAt(p);` +
            `if(${c}>=55296&&${c}<=56319&&p+1<I.length&&(I.charCodeAt(p+1)&64512)===56320){${set("I.slice(p,p+2)")}p+=2}` +
            `else{${set("I[p]")}p++}`
          )
        }
        const r = this.reader(enc)
        const c = this.v(fn)
        const dec = `${this.const(enc.decode)}(I,p,E)`
        return (
          `if(p>=E)${failBT}` +
          (r.fast > 0
            ? `if(${r.guard("p")}&&(${c}=${r.unit("p")})<${r.fast}){${set(`R.charOf(${c})`)}p+=${r.width}}else`
            : "") +
          `{${c}=${dec};if(${c}<0)${failBT}${set(`R.charOf(${c})`)}p+=${this.const(enc.width)}(${c})}`
        )
      }
      case "Literal": {
        const lit = node.literal
        if (enc !== undefined) {
          if (node.caseless) return undefined
          const encoded = enc.encode(lit as string)
          return (
            this.literalUnits(Predicate.isString(encoded) ? unitsOf(encoded) : Array.from(encoded), false, fail) +
            set(this.lit(lit))
          )
        }
        const literalKind = Predicate.isString(lit) ? 0 : lit instanceof Uint8Array ? 1 : 2
        if (kind === 0 && literalKind !== 0) return undefined
        if (literalKind === 2) return undefined
        const codes =
          kind === 0
            ? unitsOf(lit as string)
            : Array.from(literalKind === 0 ? new TextEncoder().encode(lit as string) : (lit as Uint8Array))
        const len = codes.length
        const value =
          !node.caseless && literalKind === kind
            ? this.lit(lit)
            : kind === 0
              ? `I.slice(p-${len},p)`
              : `I.subarray(p-${len},p)`
        return this.literalUnits(codes, node.caseless, fail) + set(value)
      }
      case "OneOf": {
        const negate = node.negate
        const cs = enc === undefined ? tokenSet(node.set, kind) : textSet(node.set)
        const accept = acceptTable(cs, negate)
        const c = this.v(fn)
        const value = (len: string) => (this.kind === 0 ? `I.slice(p,p+${len})` : `I[p]`)
        if (enc === undefined) {
          if (kind === 1)
            return `if(p>=E)${failBT}${c}=I[p];if(!(${this.member(accept, c)}))${failBT}${set("I[p]")}p++;`
          const cp = this.v(fn)
          if (!negate && this.memberHigh(cs, negate, cp) === "false") {
            return `if(p>=E)${failBT}${c}=I.charCodeAt(p);if(${c}>=${TableSize}||!(${this.member(accept, c)}))${failBT}${set("I[p]")}p++;`
          }
          return (
            `if(p>=E)${failBT}${c}=I.charCodeAt(p);` +
            `if(${c}<${TableSize}){if(!(${this.member(accept, c)}))${failBT}${set("I[p]")}p++}` +
            `else{${cp}=${c};if(${c}>=55296&&${c}<=56319&&p+1<I.length){const d=I.charCodeAt(p+1);` +
            `if((d&64512)===56320)${cp}=((${c}-55296)<<10)+(d-56320)+65536}` +
            `if(!(${this.memberHigh(cs, negate, cp)}))${failBT}` +
            `if(${cp}>65535){${set(value("2"))}p+=2}else{${set("I[p]")}p++}}`
          )
        }
        const r = this.reader(enc)
        return (
          `if(p>=E)${failBT}` +
          (r.fast > 0
            ? `if(${r.guard("p")}&&(${c}=${r.unit("p")})<${r.fast}){if(!${this.textAccepts(r, cs, accept, negate, c)})${failBT}${set(`R.charOf(${c})`)}p+=${r.width}}else`
            : "") +
          `{${c}=${this.const(enc.decode)}(I,p,E);if(${c}<0||${this.textRejectsDecoded(enc, r, cs, negate, c)})${failBT}` +
          `${set(`R.charOf(${c})`)}p+=${this.const(enc.width)}(${c})}`
        )
      }
      case "TakeWhile":
        return this.takeWhile(node, out, fail, fn)
    }
  }

  /** Matches literal units at `p`, advancing past them. */
  private literalUnits(codes: ReadonlyArray<number>, caseless: boolean, fail: string): string {
    const len = codes.length
    if (len === 0) return ""
    const test = (c: number, i: number) => {
      const at = this.unit(i === 0 ? "p" : `p+${i}`)
      if (caseless && isLetter(c)) return `(${at}|32)===${lowerAscii(c)}`
      return `${at}===${c}`
    }
    if (len <= 8) {
      // Reading past the end gives NaN or undefined, which matches nothing
      return `if(!(${codes.map(test).join("&&")})){${BT}${fail}}p+=${len};`
    }
    if (this.kind === 0 && !caseless) {
      const str = String.fromCharCode(...codes)
      return `if(!I.startsWith(${JSON.stringify(str)},p)){${BT}${fail}}p+=${len};`
    }
    const expect = this.const(Uint8Array.from(caseless ? codes.map(lowerAscii) : codes))
    const lower = caseless ? `${this.const(lowerAscii)}` : ""
    return `if(E-p<${len}){${BT}${fail}}for(let i=0;i<${len};i++)if(${lower}(${this.unit("p+i")})!==${expect}[i]){${BT}${fail}}p+=${len};`
  }

  private takeWhile(node: NodeOf<"TakeWhile">, out: string | null, fail: string, fn: Fn): string {
    const enc = node.encoding
    const { max, min, negate } = node
    const kind = this.kind as 0 | 1
    const cs = enc === undefined ? tokenSet(node.set, kind) : textSet(node.set)
    const accept = acceptTable(cs, negate)
    const st = this.v(fn)
    const c = this.v(fn)
    const n = this.v(fn)
    const loop = this.label()
    const counted = max !== Infinity || min > 1
    const count = counted ? `${n}++;` : ""
    const bound = max !== Infinity ? `&&${n}<${max}` : ""
    const slice =
      enc !== undefined ? `${this.const(enc.text)}(I,${st},p)` : kind === 0 ? `I.slice(${st},p)` : `I.subarray(${st},p)`
    const finish =
      (min > 0 ? `if(${counted ? n : `p-${st}`}<${min}){${BT}${fail}}` : "") + (out === null ? "" : `${out}=${slice};`)
    const head = `${st}=p;${counted ? `${n}=0;` : ""}${loop}:while(p<E${bound}){${c}=${this.unit("p")};`
    const member = this.member(accept, c)
    if (kind === 1 && (enc === undefined || fastLimit(enc) >= TableSize)) {
      // Bytes, one token each
      return `${head}if(!(${member}))break;p++;${count}}${finish}`
    }
    if (enc !== undefined) {
      // Text: inline the encoding's single-unit code points, decode the rest
      const r = this.reader(enc)
      // The loop condition already checks a unit of width 1
      const guard = r.width === 1 ? "" : `${r.guard("p")}&&`
      return (
        `${st}=p;${counted ? `${n}=0;` : ""}${loop}:while(p<E${bound}){` +
        (r.fast > 0
          ? `if(${guard}(${c}=${r.unit("p")})<${r.fast}){if(!${this.textAccepts(r, cs, accept, negate, c)})break ${loop};p+=${r.width}}else`
          : "") +
        `{${c}=${this.const(enc.decode)}(I,p,E);if(${c}<0||${this.textRejectsDecoded(enc, r, cs, negate, c)})break ${loop};` +
        `p+=${this.const(enc.width)}(${c})}${count}}${finish}`
      )
    }
    const fast = 0xd800
    const small = TableSize
    const highTest = (v: string) => this.memberHigh(cs, negate, v)
    // Token on strings: code points, with lenient surrogates
    const cp = this.v(fn)
    const never = highTest(c) === "false"
    // Every code point from `TableSize` up is accepted: without a count,
    // surrogate pairs can be skipped a unit at a time
    const always = highTest(c) === "true"
    const rest =
      never && !negate
        ? `break;`
        : always && !counted
          ? `p++;`
          : `if(${c}<${fast}||${c}>56319){if(!(${highTest(c)}))break ${loop};p++}` +
            `else{${cp}=${c};if(p+1<I.length){const d=I.charCodeAt(p+1);if((d&64512)===56320)${cp}=((${c}-55296)<<10)+(d-56320)+65536}` +
            `if(!(${highTest(cp)}))break ${loop};p+=${cp}>65535?2:1}`
    return `${head}if(${c}<${small}){if(!(${member}))break;p++}else ${rest}${count}}${finish}`
  }

  /**
   * `escaped`. In a resumable build it keeps the closure compiler's
   * checkpoints: where the next segment starts and, unless raw, the text
   * so far, saved when a segment or an escape runs out of input.
   */
  escaped(p: ParserLike, node: NodeOf<"Escaped">, out: string | null, fail: string, fn: Fn, d: number): string {
    const enc = node.encoding
    const ctrl = node.control
    const rd = enc === undefined ? undefined : this.reader(enc)
    if (rd !== undefined && !(ctrl < rd.fast)) return this.delegate(p, !node.raw, out, fail, fn)
    const raw = node.raw
    const r = this.resumable ? this.resumePoint(fn) : undefined
    const acc = raw ? null : (out ?? this.v(fn))
    const x = raw ? null : this.v(fn)
    const b = this.v(fn)
    const st = r?.entry ?? this.v(fn)
    const okv = this.v(fn)
    const loop = this.label()
    const bad = this.label()
    /** Saves the checkpoint of a segment starting at `pos`, when the parse ran out of input. */
    const save = (pos: string) =>
      r === undefined
        ? ""
        : `if($S.mode==="Incomplete"&&$S.resume!==void 0)R.save($S,${r.key},${r.entry},${raw ? pos : `{out:${acc},pos:${pos}}`});`
    const normal = this.gen(node.normal, !raw, x, `break ${bad};`, fn, d)
    const escape = this.gen(node.escape, !raw, x, `${save(b)}${fail}`, fn, d)
    const onNormal = raw
      ? `if(p===${b}){$S.mode="Cut";${fail}}continue ${loop};`
      : `if(p!==${b}){${acc}+=${x};continue ${loop}}`
    const slice =
      enc !== undefined
        ? `${this.const(enc.text)}(I,${st},p)`
        : this.kind === 0
          ? `I.slice(${st},p)`
          : `I.subarray(${st},p)`
    const ctrlTest =
      rd === undefined ? `p<E&&${this.unit("p")}===${ctrl}` : `${rd.guard("p")}&&${rd.unit("p")}===${ctrl}`
    // In a resumable build, running out of a partial input (not stopping
    // before a non-control character) leaves the text incomplete
    const stop = r === undefined ? loop : this.label()
    const loopCode =
      `${loop}:while(p<E){${b}=p;${okv}=false;` +
      `${bad}:{${normal}${okv}=true;}` +
      `if(${okv}){${onNormal}}else{if($S.mode!=="Backtrack"){${save(b)}${fail}}p=${b}}` +
      `if(${ctrlTest}){p+=${rd?.width ?? 1};${escape}${raw ? "" : `${acc}+=${x};`}}else break ${stop};}`
    const body =
      r === undefined ? loopCode : `${stop}:{${loopCode}if($S.partial){$S.mode="Incomplete";${save("p")}${fail}}}`
    if (r === undefined) {
      return `${raw ? `${st}=p;` : `${acc}="";`}${body}${raw && out !== null ? `${out}=${slice};` : ""}`
    }
    // `acc` is set unless raw
    if (acc !== null) return r.wrap(acc, `${acc}=cp.out;p=cp.pos;`, `${acc}="";`, body)
    const value = out ?? this.v(fn)
    return r.wrap(value, "p=cp;", "", `${body}${value}=${out === null ? "void 0" : slice};`)
  }
}

/** The UTF-16 code units of a string. */
const unitsOf = (s: string): Array<number> => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i))

/** The source of a compiled parser, with the values it reads as `C`. */
interface Generated {
  readonly source: string
  readonly constants: ReadonlyArray<unknown>
  readonly fallbacks: ReadonlyArray<Fallback>
}

/** Generates the source of a compiled parser, without building it. */
const generate = (root: ParserLike, kind: 0 | 1 | 2, resumable = false): Generated => {
  const e = new Emitter(root, kind, resumable)
  const main = e.rule(root, true)
  const source =
    `"use strict";let $I,$E,$S,P;${e.functions.join("\n")}\n` +
    `return function run(state){const sI=$I,sE=$E,sS=$S,sP=P;$I=state.input;$E=state.end;$S=state;` +
    `try{const v=${main}(state.pos);if(v!==F)state.pos=P;return v}finally{$I=sI;$E=sE;$S=sS;P=sP}}`
  return { source, constants: e.constants, fallbacks: e.fallbacks }
}

/** A root parser compiled with `new Function`, with its generated source. */
interface JitCompiled extends CompiledRoot {
  readonly source: string
}

/** Compiles a root parser for one input kind with `new Function`. */
const compileJit = (root: ParserLike, kind: 0 | 1 | 2, resumable = false): JitCompiled => {
  const { constants, fallbacks, source } = generate(root, kind, resumable)
  const run = globalThis.Function("C", "F", "R", source)(constants, Fail, runtime) as Step
  // Generated code reads past `end` expecting nothing to match there, which
  // holds when `end` is the input's length, as it is in the runners.
  let closure: Step | undefined
  const step: Step = (state) =>
    state.end === state.input.length
      ? run(state)
      : (closure ??= createClosureCompiler(kind, resumable).compile(root, true))(state)
  return { step, fallbacks, source }
}

/**
 * The JIT as a backend: generated code where `new Function` is allowed,
 * otherwise (or if generating fails) the closure compiler.
 */
export const backend: Backend = {
  build: (p, kind, resumable) => {
    if (!jitSupported()) return closureBackend.build(p, kind, resumable)
    return Result.match(
      Result.try(() => compileJit(p, kind, resumable)),
      {
        onSuccess: ({ fallbacks, source, step }) => ({
          backend: "jit" as const,
          step,
          fallbacks,
          error: undefined,
          source
        }),
        // Fall back to the closure compiler, remembering why
        onFailure: (error) => ({ ...closureBackend.build(p, kind, resumable), jitError: error })
      }
    )
  }
}
