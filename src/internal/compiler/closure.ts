/**
 * The closure compiler: turns a parser's description into specialized
 * closures with the step signature. Compiled steps return a value, or
 * `Fail` with only `state.mode` set: no diagnostics are recorded.
 *
 * Nothing here generates code, so it works under a Content Security
 * Policy. Parsers that can't be compiled run their own (interpreted) steps
 * on the same state.
 */
import * as Predicate from "effect/Predicate"
import type { Encoding } from "../../Encoding.js"
import type { ErrMode, State } from "../../Input.js"
import { Fail } from "../../Input.js"
import * as Option from "effect/Option"
import type { Node, NodeOf, ParserLike } from "../node.js"
import { addEntry, flushEntries, fromEntries, isPlainKey } from "../entries.js"
import { nodeOf } from "../node.js"
import { floatScan, floatTexts, scanFloatBytes, scanFloatString, toFloat } from "../numbers.js"
import { charOf, fastLimit, firstCodePoint, fold, validate } from "../text.js"
import { countTokens, indexOf } from "../tokens.js"
import type { AltPlan } from "./first.js"
import * as Resume from "../resume.js"
import type { Backend } from "./registry.js"
import type { EntryPair } from "./entries.js"
import { buildsEntries, pairOf } from "./entries.js"
import { FirstSets, planAlt } from "./first.js"
import type { CharSet } from "./sets.js"
import { kindOfEncoding, TableSize, textSet, tokenSet } from "./sets.js"

export type Step = (state: State<any>) => any

/** A parser that the compiler left to its interpreted step. */
export interface Fallback {
  readonly name: string | undefined
  readonly tag: Node["_tag"]
  readonly reason: string
}

/** The maximum number of distinct parsers compiled for one root. */
const maxNodes = 2048

const BT: ErrMode = "Backtrack"
const CUT: ErrMode = "Cut"
const INC: ErrMode = "Incomplete"

/**
 * How many units past the cursor a single token can depend on (a code
 * point is at most 4 units). In a partial parse, a token parser that read
 * no closer than this to the end of the input behaves exactly as on
 * complete input.
 */
const Margin = 4

const lowerAscii = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c)

const isSuccess = (r: any): boolean => r._tag === "Success"
const isSome = (o: any): boolean => o._tag === "Some"

interface Slot {
  fn: Step | undefined
}

class Compiler {
  readonly used = new Map<ParserLike, Slot>()
  readonly unused = new Map<ParserLike, Slot>()
  readonly firsts: FirstSets
  readonly fallbacks: Array<Fallback> = []
  private readonly fellBack = new Set<ParserLike>()
  private budget = maxNodes

  /**
   * `resumable`: compile for streaming parses, which may be partial (see
   * `state.partial`) and keep checkpoints (see `internal/resume.ts`).
   */
  constructor(
    readonly kind: 0 | 1 | 2,
    readonly resumable = false
  ) {
    this.firsts = new FirstSets(kind)
  }

  /**
   * In a resumable build, runs the compiled token parser `step`, and falls
   * back to the interpreted one when it read within `lookahead` units of
   * the end of a partial input, where it might have to report `Incomplete`.
   * Compiled token parsers leave `state.pos` where they stopped reading,
   * even when they fail.
   */
  private partialSafe(p: ParserLike, step: Step, lookahead: number): Step {
    if (!this.resumable) return step
    const interpreted = p.step
    const ahead = Math.max(lookahead, Margin)
    return (s) => {
      if (!s.partial) return step(s)
      const start = s.pos
      const r = step(s)
      if (s.pos + ahead <= s.end) return r
      s.pos = start
      return interpreted(s)
    }
  }

  /** Compiles `p`; when `used` is false its output is not needed. */
  compile(p: ParserLike, used: boolean): Step {
    const memo = used ? this.used : this.unused
    const slot = memo.get(p)
    if (slot !== undefined) {
      if (slot.fn !== undefined) return slot.fn
      // A cycle through `suspend`: the slot is filled once the cycle is compiled, before any parse runs
      return (s) => (slot.fn ?? p.step)(s)
    }
    const fresh: Slot = { fn: undefined }
    memo.set(p, fresh)
    const node = nodeOf(p)
    const fn = --this.budget < 0 ? this.fallback(p, node, "node budget exceeded") : this.build(p, node, used)
    fresh.fn = fn
    return fn
  }

  fallback(p: ParserLike, node: Node, reason: string): Step {
    this.note(p, node, reason)
    return p.step
  }

  /** Records that (part of) `p` runs interpreted. */
  note(p: ParserLike, node: Node, reason: string): void {
    if (!this.fellBack.has(p)) {
      this.fellBack.add(p)
      this.fallbacks.push({ name: p.name, tag: node._tag, reason })
    }
  }

  /** Whether a token node reads this input kind natively. */
  private native(enc: Encoding<any> | undefined): boolean {
    return enc === undefined ? this.kind !== 2 : kindOfEncoding(enc) === this.kind
  }

