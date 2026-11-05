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
import { Defer, NodeId, nodeOf, scansFloat } from "../node.js"
import { floatScan, floatTexts, scanFloatBytes, scanFloatString, toFloat } from "../numbers.js"
import { compileAny } from "../tokens.js"
import { Key } from "../key.js"
import * as Resume from "../resume.js"
import * as Stack from "../stack.js"
import {
  ShortText,
  charOf,
  fastLimit,
  latin1,
  string,
  textIn,
  utf16be,
  utf16le,
  utf8,
  utf8Text,
  validate
} from "../text.js"
import type { ClosureCompiler, CompiledRoot, Fallback, Step } from "./closure.js"
import { backend as closureBackend, createClosureCompiler } from "./closure.js"
import { buildsEntries, pairOf } from "./entries.js"
import { countRefs, isLeaf, isLetter, isSmall, lowerAscii, selectorOf } from "./graph.js"
import type { Backend } from "./registry.js"
import type { First } from "./first.js"
import { planAlt, Strict } from "./first.js"
import type { CharSet } from "./sets.js"
import { acceptTable, kindOfEncoding, reachesAbove, TableSize, textSet, tokenSet } from "./sets.js"
import { nextStop, SearchHead, StopCache, stopChars } from "./search.js"

/** Helpers available to generated code as `R`. */
const runtime = {
  StopCache,
  nextStop,
  take: Resume.take,
  save: Resume.save,
  Done: Resume.Done,
  /** Records the result of a resumed repetition (see `Resume.done`). */
  done: (state: State<any>, key: Key, entry: number, value: unknown, pos: number): void =>
    Resume.save(state, key, entry, new Resume.Done(value, pos)),
  isStackOverflow: Stack.isStackOverflow,
  tooDeep: Stack.tooDeep,
  some: Option.some,
  none: Option.none,
  charOf,
  scanFloatString,
  scanFloatBytes,
  isPlainKey,
  addEntry,
  flushEntries,
  /** `Text.taken`: the text of `[start, end)`, or `Fail` if it is malformed. */
  textOf: (enc: Encoding<any>, fast: number, s: State<any>, start: number, end: number): string | typeof Fail => {
    const input = s.input
    let i = start
    // SAFETY: input kind 0 is a string input
    if (s.inputKind === 0) while (i < end && (input as string).charCodeAt(i) < fast) i++
    // SAFETY: `Text` parsers are compiled natively, and so call this, on string (0) and byte (1) inputs only
    else while (i < end && (input as Uint8Array)[i] < fast) i++
    if (i < end && validate(enc, s, i, end) < 0) {
      s.mode = "Backtrack"
      return Fail
    }
    return textIn(enc, s, start, end)
  },
  utf8Text
}

let checked: FunctionConstructor | undefined
let supported = false

/**
 * Whether `new Function` works here (it doesn't under a Content Security
 * Policy). Checked once, and again if `globalThis.Function` is replaced.
 */
export const jitSupported = (): boolean => {
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
  /** The variable holding the result. */
  readonly value: string
  /** In a resumable build: more fields of a checkpoint (`name:variable,`), and the code restoring them from `cp`. */
  readonly saved: string
  readonly restore: string
}

class Emitter {
  readonly constants: Array<unknown> = []
  private readonly constantIndex = new Map<unknown, number>()
  readonly functions: Array<string> = []
  private readonly rules = [new Map<ParserLike, string>(), new Map<ParserLike, string>()]
  private readonly refs: WeakMap<ParserLike, number>
  private readonly closure: ClosureCompiler
  private next = 0

  constructor(
    readonly root: ParserLike,
    readonly kind: 0 | 1 | 2,
    readonly resumable = false
  ) {
    this.closure = createClosureCompiler(kind, resumable)
    this.refs = countRefs(root)
  }