  build(p: ParserLike, node: Node, used: boolean): Step {
    switch (node._tag) {
      case "Opaque":
        return this.fallback(p, node, "not describable (Parser.make, gen, ...)")
      case "Succeed": {
        const value = node.value
        return () => value
      }
      case "Sync": {
        const evaluate = node.evaluate
        return used ? () => evaluate() : () => undefined
      }
      case "Fail": {
        const mode = node.mode
        return (s) => {
          s.mode = mode
          return Fail
        }
      }
      case "Eof":
        return (s) => {
          if (s.pos < s.end) {
            s.mode = BT
            return Fail
          }
          if (s.partial) {
            s.mode = INC
            return Fail
          }
          return undefined
        }
      case "Location":
        return (s) => s.pos
      case "RestLen":
        return (s) => s.end - s.pos
      case "Suspend":
        return this.compile(node.resolve(), used)
      case "Any":
      case "Literal":
      case "OneOf":
      case "Take":
      case "TakeWhile":
      case "TakeUntil":
      case "Rest":
        if (!this.native(node.encoding)) return this.fallback(p, node, "token parser on array input")
        return this.partialSafe(
          p,
          node.encoding === undefined ? this.token(p, node, used) : this.text(p, node, node.encoding, used),
          node._tag === "Literal" || node._tag === "TakeUntil" ? node.literal.length * 4 : Margin
        )
      case "TillLineEnding":
      case "Identifier":
      case "Bom":
        return this.fallback(p, node, "leaf parser without a compiled form")
      case "Escaped":
        if (!this.native(node.encoding)) return this.fallback(p, node, "token parser on array input")
        return this.escaped(node)
      case "Map": {
        if (!used) return this.compile(node.self, false)
        if (node.f === toFloat) {
          const step = this.float(node)
          if (step !== undefined) return step
        }
        // Streaming builds keep the array, which their checkpoints hold
        if (node.f === fromEntries && !this.resumable && buildsEntries(node.self)) return this.entries(node.self)
        const c = this.compile(node.self, true)
        const f = node.f
        return (s) => {
          const a = c(s)
          return a === Fail ? Fail : f(a)
        }
      }
      case "As": {
        const c = this.compile(node.self, false)
        if (!used) return c
        const value = node.value
        return (s) => (c(s) === Fail ? Fail : value)
      }
      case "Tap": {
        const c = this.compile(node.self, true)
        const f = node.f
        return (s) => {
          const a = c(s)
          if (a !== Fail) f(a)
          return a
        }
      }
      case "TryMap": {
        const c = this.compile(node.self, true)
        const f = node.f
        return (s) => {
          const a = c(s)
          if (a === Fail) return Fail
          const r = f(a) as any
          if (isSuccess(r)) return r.success
          s.mode = BT
          return Fail
        }
      }
      case "FilterMap": {
        const c = this.compile(node.self, true)
        const f = node.f
        return (s) => {
          const a = c(s)
          if (a === Fail) return Fail
          const o = f(a) as any
          if (isSome(o)) return o.value
          s.mode = BT
          return Fail
        }
      }
      case "Filter": {
        const c = this.compile(node.self, true)
        const predicate = node.predicate
        return (s) => {
          const a = c(s)
          if (a === Fail) return Fail
          if (predicate(a)) return a
          s.mode = BT
          return Fail
        }
      }
      case "FlatMap": {
        // The parser returned by `f` runs interpreted
        const c = this.compile(node.self, true)
        const f = node.f
        this.note(p, node, "the parser returned by the function runs interpreted")
        return (s) => {
          const a = c(s)
          return a === Fail ? Fail : f(a).step(s)
        }
      }
      case "Taken":
        if (node.encoding !== undefined && !this.native(node.encoding)) {
          return this.fallback(p, node, "Text parser on another input kind")
        }
        return this.taken(node, used)
      case "WithTaken": {
        const c = this.compile(node.self, true)
        return (s) => {
          const start = s.pos
          const a = c(s)
          return a === Fail ? Fail : [a, s.slice(start, s.pos)]
        }
      }
      case "Span": {
        const c = this.compile(node.self, false)
        if (!used) return c
        return (s) => {
          const start = s.pos
          return c(s) === Fail ? Fail : { start, end: s.pos }
        }
      }
      case "WithSpan": {
        const c = this.compile(node.self, true)
        return (s) => {
          const start = s.pos
          const a = c(s)
          return a === Fail ? Fail : [a, { start, end: s.pos }]
        }
      }
      case "Mode": {
        const c = this.compile(node.self, used)
        const from = node.from
        const to = node.to
        return (s) => {
          const a = c(s)
          if (a === Fail && s.mode === from) s.mode = to
          return a
        }
      }
      case "Context":
      case "Expected":
      case "MapError":
      case "OrFail":
      case "Trace":
      case "Syntax":
      case "RetryAfter":
        // Diagnostics only, or inactive outside parseRecoverable / tracing
        return this.compile(node.self, used)
      case "ResumeAfter": {
        const c = this.compile(node.self, used)
        if (!used) return c
        return (s) => {
          const a = c(s)
          return a === Fail ? Fail : Option.some(a)
        }
      }
      case "Opt":
      case "OrElseSucceed": {
        const c = this.compile(node.self, used)
        const orElse = !used ? undefined : node._tag === "Opt" ? Option.none : node.value
        const some = used && node._tag === "Opt"
        return (s) => {
          const start = s.pos
          const a = c(s)
          if (a !== Fail) return some ? Option.some(a) : a
          if (s.mode !== BT) return Fail
          s.pos = start
          return orElse === undefined ? undefined : orElse()
        }
      }
      case "Peek": {
        const c = this.compile(node.self, used)
        return (s) => {
          const start = s.pos
          const a = c(s)
          if (a !== Fail) s.pos = start
          return a
        }
      }
      case "Not": {
        const c = this.compile(node.self, false)
        return (s) => {
          const start = s.pos
          if (c(s) !== Fail) {
            s.pos = start
            s.mode = BT
            return Fail
          }
          if (s.mode !== BT) return Fail
          s.pos = start
          return undefined
        }
      }
      case "Seq":
        return this.seq(node, used)
      case "Struct": {
        const keys = node.keys
        const steps = node.parsers.map((q) => this.compile(q, used))
        const n = steps.length
        if (!used) return this.chain(steps)
        return (s) => {
          const out: Record<string, unknown> = {}
          for (let i = 0; i < n; i++) {
            const a = steps[i](s)
            if (a === Fail) return Fail
            out[keys[i]] = a
          }
          return out
        }
      }
      case "ZipWith": {
        const c1 = this.compile(node.self, used)
        const c2 = this.compile(node.that, used)
        if (!used) return this.chain([c1, c2])
        const f = node.f
        return (s) => {
          const a = c1(s)
          if (a === Fail) return Fail
          const b = c2(s)
          return b === Fail ? Fail : f(a, b)
        }
      }
      case "Alt":
        return this.alt(node, used)
      case "Dispatch":
        return this.dispatch(p, node, used)
      case "Repeat":
      case "Fold":
        return this.repeat(node, used)
      case "RepeatTill":
        return this.repeatTill(node)
      case "Separated":
        return this.separated(node, used)
      case "SeparatedFold":
        return this.separatedFold(node)
      case "Service":
      case "Provide":
        return this.fallback(p, node, "services stay interpreted")
    }
  }

  /** Runs steps in order, for their effect on the cursor only. */
  chain(steps: ReadonlyArray<Step>): Step {
    const n = steps.length
    if (n === 0) return () => undefined
    if (n === 1) return steps[0]
    if (n === 2) {
      const [a, b] = steps as [Step, Step]
      return (s) => (a(s) === Fail ? Fail : b(s))
    }
    return (s) => {
      for (let i = 0; i < n; i++) if (steps[i](s) === Fail) return Fail
      return undefined
    }
  }

  seq(node: NodeOf<"Seq">, used: boolean): Step {
    const output = node.output
    const keep = (i: number) =>
      used && (output === "tuple" || output === i || (Array.isArray(output) && output.includes(i)))
    const steps = node.parsers.map((q, i) => this.compile(q, keep(i)))
    const n = steps.length
    if (!used) return this.chain(steps)
    if (output === "tuple") {
      return (s) => {
        const out = new Array(n)
        for (let i = 0; i < n; i++) {
          const a = steps[i](s)
          if (a === Fail) return Fail
          out[i] = a
        }
        return out
      }
    }
    if (Predicate.isNumber(output)) {
      if (n === 2) {
        const [a, b] = steps as [Step, Step]
        return output === 0
          ? (s) => {
              const x = a(s)
              if (x === Fail) return Fail
              return b(s) === Fail ? Fail : x
            }
          : (s) => (a(s) === Fail ? Fail : b(s))
      }
      return (s) => {
        let out: unknown
        for (let i = 0; i < n; i++) {
          const a = steps[i](s)
          if (a === Fail) return Fail
          if (i === output) out = a
        }
        return out
      }
    }
    const [i0, i1] = output
    return (s) => {
      let x: unknown
      let y: unknown
      for (let i = 0; i < n; i++) {
        const a = steps[i](s)
        if (a === Fail) return Fail
        if (i === i0) x = a
        else if (i === i1) y = a
      }
      return [x, y]
    }
  }

  /** The unit at the cursor, or -1 at the end of the input. */
  private unitReader(): (s: State<any>) => number {
    return this.kind === 0
      ? (s) => (s.pos < s.end ? (s.input as string).charCodeAt(s.pos) : -1)
      : (s) => (s.pos < s.end ? (s.input as Uint8Array)[s.pos] : -1)
  }

  alt(node: NodeOf<"Alt">, used: boolean): Step {
    const steps = node.parsers.map((q) => this.compile(q, used))
    const n = steps.length
    if (n === 0) {
      return (s) => {
        s.mode = BT
        return Fail
      }
    }
    if (n === 1) return steps[0]
    const plan: AltPlan | undefined = this.kind === 2 ? undefined : planAlt(node.parsers.map((q) => this.firsts.of(q)))
    if (plan === undefined) {
      return (s) => {
        const start = s.pos
        for (let i = 0; i < n; i++) {
          const a = steps[i](s)
          if (a !== Fail) return a
          if (s.mode !== BT) return Fail
          s.pos = start
        }
        s.mode = BT
        return Fail
      }
    }
    const lists = plan.lists.map((l) => l.map((i) => steps[i]))
    const { byUnit, end, high } = plan
    const unit = this.unitReader()
    const resumable = this.resumable
    return (s) => {
      // Near the end of a partial input, branches may be incomplete rather than fail
      const u = resumable && s.partial && s.pos + Margin > s.end ? -2 : unit(s)
      const candidates = u === -2 ? steps : lists[u < 0 ? end : u < TableSize ? byUnit[u] : high]
      const start = s.pos
      for (let i = 0; i < candidates.length; i++) {
        const a = candidates[i](s)
        if (a !== Fail) return a
        if (s.mode !== BT) return Fail
        s.pos = start
      }
      s.mode = BT
      return Fail
    }
  }

  dispatch(p: ParserLike, node: NodeOf<"Dispatch">, used: boolean): Step {
    const selector = this.compile(node.selector, true)
    const choose = node.choose
    const compiled = new Map<ParserLike, Step>()
    if (node.cases !== undefined) {
      for (const key of Reflect.ownKeys(node.cases)) {
        const q = node.cases[key as any]
        if (!compiled.has(q)) compiled.set(q, this.compile(q, used))
      }
    }
    if (node.otherwise !== undefined && !compiled.has(node.otherwise)) {
      compiled.set(node.otherwise, this.compile(node.otherwise, used))
    }
    const general: Step = (s) => {
      const start = s.pos
      const key = selector(s)
      if (key === Fail) return Fail
      const q = choose(key)
      if (q === undefined) {
        s.pos = start
        s.mode = BT
        return Fail
      }
      return (compiled.get(q) ?? q.step)(s)
    }
    if (node.cases === undefined) {
      this.note(p, node, "the parser returned by the function of cases runs interpreted")
      return general
    }
    // Switch on the next unit when the selector is `any` or `peek(any)`
    let sel = nodeOf(node.selector)
    const peek = sel._tag === "Peek"
    if (peek) sel = nodeOf((sel as NodeOf<"Peek">).self)
    if (sel._tag !== "Any" || !this.native(sel.encoding)) return general
    const enc = sel.encoding
    // Units below `limit` are whole tokens, so the key is known in advance
    const limit = enc === undefined ? (this.kind === 0 ? 0xd800 : TableSize) : Math.min(fastLimit(enc), 0xd800)
    const size = Math.min(limit, TableSize)
    if (size === 0) return general
    const table: Array<Step | null> = []
    for (let u = 0; u < size; u++) {
      const key = enc === undefined && this.kind === 1 ? u : charOf(u)
      const q = choose(key)
      table.push(q === undefined ? null : (compiled.get(q) ?? q.step))
    }
    const unit = this.unitReader()
    const advance = peek ? 0 : 1
    const resumable = this.resumable
    return (s) => {
      if (resumable && s.partial && s.pos + Margin > s.end) return general(s)
      const u = unit(s)
      if (u < 0) {
        s.mode = BT
        return Fail
      }
      if (u >= size) return general(s)
      const q = table[u]
      if (q === null) {
        s.mode = BT
        return Fail
      }
      s.pos += advance
      return q(s)
    }
  }