  get fallbacks(): ReadonlyArray<Fallback> {
    return this.closure.fallbacks
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

  /** The text of `[start, p)` in `enc`: UTF-8 decodes through the state's ASCII run (see `utf8Text`). */
  text(enc: Encoding<any>, start: string): string {
    const text = `${this.const(enc.text)}(I,${start},p)`
    // Short strings are built by hand, which no run helps
    return enc === utf8 ? `(p-${start}>${ShortText}?R.utf8Text($S,${start},p):${text})` : text
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
    if (!isLeaf(node) && (((this.refs.get(p) ?? 0) > 1 && !isSmall(p)) || depth > 32)) {
      return this.call(this.rule(p, used), out, fail)
    }
    return this.inline(p, used, out, fail, fn, depth)
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
          // `eof`'s own failure: `Incomplete`, needing one more unit
          (this.resumable ? `if($S.partial){$S.incomplete(1);${fail}}` : "") +
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
        // Streaming builds too: their checkpoints hold the object built so far
        if (node.f === fromEntries && out !== null && buildsEntries(node.self)) {
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
      case "FastPath": {
        // The fast path runs on the state; when it defers, the grammar runs from where it started
        const st = this.v(fn)
        const t = out ?? this.v(fn)
        const done = this.label()
        return (
          `${st}=p;$S.pos=p;${t}=${this.const(node.fast)}($S);` +
          `${done}:{if(${t}!==${this.const(Defer)}){p=$S.pos;break ${done}}p=${st};` +
          `${this.gen(node.self, used, out, fail, fn, d)}}`
        )
      }
      case "MapOrFail": {
        const t = this.v(fn)
        const r = out ?? this.v(fn)
        return this.gen(node.self, true, t, fail, fn, d) + `${r}=${this.const(node.f)}(${t});if(${r}===F){${BT}${fail}}`
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
      case "MapSpan": {
        if (!used) return this.gen(node.self, false, null, fail, fn, d)
        const st = this.v(fn)
        const t = this.v(fn)
        return `${st}=p;` + this.gen(node.self, true, t, fail, fn, d) + set(`${this.const(node.f)}(${t},${st},p)`)
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
      case "Quiet":
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
      case "SeqWith": {
        if (out === null) return node.parsers.map((q) => this.gen(q, false, null, fail, fn, d)).join("")
        const vars = node.parsers.map(() => this.v(fn))
        const code = node.parsers.map((q, i) => this.gen(q, true, vars[i], fail, fn, d)).join("")
        return code + `${out}=${this.const(node.f)}(${vars.join(",")});`
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
      case "Fold": {
        // A run of a character set whose characters are not kept is a `takeWhile` (#79)
        const run =
          out === null && Predicate.isTagged(node, "Repeat") ? this.repeatRun(p, node, fail, fn, d) : undefined
        return run ?? this.repeat(node, used, out, fail, fn, d)
      }
      case "Separated":
        return this.separated(node, used, out, fail, fn, d)
      case "Fixed": {
        // On bytes, read inline; at the end of the input, the step reports it
        if (this.kind !== 1) return this.delegate(p, used, out, fail, fn)
        const read = used ? `${out ?? this.v(fn)}=${this.const(node.read)}(I,p,$S);` : ""
        return `if(E-p>=${node.size}){${read}p+=${node.size}}else{${this.delegate(p, used, out, fail, fn)}}`
      }
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
      const q = node.cases[key]
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
    const { node: sel, peek } = selectorOf(node.selector)
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

  /**
   * A repetition whose elements are not kept, rewritten to scan a run of a
   * character set in one loop instead of one element at a time (#79):
   *
   * - `repeat(oneOf(S), range)` matches what `takeWhile(S, range)` matches,
   *   stopping, failing and reporting `Incomplete` where it does, so it
   *   compiles as that `takeWhile`, with the repetition's own step as the
   *   fallback near the end of a partial input.
   * - `repeat(alt(oneOf(S), ...rest))` with `min` at most 1 and no `max`
   *   matches what `repeat(alt(takeWhile(S, { min: 1 }), ...rest))` matches:
   *   a run of `S` is a run of one-character elements, and the counts that
   *   differ only matter for other ranges. The first branch is a synthetic
   *   `takeWhile` node; outside resumable builds, which never run its step.
   *
   * Returns `undefined` when neither applies.
   */
  private repeatRun(p: ParserLike, node: NodeOf<"Repeat">, fail: string, fn: Fn, d: number): string | undefined {
    if (this.kind === 2) return undefined
    const element = nodeOf(node.self)
    if (Predicate.isTagged(element, "OneOf") && this.native(element.encoding)) {
      const { encoding, negate, set } = element
      return this.leaf(
        p,
        { _tag: "TakeWhile", set, negate, encoding, min: node.min, max: node.max },
        false,
        null,
        fail,
        fn
      )
    }
    if (this.resumable || node.min > 1 || node.max !== Infinity || !Predicate.isTagged(element, "Alt")) return undefined
    const [first, ...rest] = element.parsers
    const head = first === undefined ? undefined : nodeOf(first)
    if (
      head === undefined ||
      !Predicate.isTagged(head, "OneOf") ||
      !this.native(head.encoding) ||
      Arr.isReadonlyArrayEmpty(rest)
    ) {
      return undefined
    }
    const run = synthetic(
      { _tag: "TakeWhile", set: head.set, negate: head.negate, encoding: head.encoding, min: 1, max: Infinity },
      node.self.step
    )
    const alt = synthetic({ _tag: "Alt", parsers: [run, ...rest] }, node.self.step)
    return this.repeat({ ...node, self: alt }, false, null, fail, fn, d)
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
    const cond = isFold ? node.while : undefined
    const keep = out !== null && used && collect === undefined
    // `while` needs the accumulator even when the output is unused
    const tracked = keep || cond !== undefined
    const x = tracked ? this.v(fn) : null
    const acc = out !== null && keep ? out : this.v(fn)
    let init = collect?.init ?? ""
    let add = ""
    if (tracked) {
      if (isFold) {
        init = `${acc}=${this.const(node.init)}();`
        add = `${acc}=${this.const(node.f)}(${acc},${x});`
      } else {
        init = `${acc}=[];`
        add = `${acc}.push(${x});`
      }
    }
    const check = max === Infinity ? `if(p===${st}){$S.mode="Cut";${fail}}` : ""
    const bound = max === Infinity ? "" : `${n}<${max}`
    const r = this.resumable ? this.resumePoint(fn) : undefined
    // A checkpoint holds the result so far: the accumulator, or what `collect` builds
    const held = collect?.value ?? acc
    const save =
      r === undefined
        ? ""
        : `if($S.mode==="Incomplete"&&$S.resume!==void 0)R.save($S,${r.key},${r.entry},{acc:${held},${collect?.saved ?? ""}count:${n},pos:${st}});`
    // With `collect`, the element adds itself once the loop check passed
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
    return r.wrap(
      held,
      `${held}=cp.acc;${collect?.restore ?? ""}${n}=cp.count;p=cp.pos;`,
      `${init}${n}=0;`,
      `${body}${collect?.finish ?? ""}`
    )
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
    // A checkpoint holds the result so far: the accumulator, or what `collect` builds
    const held = collect?.value ?? acc
    const save =
      r === undefined
        ? ""
        : `if($S.mode==="Incomplete"&&$S.resume!==void 0)R.save($S,${r.key},${r.entry},{acc:${held},${collect?.saved ?? ""}count:${n},pos:${st}});`
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
    return r.wrap(
      held,
      `${held}=cp.acc;${collect?.restore ?? ""}${n}=cp.count;p=cp.pos;`,
      "",
      `${done}:{if(!${r.resumed}){${first}}${rest}}${collect?.finish ?? ""}`
    )
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
    if (Predicate.isTagged(node, "Mode")) {
      const ok = this.label()
      const bad = this.label()
      return (
        `${ok}:{${bad}:{${this.entries(node.self, out, `break ${bad};`, fn, d)}break ${ok};}` +
        `if($S.mode===${JSON.stringify(node.from)})$S.mode=${JSON.stringify(node.to)};${fail}}`
      )
    }
    if (Predicate.isTagged(node, "Seq")) {
      // SAFETY: `buildsEntries` passes through a sequence only when it keeps one output, by index
      const i = node.output as number
      return node.parsers
        .map((q, j) => (j === i ? this.entries(q, out, fail, fn, d) : this.gen(q, false, null, fail, fn, d)))
        .join("")
    }
    if (Predicate.isTagged(node, "Repeat") || Predicate.isTagged(node, "Separated")) {
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
        finish: `if(${deferred}!==void 0)R.flushEntries(${out},${deferred});`,
        value: out,
        // A streaming build's checkpoint holds the object so far, with its deferred entries
        saved: `def:${deferred},`,
        restore: `${deferred}=cp.def;`
      }
      return Predicate.isTagged(node, "Repeat")
        ? this.repeat(node, true, out, fail, fn, d, collect)
        : this.separated(node, true, out, fail, fn, d, collect)
    }
    // SAFETY: the other nodes `buildsEntries` passes through are diagnostics, which all wrap a `self`
    return this.entries((node as { readonly self: ParserLike }).self, out, fail, fn, d)
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
    // SAFETY: `leaf`, the only caller, checks `native` first, which never holds on array input (kind 2)
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
          // SAFETY: a `Literal` with an encoding is a `Text` literal, which records the string it encodes
          const encoded = enc.encode(lit as string)
          return (
            this.literalUnits(Predicate.isString(encoded) ? unitsOf(encoded) : Array.from(encoded), false, fail) +
            set(this.lit(lit))
          )
        }
        const literalKind = Predicate.isString(lit) ? 0 : lit instanceof Uint8Array ? 1 : 2
        let codes: Array<number>
        if (Predicate.isString(lit)) codes = kind === 0 ? unitsOf(lit) : Array.from(new TextEncoder().encode(lit))
        else if (kind === 1 && lit instanceof Uint8Array) codes = Array.from(lit)
        else return undefined
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
    // SAFETY: called from `token` only, whose `kind` is not 2
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
    const slice = enc !== undefined ? this.text(enc, st) : kind === 0 ? `I.slice(${st},p)` : `I.subarray(${st},p)`
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
    const stops = negate && !counted ? stopChars(cs) : undefined
    if (stops !== undefined) return this.stopSearch(stops, st, c, finish, fn)
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
   * `Token.takeTill` on a string, of one to `MaxStops` characters that are
   * whole code points: the set accepts every other unit, surrogates
   * included, so the run ends at the first stop character. The first
   * `SearchHead` units are tested one at a time, which beats a native
   * search on short runs; a longer run ends at the next occurrence that
   * `nextStop` finds with `indexOf` (#75).
   */
  private stopSearch(stops: ReadonlyArray<number>, st: string, c: string, finish: string, fn: Fn): string {
    const h = this.v(fn)
    const test = stops.map((u) => `${c}!==${u}`).join("&&")
    // One stop character is searched for inline: a run that doesn't find it ends at `E`, so it is
    // searched for once. Several are searched for through `nextStop`'s cache, so that one which
    // doesn't occur isn't searched for again, to the end of the input, on every run.
    const search =
      stops.length === 1
        ? `{p=I.indexOf(${JSON.stringify(String.fromCharCode(stops[0]))},p);if(p<0)p=E}`
        : `p=R.nextStop(${this.const(new StopCache(stops.map((u) => String.fromCharCode(u))))},$S,p);`
    // A cached search costs more than a plain one, so it waits for a longer run
    const head = stops.length === 1 ? SearchHead : 2 * SearchHead
    return (
      `${st}=p;${h}=p+${head}<E?p+${head}:E;` +
      `while(p<${h}&&(${c}=I.charCodeAt(p),${test}))p++;` +
      // A run that ends right after the head needs no search
      `if(p===${h}&&p<E&&(${c}=I.charCodeAt(p),${test}))${search}${finish}`
    )
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
    const slice = enc !== undefined ? this.text(enc, st) : this.kind === 0 ? `I.slice(${st},p)` : `I.subarray(${st},p)`
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
      r === undefined ? loopCode : `${stop}:{${loopCode}if($S.partial){$S.incomplete(0);${save("p")}${fail}}}`
    if (r === undefined) {
      return `${raw ? `${st}=p;` : `${acc}="";`}${body}${raw && out !== null ? `${out}=${slice};` : ""}`
    }
    // `acc` is set unless raw
    if (acc !== null) return r.wrap(acc, `${acc}=cp.out;p=cp.pos;`, `${acc}="";`, body)
    const value = out ?? this.v(fn)
    return r.wrap(value, "p=cp;", "", `${body}${value}=${out === null ? "void 0" : slice};`)
  }
}

/**
 * A parser that exists only as a description, for the rewrites of
 * `Emitter.repeatRun`. `step` is never run on the paths they compile (the
 * token code of a native `takeWhile`, and alternatives inline), so it is
 * the step of the repetition's element, which describes the same language
 * when its value is unused.
 */
const synthetic = (node: Node, step: Step): ParserLike => {
  const described: ParserLike & { readonly [NodeId]: Node } = { step, name: undefined, [NodeId]: node }
  return described
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
  // Generated code reads past `end` expecting nothing to match there, which
  // holds when `end` is the input's length, as it is in the runners; other
  // states run the closure compiler's step, built on first use.
  let closure: Step | undefined
  const short = e.const((state: State<any>) =>
    (closure ??= createClosureCompiler(kind, resumable).compile(root, true))(state)
  )
  const source =
    `"use strict";let $I,$E,$S,P;${e.functions.join("\n")}\n` +
    `return function run(state){if(state.end!==state.input.length)return ${short}(state);` +
    `const sI=$I,sE=$E,sS=$S,sP=P;$I=state.input;$E=state.end;$S=state;` +
    `try{const v=${main}(state.pos);if(v!==F)state.pos=P;return v}` +
    // A call-stack overflow is a `TooDeep` failure, as `Stack.run` reports it
    `catch(e){if(!R.isStackOverflow(e))throw e;return R.tooDeep(state)}finally{$I=sI;$E=sE;$S=sS;P=sP}}`
  return { source, constants: e.constants, fallbacks: e.fallbacks }
}

/** A root parser compiled with `new Function`, with its generated source. */
interface JitCompiled extends CompiledRoot {
  readonly source: string
}

/**
 * Compiles a root parser for one input kind with `new Function`. The step
 * is the generated entry, which handles every state and reports call-stack
 * overflows itself.
 */
const compileJit = (root: ParserLike, kind: 0 | 1 | 2, resumable = false): JitCompiled => {
  const { constants, fallbacks, source } = generate(root, kind, resumable)
  // SAFETY: the generated source returns its `run` function, which takes a state and returns a value or `Fail`
  const step = globalThis.Function("C", "F", "R", source)(constants, Fail, runtime) as Step
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
          guarded: true,
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