  repeat(node: NodeOf<"Repeat"> | NodeOf<"Fold">, used: boolean): Step {
    const { max, min } = node
    const checkLoop = max === Infinity
    const isFold = node._tag === "Fold"
    const cond = isFold ? (node as NodeOf<"Fold">).while : undefined
    const c = this.compile(node.self, used)
    const resumable = this.resumable
    const key = {}
    // The accumulator: an array, the fold's value, or nothing when unused (and unneeded by `while`)
    const tracked = used || cond !== undefined
    const init: () => unknown = !tracked ? () => undefined : isFold ? (node as NodeOf<"Fold">).init : () => []
    const add: (acc: any, a: unknown) => unknown = !tracked
      ? (acc) => acc
      : isFold
        ? (node as NodeOf<"Fold">).f
        : (acc, a) => {
            acc.push(a)
            return acc
          }
    return (s) => {
      const entry = s.pos
      let acc: unknown
      let count = 0
      let resumed = false
      if (resumable && s.resume !== undefined) {
        const cp = Resume.take(s, key, entry) as Resume.Done | { acc: unknown; count: number; pos: number } | undefined
        if (cp instanceof Resume.Done) {
          s.pos = cp.pos
          return cp.value
        }
        if (cp !== undefined) {
          acc = cp.acc
          count = cp.count
          s.pos = cp.pos
          resumed = true
        }
      }
      if (!resumed) acc = init()
      for (; count < max; count++) {
        if (cond !== undefined && count >= min && !cond(acc)) break
        const start = s.pos
        const a = c(s)
        if (a === Fail) {
          if (s.mode === INC && s.resume !== undefined) Resume.save(s, key, entry, { acc, count, pos: start })
          if (s.mode !== BT || count < min) return Fail
          s.pos = start
          return resumed ? Resume.done(s, key, entry, true, acc) : acc
        }
        if (checkLoop && s.pos === start) {
          s.mode = CUT
          return Fail
        }
        acc = add(acc, a)
      }
      return resumed ? Resume.done(s, key, entry, true, acc) : acc
    }
  }

  /**
   * `map(self, Object.fromEntries)`, where `buildsEntries(self)`: builds the
   * object directly (see the JIT).
   */
  private entries(p: ParserLike): Step {
    const node = nodeOf(p)
    switch (node._tag) {
      case "Mode": {
        const c = this.entries(node.self)
        const from = node.from
        const to = node.to
        return (s) => {
          const a = c(s)
          if (a === Fail && s.mode === from) s.mode = to
          return a
        }
      }
      case "Seq": {
        const i = node.output as number
        const steps = node.parsers.map((q, j) => (j === i ? this.entries(q) : this.compile(q, false)))
        return (s) => {
          let out: unknown
          for (let j = 0; j < steps.length; j++) {
            const a = steps[j](s)
            if (a === Fail) return Fail
            if (j === i) out = a
          }
          return out
        }
      }
      case "Repeat":
      case "Separated": {
        const pair = pairOf(node.self)
        if (pair !== undefined) return this.entriesLoop(node, pair)
        // Not reached (`buildsEntries` found the pair): build the pairs, then the object
        const c = this.compile(p, true)
        return (s) => {
          const a = c(s)
          return a === Fail ? Fail : fromEntries(a as Iterable<readonly [PropertyKey, unknown]>)
        }
      }
      default:
        return this.entries((node as { readonly self: ParserLike }).self)
    }
  }

  private entriesLoop(node: NodeOf<"Repeat"> | NodeOf<"Separated">, pair: EntryPair): Step {
    const parts = pair.parsers.map((q, j) => this.compile(q, j === pair.key || j === pair.value))
    const { key: ki, value: vi } = pair
    // Parses an entry and adds it to `acc`
    const entry = (s: State<any>, acc: EntriesAcc): boolean => {
      let key: unknown
      let value: unknown
      for (let j = 0; j < parts.length; j++) {
        const a = parts[j](s)
        if (a === Fail) return false
        if (j === ki) key = a
        else if (j === vi) value = a
      }
      acc.add(key, value)
      return true
    }
    const { max, min } = node
    const checkLoop = max === Infinity
    if (node._tag === "Repeat") {
      return (s) => {
        const acc = new EntriesAcc()
        for (let count = 0; count < max; count++) {
          const start = s.pos
          let key: unknown
          let value: unknown
          let ok = true
          for (let j = 0; j < parts.length; j++) {
            const a = parts[j](s)
            if (a === Fail) {
              ok = false
              break
            }
            if (j === ki) key = a
            else if (j === vi) value = a
          }
          if (!ok) {
            if (s.mode !== BT || count < min) return Fail
            s.pos = start
            return acc.result()
          }
          if (checkLoop && s.pos === start) {
            s.mode = CUT
            return Fail
          }
          acc.add(key, value)
        }
        return acc.result()
      }
    }
    const sep = this.compile(node.separator, false)
    return (s) => {
      const acc = new EntriesAcc()
      let count = 0
      if (max === 0) return acc.result()
      let start = s.pos
      if (!entry(s, acc)) {
        if (s.mode !== BT || min > 0) return Fail
        s.pos = start
        return acc.result()
      }
      count++
      while (count < max) {
        start = s.pos
        if (sep(s) === Fail) {
          if (s.mode !== BT || count < min) return Fail
          s.pos = start
          return acc.result()
        }
        if (checkLoop && s.pos === start) {
          s.mode = CUT
          return Fail
        }
        if (!entry(s, acc)) {
          if (s.mode !== BT || count < min) return Fail
          s.pos = start
          return acc.result()
        }
        count++
      }
      return acc.result()
    }
  }

  repeatTill(node: NodeOf<"RepeatTill">): Step {
    const { max, min } = node
    const c = this.compile(node.self, true)
    const end = this.compile(node.end, true)
    return (s) => {
      const acc: Array<unknown> = []
      while (true) {
        const start = s.pos
        if (acc.length >= min) {
          const b = end(s)
          if (b !== Fail) return [acc, b]
          if (s.mode !== BT) return Fail
          s.pos = start
          if (acc.length >= max) return Fail
        }
        const a = c(s)
        if (a === Fail) return Fail
        if (s.pos === start) {
          s.mode = CUT
          return Fail
        }
        acc.push(a)
      }
    }
  }

  separated(node: NodeOf<"Separated">, used: boolean): Step {
    const { max, min } = node
    const checkLoop = max === Infinity
    const c = this.compile(node.self, used)
    const sep = this.compile(node.separator, false)
    const resumable = this.resumable
    const key = {}
    return (s) => {
      const entry = s.pos
      let acc: Array<unknown> | undefined
      let count = 0
      let resumed = false
      if (resumable && s.resume !== undefined) {
        const cp = Resume.take(s, key, entry) as
          | Resume.Done
          | { acc: Array<unknown>; count: number; pos: number }
          | undefined
        if (cp instanceof Resume.Done) {
          s.pos = cp.pos
          return cp.value
        }
        if (cp !== undefined) {
          acc = cp.acc
          count = cp.count
          s.pos = cp.pos
          resumed = true
        }
      }
      if (!resumed) {
        acc = used ? [] : undefined
        if (max === 0) return acc
        const start = s.pos
        const first = c(s)
        if (first === Fail) {
          if (s.mode !== BT || min > 0) return Fail
          s.pos = start
          return acc
        }
        acc?.push(first)
        count = 1
      }
      while (count < max) {
        const start = s.pos
        if (sep(s) === Fail) {
          if (s.mode === INC && s.resume !== undefined) Resume.save(s, key, entry, { acc, count, pos: start })
          if (s.mode !== BT || count < min) return Fail
          s.pos = start
          return resumed ? Resume.done(s, key, entry, true, acc) : acc
        }
        if (checkLoop && s.pos === start) {
          s.mode = CUT
          return Fail
        }
        const a = c(s)
        if (a === Fail) {
          if (s.mode === INC && s.resume !== undefined) Resume.save(s, key, entry, { acc, count, pos: start })
          if (s.mode !== BT || count < min) return Fail
          s.pos = start
          return resumed ? Resume.done(s, key, entry, true, acc) : acc
        }
        acc?.push(a)
        count++
      }
      return resumed ? Resume.done(s, key, entry, true, acc) : acc
    }
  }

  separatedFold(node: NodeOf<"SeparatedFold">): Step {
    const c = this.compile(node.self, true)
    const sep = this.compile(node.separator, true)
    const op = node.op
    const resumable = this.resumable
    const key = {}
    if (!node.right) {
      return (s) => {
        const entry = s.pos
        let acc: unknown
        let resumed = false
        if (resumable && s.resume !== undefined) {
          const cp = Resume.take(s, key, entry) as Resume.Done | { acc: unknown; pos: number } | undefined
          if (cp instanceof Resume.Done) {
            s.pos = cp.pos
            return cp.value
          }
          if (cp !== undefined) {
            acc = cp.acc
            s.pos = cp.pos
            resumed = true
          }
        }
        if (!resumed) {
          acc = c(s)
          if (acc === Fail) return Fail
        }
        while (true) {
          const start = s.pos
          const x = sep(s)
          if (x === Fail) {
            if (s.mode === INC && s.resume !== undefined) Resume.save(s, key, entry, { acc, pos: start })
            if (s.mode !== BT) return Fail
            s.pos = start
            return resumed ? Resume.done(s, key, entry, true, acc) : acc
          }
          if (s.pos === start) {
            s.mode = CUT
            return Fail
          }
          const a = c(s)
          if (a === Fail) {
            if (s.mode === INC && s.resume !== undefined) Resume.save(s, key, entry, { acc, pos: start })
            if (s.mode !== BT) return Fail
            s.pos = start
            return resumed ? Resume.done(s, key, entry, true, acc) : acc
          }
          acc = op(acc, x, a)
        }
      }
    }
    return (s) => {
      const first = c(s)
      if (first === Fail) return Fail
      const values: Array<unknown> = [first]
      const seps: Array<unknown> = []
      while (true) {
        const start = s.pos
        const x = sep(s)
        if (x === Fail) {
          if (s.mode !== BT) return Fail
          s.pos = start
          break
        }
        if (s.pos === start) {
          s.mode = CUT
          return Fail
        }
        const a = c(s)
        if (a === Fail) {
          if (s.mode !== BT) return Fail
          s.pos = start
          break
        }
        seps.push(x)
        values.push(a)
      }
      let acc = values[values.length - 1]
      for (let i = seps.length - 1; i >= 0; i--) acc = op(values[i], seps[i], acc)
      return acc
    }
  }

  // ---------------------------------------------------------------------------
  // Token parsers (`Token`, `Ascii`)
  // ---------------------------------------------------------------------------

  token(p: ParserLike, node: TokenNode, used: boolean): Step {
    const kind = this.kind as 0 | 1
    switch (node._tag) {
      case "Any":
        if (kind === 1) {
          return (s) => {
            const pos = s.pos
            if (pos >= s.end) return fail(s)
            s.pos = pos + 1
            return (s.input as Uint8Array)[pos]
          }
        }
        return (s) => {
          const pos = s.pos
          if (pos >= s.end) return fail(s)
          const str = s.input as string
          const c = str.charCodeAt(pos)
          if (c >= 0xd800 && c <= 0xdbff && pos + 1 < str.length && (str.charCodeAt(pos + 1) & 0xfc00) === 0xdc00) {
            s.pos = pos + 2
            return used ? str.slice(pos, pos + 2) : undefined
          }
          s.pos = pos + 1
          return used ? str[pos] : undefined
        }
      case "Literal":
        return this.tokenLiteral(p, node)
      case "OneOf": {
        const set = tokenSet(node.set, kind)
        const negate = node.negate
        const accept = acceptTable(set, negate)
        const test = set.test
        if (kind === 1) {
          return (s) => {
            const pos = s.pos
            if (pos >= s.end) return fail(s)
            const b = (s.input as Uint8Array)[pos]
            if (accept[b] === 0) return fail(s)
            s.pos = pos + 1
            return b
          }
        }
        return (s) => {
          const pos = s.pos
          if (pos >= s.end) return fail(s)
          const str = s.input as string
          const c = str.charCodeAt(pos)
          if (c < TableSize) {
            if (accept[c] === 0) return fail(s)
            s.pos = pos + 1
            return used ? str[pos] : undefined
          }
          let cp = c
          if (c >= 0xd800 && c <= 0xdbff && pos + 1 < str.length) {
            const d = str.charCodeAt(pos + 1)
            if ((d & 0xfc00) === 0xdc00) cp = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000
          }
          if (test(cp) === negate) return fail(s)
          const len = cp > 0xffff ? 2 : 1
          s.pos = pos + len
          return !used ? undefined : len === 1 ? str[pos] : str.slice(pos, pos + 2)
        }
      }
      case "Take": {
        const count = node.count
        if (kind === 1) {
          return (s) => {
            const start = s.pos
            if (s.end - start < count) return failAt(s, s.end)
            s.pos = start + count
            return used ? (s.input as Uint8Array).subarray(start, start + count) : undefined
          }
        }
        return (s) => {
          const str = s.input as string
          const start = s.pos
          const end = s.end
          let i = start
          let got = 0
          while (got < count && i < end) {
            const c = str.charCodeAt(i)
            i += c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1
            got++
          }
          if (got < count) return failAt(s, i)
          s.pos = i
          return used ? str.slice(start, i) : undefined
        }
      }
      case "TakeWhile":
        return this.tokenTakeWhile(node, used)
      case "TakeUntil": {
        const { literal, max, min } = node
        const bounded = min > 0 || max !== Infinity
        return (s) => {
          const start = s.pos
          const idx = indexOf(s, literal, start)
          if (idx < 0) return failAt(s, s.end)
          if (bounded) {
            const count = countTokens(s, start, idx)
            if (count < min || count > max) return failAt(s, idx)
          }
          s.pos = idx
          return used ? s.slice(start, idx) : undefined
        }
      }
      case "Rest":
        return (s) => {
          const start = s.pos
          s.pos = s.end
          return used ? s.slice(start, s.end) : undefined
        }
    }
  }

  tokenLiteral(p: ParserLike, node: NodeOf<"Literal">): Step {
    const lit = node.literal
    const literalKind = Predicate.isString(lit) ? 0 : lit instanceof Uint8Array ? 1 : 2
    if (this.kind === 0) {
      if (literalKind !== 0) return this.fallback(p, node, "byte or array literal on string input")
      const str = lit as string
      const len = str.length
      if (node.caseless) {
        const lowered = Array.from({ length: len }, (_, i) => lowerAscii(str.charCodeAt(i)))
        return (s) => {
          const pos = s.pos
          if (s.end - pos < len) return fail(s)
          const input = s.input as string
          for (let i = 0; i < len; i++) {
            if (lowerAscii(input.charCodeAt(pos + i)) !== lowered[i]) return fail(s)
          }
          s.pos = pos + len
          return input.slice(pos, pos + len)
        }
      }
      return stringLiteral(str, str)
    }
    if (literalKind === 2) return this.fallback(p, node, "array literal on byte input")
    const bytes = literalKind === 0 ? new TextEncoder().encode(lit as string) : (lit as Uint8Array)
    const len = bytes.length
    const sameKind = literalKind === 1 && !node.caseless
    const expect = node.caseless ? Array.from(bytes, lowerAscii) : Array.from(bytes)
    const caseless = node.caseless
    return (s) => {
      const pos = s.pos
      if (s.end - pos < len) return fail(s)
      const input = s.input as Uint8Array
      for (let i = 0; i < len; i++) {
        const b = input[pos + i]
        if ((caseless ? lowerAscii(b) : b) !== expect[i]) return fail(s)
      }
      s.pos = pos + len
      return sameKind ? lit : input.subarray(pos, pos + len)
    }
  }

  tokenTakeWhile(node: NodeOf<"TakeWhile">, used: boolean): Step {
    const kind = this.kind as 0 | 1
    const { max, min, negate } = node
    const set = tokenSet(node.set, kind)
    const accept = acceptTable(set, negate)
    if (kind === 1) {
      return (s) => {
        const bytes = s.input as Uint8Array
        const start = s.pos
        const limit = max === Infinity ? s.end : Math.min(s.end, start + max)
        let i = start
        while (i < limit && accept[bytes[i]] === 1) i++
        if (i - start < min) return failAt(s, i)
        s.pos = i
        return used ? bytes.subarray(start, i) : undefined
      }
    }
    const test = set.test
    return (s) => {
      const str = s.input as string
      const start = s.pos
      const end = s.end
      let i = start
      let count = 0
      while (count < max && i < end) {
        const c = str.charCodeAt(i)
        if (c < TableSize) {
          if (accept[c] === 0) break
          i++
        } else if (c < 0xd800 || c > 0xdbff) {
          if (test(c) === negate) break
          i++
        } else {
          let cp = c
          if (i + 1 < str.length) {
            const d = str.charCodeAt(i + 1)
            if ((d & 0xfc00) === 0xdc00) cp = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000
          }
          if (test(cp) === negate) break
          i += cp > 0xffff ? 2 : 1
        }
        count++
      }
      if (count < min) return failAt(s, i)
      s.pos = i
      return used ? str.slice(start, i) : undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Text parsers, specialized per encoding
  // ---------------------------------------------------------------------------

  text(p: ParserLike, node: TokenNode, enc: Encoding<any>, used: boolean): Step {
    const kind = this.kind as 0 | 1
    const fast = fastLimit(enc)
    const decode = enc.decode
    const width = enc.width
    const toText = enc.text
    const unitAt: (input: any, i: number) => number =
      kind === 0 ? (input: string, i) => input.charCodeAt(i) : (input: Uint8Array, i) => input[i]
    switch (node._tag) {
      case "Any":
        return (s) => {
          const pos = s.pos
          const end = s.end
          if (pos >= end) return fail(s)
          const c = unitAt(s.input, pos)
          if (c < fast) {
            s.pos = pos + 1
            return used ? charOf(c) : undefined
          }
          const cp = decode(s.input, pos, end)
          if (cp < 0) return fail(s)
          s.pos = pos + width(cp)
          return used ? charOf(cp) : undefined
        }
      case "Literal": {
        const lit = node.literal as string
        if (node.caseless) {
          const folded = Array.from(lit, (c) => fold(firstCodePoint(c)))
          const n = folded.length
          return (s) => {
            const start = s.pos
            const end = s.end
            const input = s.input
            let pos = start
            for (let i = 0; i < n; i++) {
              if (pos >= end) return failAt(s, pos)
              const c = unitAt(input, pos)
              let cp: number
              if (c < fast) {
                cp = c
                pos++
              } else {
                cp = decode(input, pos, end)
                if (cp < 0) return failAt(s, pos)
                pos += width(cp)
              }
              if (fold(cp) !== folded[i]) return failAt(s, pos)
            }
            s.pos = pos
            return used ? toText(input, start, pos) : undefined
          }
        }
        const encoded = enc.encode(lit)
        if (Predicate.isString(encoded)) return stringLiteral(encoded, lit)
        const bytes = encoded as Uint8Array
        const len = bytes.length
        if (len === 1) {
          const b0 = bytes[0]
          return (s) => {
            const pos = s.pos
            if (pos < s.end && (s.input as Uint8Array)[pos] === b0) {
              s.pos = pos + 1
              return lit
            }
            return fail(s)
          }
        }
        return (s) => {
          const pos = s.pos
          if (s.end - pos < len) return fail(s)
          const input = s.input as Uint8Array
          for (let i = 0; i < len; i++) if (input[pos + i] !== bytes[i]) return fail(s)
          s.pos = pos + len
          return lit
        }
      }
      case "OneOf": {
        const set = textSet(node.set)
        const negate = node.negate
        const accept = acceptTable(set, negate)
        const test = set.test
        return (s) => {
          const pos = s.pos
          const end = s.end
          if (pos >= end) return fail(s)
          const c = unitAt(s.input, pos)
          if (c < fast && c < TableSize) {
            if (accept[c] === 0) return fail(s)
            s.pos = pos + 1
            return used ? charOf(c) : undefined
          }
          const cp = c < fast ? c : decode(s.input, pos, end)
          if (cp < 0 || test(cp) === negate) return fail(s)
          s.pos = pos + (c < fast ? 1 : width(cp))
          return used ? charOf(cp) : undefined
        }
      }
      case "Take": {
        const count = node.count
        return (s) => {
          const start = s.pos
          const end = s.end
          const input = s.input
          let pos = start
          for (let got = 0; got < count; got++) {
            if (pos >= end) return failAt(s, pos)
            const c = unitAt(input, pos)
            if (c < fast) pos++
            else {
              const cp = decode(input, pos, end)
              if (cp < 0) return failAt(s, pos)
              pos += width(cp)
            }
          }
          s.pos = pos
          return used ? toText(input, start, pos) : undefined
        }
      }
      case "TakeWhile": {
        const { max, min, negate } = node
        const set = textSet(node.set)
        const accept = acceptTable(set, negate)
        const test = set.test
        const small = Math.min(fast, TableSize)
        return (s) => {
          const input = s.input
          const start = s.pos
          const end = s.end
          let i = start
          let count = 0
          while (count < max && i < end) {
            const c = unitAt(input, i)
            if (c < small) {
              if (accept[c] === 0) break
              i++
            } else if (c < fast) {
              if (test(c) === negate) break
              i++
            } else {
              const cp = decode(input, i, end)
              if (cp < 0 || test(cp) === negate) break
              i += width(cp)
            }
            count++
          }
          if (count < min) return failAt(s, i)
          s.pos = i
          return used ? toText(input, start, i) : undefined
        }
      }
      case "TakeUntil":
      case "Rest":
        return this.fallback(p, node, "Text parser without a compiled form")
    }
  }

  taken(node: NodeOf<"Taken">, used: boolean): Step {
    const c = this.compile(node.self, false)
    const enc = node.encoding
    if (enc === undefined) {
      if (!used) return c
      if (this.kind === 0) {
        return (s) => {
          const start = s.pos
          return c(s) === Fail ? Fail : (s.input as string).slice(start, s.pos)
        }
      }
      return (s) => {
        const start = s.pos
        return c(s) === Fail ? Fail : s.slice(start, s.pos)
      }
    }
    // `Text.taken` checks that the text is well formed, then decodes it
    const fast = fastLimit(enc)
    const toText = enc.text
    const unitAt: (input: any, i: number) => number =
      this.kind === 0 ? (input: string, i) => input.charCodeAt(i) : (input: Uint8Array, i) => input[i]
    return (s) => {
      const start = s.pos
      if (c(s) === Fail) return Fail
      const end = s.pos
      const input = s.input
      let i = start
      while (i < end && unitAt(input, i) < fast) i++
      if (i < end && validate(enc, s, i, end) < 0) return fail(s)
      return used ? toText(input, start, end) : undefined
    }
  }

  /**
   * `Ascii.float` and `Text.float` (`map(floatText, toFloat)`): numbers in
   * decimal notation are matched and converted in one pass, without
   * slicing the input; the rest runs the compiled parser (see the JIT).
   */
  private float(node: NodeOf<"Map">): Step | undefined {
    if (!floatTexts.has(node.self) || this.kind === 2) return undefined
    let taken = nodeOf(node.self)
    while (taken._tag === "Expected") taken = nodeOf(taken.self)
    if (taken._tag !== "Taken") return undefined
    const enc = taken.encoding
    if (enc !== undefined && !(this.native(enc) && enc.unit === 1 && enc.asciiCompatible)) return undefined
    const c = this.compile(node.self, true)
    const scan = (this.kind === 0 ? scanFloatString : scanFloatBytes) as (
      input: unknown,
      i: number,
      end: number
    ) => unknown
    const resumable = this.resumable
    return (s) => {
      const v = scan(s.input, s.pos, s.end)
      // Near the end of a partial input, the parser may have to report `Incomplete`
      if (v === undefined || (resumable && s.partial && floatScan.read + Margin > s.end)) {
        const t = c(s)
        return t === Fail ? Fail : toFloat(t)
      }
      if (v === Fail) return fail(s)
      s.pos = floatScan.end
      return v
    }
  }

  escaped(node: NodeOf<"Escaped">): Step {
    const raw = node.raw
    const normal = this.compile(node.normal, !raw)
    const escape = this.compile(node.escape, !raw)
    const enc = node.encoding
    const ctrl = node.control
    const kind = this.kind
    // Matches the control character, advancing past it
    let control: (s: State<any>) => boolean
    if (enc === undefined || (ctrl < fastLimit(enc) && ctrl < TableSize)) {
      control =
        kind === 0
          ? (s) => {
              if (s.pos < s.end && (s.input as string).charCodeAt(s.pos) === ctrl) {
                s.pos++
                return true
              }
              return false
            }
          : (s) => {
              if (s.pos < s.end && (s.input as Uint8Array)[s.pos] === ctrl) {
                s.pos++
                return true
              }
              return false
            }
    } else {
      control = (s) => {
        if (s.pos >= s.end) return false
        const cp = enc.decode(s.input, s.pos, s.end)
        if (cp !== ctrl) return false
        s.pos += enc.width(cp)
        return true
      }
    }
    const resumable = this.resumable
    const key = {}
    /** Fails as incomplete, keeping a checkpoint in a streaming parse. */
    const incomplete = (s: State<any>, start: number, checkpoint: unknown): typeof Fail => {
      if (s.resume !== undefined) Resume.save(s, key, start, checkpoint)
      s.mode = INC
      return Fail
    }
    if (raw) {
      const slice: (s: State<any>, start: number) => unknown =
        enc === undefined ? (s, start) => s.slice(start, s.pos) : (s, start) => enc.text(s.input, start, s.pos)
      return (s) => {
        const start = s.pos
        let resumed = false
        if (resumable && s.resume !== undefined) {
          const cp = Resume.take(s, key, start) as Resume.Done | number | undefined
          if (cp instanceof Resume.Done) {
            s.pos = cp.pos
            return cp.value
          }
          if (cp !== undefined) {
            s.pos = cp
            resumed = true
          }
        }
        while (s.pos < s.end) {
          const before = s.pos
          if (normal(s) !== Fail) {
            if (s.pos === before) {
              s.mode = CUT
              return Fail
            }
            continue
          }
          if (s.mode === INC) return incomplete(s, start, before)
          if (s.mode !== BT) return Fail
          s.pos = before
          if (control(s)) {
            if (escape(s) === Fail) return s.mode === INC ? incomplete(s, start, before) : Fail
          } else {
            return resumed ? Resume.done(s, key, start, true, slice(s, start)) : slice(s, start)
          }
        }
        if (s.partial) return incomplete(s, start, s.pos)
        return resumed ? Resume.done(s, key, start, true, slice(s, start)) : slice(s, start)
      }
    }
    return (s) => {
      const start = s.pos
      let out = ""
      let resumed = false
      if (resumable && s.resume !== undefined) {
        const cp = Resume.take(s, key, start) as Resume.Done | { out: string; pos: number } | undefined
        if (cp instanceof Resume.Done) {
          s.pos = cp.pos
          return cp.value
        }
        if (cp !== undefined) {
          out = cp.out
          s.pos = cp.pos
          resumed = true
        }
      }
      while (s.pos < s.end) {
        const before = s.pos
        const a = normal(s)
        if (a !== Fail) {
          if (s.pos !== before) {
            out += a
            continue
          }
        } else {
          if (s.mode === INC) return incomplete(s, start, { out, pos: before })
          if (s.mode !== BT) return Fail
          s.pos = before
        }
        if (control(s)) {
          const b = escape(s)
          if (b === Fail) return s.mode === INC ? incomplete(s, start, { out, pos: before }) : Fail
          out += b
        } else {
          return resumed ? Resume.done(s, key, start, true, out) : out
        }
      }
      if (s.partial) return incomplete(s, start, { out, pos: s.pos })
      return resumed ? Resume.done(s, key, start, true, out) : out
    }
  }
}

type TokenNode = NodeOf<"Any" | "Literal" | "OneOf" | "Take" | "TakeWhile" | "TakeUntil" | "Rest">

const fail = (s: State<any>): typeof Fail => {
  s.mode = BT
  return Fail
}

/** Fails, leaving the cursor at `pos`: how far a token parser read (see `partialSafe`). */
const failAt = (s: State<any>, pos: number): typeof Fail => {
  s.pos = pos
  s.mode = BT
  return Fail
}

/** 1 where a small code is accepted (taking `negate` into account). */
const acceptTable = (set: CharSet, negate: boolean): Uint8Array => {
  const t = new Uint8Array(TableSize)
  for (let c = 0; c < TableSize; c++) t[c] = (set.table[c] === 1) !== negate ? 1 : 0
  return t
}

/** A literal matched against a string input, returning `value`. */
const stringLiteral = (str: string, value: unknown): Step => {
  const len = str.length
  if (len === 0) return () => value
  if (len === 1) {
    const c0 = str.charCodeAt(0)
    return (s) => {
      const pos = s.pos
      if (pos < s.end && (s.input as string).charCodeAt(pos) === c0) {
        s.pos = pos + 1
        return value
      }
      return fail(s)
    }
  }
  return (s) => {
    const pos = s.pos
    if (s.end - pos >= len && (s.input as string).startsWith(str, pos)) {
      s.pos = pos + len
      return value
    }
    return fail(s)
  }
}

/** A closure compiler for one input kind; it memoizes what it compiles. */
/** The object of `Object.fromEntries`, built an entry at a time (see `internal/entries.ts`). */
class EntriesAcc {
  readonly o: Record<string, unknown> = {}
  deferred: Array<unknown> | undefined = undefined
  add(key: unknown, value: unknown): void {
    if (this.deferred === undefined && isPlainKey(key)) this.o[key] = value
    else this.deferred = addEntry(this.o, this.deferred, key, value)
  }
  result(): object {
    if (this.deferred !== undefined) flushEntries(this.o, this.deferred)
    return this.o
  }
}

export interface ClosureCompiler {
  readonly compile: (p: ParserLike, used: boolean) => Step
  readonly note: (p: ParserLike, node: Node, reason: string) => void
  readonly firsts: FirstSets
  readonly fallbacks: ReadonlyArray<Fallback>
}

export const createClosureCompiler = (kind: 0 | 1 | 2, resumable = false): ClosureCompiler => {
  const compiler = new Compiler(kind, resumable)
  return {
    compile: (p, used) => compiler.compile(p, used),
    note: (p, node, reason) => compiler.note(p, node, reason),
    firsts: compiler.firsts,
    fallbacks: compiler.fallbacks
  }
}

/** Compiles a root parser for one input kind. */
const compileClosure = (
  root: ParserLike,
  kind: 0 | 1 | 2,
  resumable = false
): { readonly step: Step; readonly fallbacks: ReadonlyArray<Fallback> } => {
  const compiler = new Compiler(kind, resumable)
  const step = compiler.compile(root, true)
  return { step, fallbacks: compiler.fallbacks }
}

/** The closure compiler as a backend. */
export const backend: Backend = {
  build: (p, kind, resumable) => {
    try {
      const { fallbacks, step } = compileClosure(p, kind, resumable)
      return { backend: "closure", step, fallbacks, error: undefined }
    } catch (error) {
      return { backend: undefined, step: undefined, fallbacks: [], error }
    }
  }
}
