// fallow-ignore-file duplicate-export -- `End` and `scan` here are the token-set versions of the text
// helpers in ./text.ts; both are internal modules, imported by path, never re-exported from one barrel.
import * as Predicate from "effect/Predicate"
import type { Input, State } from "../Input.js"
import { charOf, firstCodePoint } from "./text.js"

/** A compiled token set. */
export interface Matcher {
  /** Tests a code point (string input) or a byte (Uint8Array input). */
  readonly code: (code: number) => boolean
  /** Tests an element of an array input. */
  readonly token: (token: unknown) => boolean
  /** Human readable description, used in error messages. */
  readonly description: string
}

/** @internal */
export interface TokenRangeLike {
  readonly _tag: "TokenRange"
  readonly from: string | number
  readonly to: string | number
}

const isRange = (u: unknown): u is TokenRangeLike => Predicate.isObjectOrArray(u) && (u as any)._tag === "TokenRange"

const toCode = (u: string | number): number => (Predicate.isNumber(u) ? u : firstCodePoint(u))

/** @internal */
export const describeChar = (s: string): string => JSON.stringify(s)

const describeSet = (u: unknown): string => {
  if (Predicate.isString(u)) {
    const chars = Array.from(u)
    return chars.length === 1 ? describeChar(u) : `one of ${JSON.stringify(u)}`
  }
  if (Predicate.isNumber(u)) return `0x${u.toString(16).padStart(2, "0")}`
  if (Predicate.isFunction(u)) return u.name ? u.name : "a matching token"
  if (u instanceof Uint8Array) return `one of ${describeBytes(u)}`
  if (isRange(u)) return `${describeSet(u.from)}..=${describeSet(u.to)}`
  if (Array.isArray(u)) return u.map(describeSet).join(" or ")
  return JSON.stringify(u)
}

/** Renders bytes as a Rust-style byte string literal: b"GET\r\n". */
const describeBytes = (bytes: Uint8Array): string => {
  let out = 'b"'
  for (const b of bytes) {
    if (b === 0x22) out += '\\"'
    else if (b === 0x5c) out += "\\\\"
    else if (b === 0x0a) out += "\\n"
    else if (b === 0x0d) out += "\\r"
    else if (b === 0x09) out += "\\t"
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b)
    else out += `\\x${b.toString(16).padStart(2, "0")}`
  }
  return out + '"'
}

const compileCode = (u: unknown): ((code: number) => boolean) => {
  if (Predicate.isString(u)) {
    const codes = Array.from(u, firstCodePoint)
    if (codes.length === 1) {
      const c = codes[0]
      return (x) => x === c
    }
    return bitmap(codes)
  }
  if (Predicate.isNumber(u)) return (x) => x === u
  if (Predicate.isFunction(u)) return u as (code: number) => boolean
  if (u instanceof Uint8Array) return bitmap(Array.from(u))
  if (isRange(u)) {
    const from = toCode(u.from)
    const to = toCode(u.to)
    return (x) => x >= from && x <= to
  }
  if (Array.isArray(u)) {
    const tests = u.map(compileCode)
    if (tests.length === 1) return tests[0]
    return (x) => {
      for (let i = 0; i < tests.length; i++) if (tests[i](x)) return true
      return false
    }
  }
  throw new TypeError(`invalid token set: ${String(u)}`)
}

const bitmap = (codes: ReadonlyArray<number>): ((code: number) => boolean) => {
  const ascii = new Uint8Array(256)
  let other: Set<number> | undefined
  for (const c of codes) {
    if (c < 256) ascii[c] = 1
    else (other ??= new Set()).add(c)
  }
  if (other === undefined) return (x) => x < 256 && ascii[x] === 1
  const set = other
  return (x) => (x < 256 ? ascii[x] === 1 : set.has(x))
}

const compileToken = (u: unknown): ((token: unknown) => boolean) => {
  if (Predicate.isFunction(u)) return u as (token: unknown) => boolean
  if (Array.isArray(u)) {
    const set = new Set(u)
    return (t) => set.has(t)
  }
  return (t) => t === u
}

/**
 * Marks a predicate over characters that also accepts a code point (a
 * number), so string inputs can call it without allocating a string per
 * character.
 */
const CodePointPredicate: unique symbol = /*#__PURE__*/ Symbol.for("effect-parse/CodePointPredicate")

/**
 * The code points accepted by a predicate, as sorted, disjoint, inclusive
 * ranges, when they are known. The compiler turns such predicates into
 * comparisons or tables.
 */
export const PredicateRanges: unique symbol = /*#__PURE__*/ Symbol.for("effect-parse/PredicateRanges")

/**
 * Marks `f` as a {@link CodePointPredicate} named `name` (used in error
 * messages), optionally recording the code point ranges it accepts.
 */
export const codePointPredicate = <F extends (c: never) => boolean>(
  name: string,
  f: F,
  ranges?: ReadonlyArray<readonly [number, number]>
): F => {
  Object.defineProperty(f, "name", { value: name })
  ;(f as any)[CodePointPredicate] = true
  if (ranges !== undefined) (f as any)[PredicateRanges] = ranges
  return f
}

/**
 * Compiles a token set. Predicates for string inputs receive the token as a
 * string, so they are wrapped here; `charOf` avoids `String.fromCodePoint`,
 * which is several times slower, for the Basic Multilingual Plane.
 */
export const compile = (set: unknown, kind: "string" | "code" = "code"): Matcher => {
  const description = describeSet(set)
  let code: (code: number) => boolean
  if (Predicate.isFunction(set) && kind === "string" && !(CodePointPredicate in set)) {
    const pred = set as (c: string) => boolean
    code = (x) => pred(charOf(x))
  } else {
    code = compileCodeSafe(set, kind)
  }
  return { code, token: compileToken(set), description }
}

const compileCodeSafe = (set: unknown, kind: "string" | "code"): ((code: number) => boolean) => {
  if (Array.isArray(set) && kind === "string") {
    // Predicates nested in arrays also take strings
    const tests = set.map((s) => compile(s, kind).code)
    return (x) => {
      for (let i = 0; i < tests.length; i++) if (tests[i](x)) return true
      return false
    }
  }
  try {
    return compileCode(set)
  } catch {
    return () => false
  }
}

/**
 * A matcher that works for every input kind. String predicates receive the
 * token as a string, byte predicates receive numbers.
 */
export interface AnyMatcher {
  readonly forString: Matcher
  readonly forCode: Matcher
  readonly description: string
}

/**
 * A small cache keyed by value, for the parts of a parser that are costly to
 * build and depend only on a string (compiled sets, descriptions). Parsers
 * built inside `Parser.gen` bodies are rebuilt on every run, usually from the
 * same few strings. Dynamic strings could grow it without bound, so it is
 * cleared when full.
 */
const cached = <A>(cache: Map<string, A>, key: string, build: (key: string) => A): A => {
  let a = cache.get(key)
  if (a === undefined) {
    if (cache.size >= 1024) cache.clear()
    a = build(key)
    cache.set(key, a)
  }
  return a
}

const literalDescriptions = /*#__PURE__*/ new Map<string, string>()

/** Describes a literal for error messages: `"abc"`, `b"abc"` or `["a", 1]`. */
export const describeLiteral = (lit: Input): string =>
  Predicate.isString(lit)
    ? cached(literalDescriptions, lit, describeChar)
    : lit instanceof Uint8Array
      ? describeBytes(lit)
      : `[${lit.map((t) => JSON.stringify(t)).join(", ")}]`

const stringMatchers = /*#__PURE__*/ new Map<string, AnyMatcher>()

export const compileAny = (set: unknown): AnyMatcher =>
  // Matchers for strings are pure functions of the string, so they're shared
  Predicate.isString(set) ? cached(stringMatchers, set, compileAnyImpl) : compileAnyImpl(set)

const compileAnyImpl = (set: unknown): AnyMatcher => {
  const forCode = compile(set, "code")
  const needsString = Predicate.isFunction(set) || Array.isArray(set)
  return {
    forString: needsString ? compile(set, "string") : forCode,
    forCode,
    description: forCode.description
  }
}

/**
 * Whether the string token at `i` is a high surrogate at the very end of a
 * partial input, i.e. the first half of a code point whose second half has
 * not arrived yet.
 */
export const splitSurrogate = (state: State<Input>, i: number): boolean => {
  if (!state.partial || i !== state.end - 1) return false
  const c = (state.input as string).charCodeAt(i)
  return c >= 0xd800 && c <= 0xdbff
}

/** Reads the code point at `i` of a string. */
const codePointAt = (s: string, i: number): number => {
  const c = s.charCodeAt(i)
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1)
    if (d >= 0xdc00 && d <= 0xdfff) return ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000
  }
  return c
}

/**
 * Tests the token at the current position. Returns the token (as the input's
 * token type) and advances, or returns `NoMatch`/`End`.
 */
export const NoMatch: unique symbol = /*#__PURE__*/ Symbol("NoMatch")
export const End: unique symbol = /*#__PURE__*/ Symbol("End")

export const nextIf = (state: State<Input>, m: AnyMatcher, negate: boolean): unknown => {
  const pos = state.pos
  if (pos >= state.end) return End
  switch (state.inputKind) {
    case 0: {
      const s = state.input as string
      if (splitSurrogate(state, pos)) return End
      const cp = codePointAt(s, pos)
      if (m.forString.code(cp) === negate) return NoMatch
      const len = cp > 0xffff ? 2 : 1
      state.pos = pos + len
      return len === 1 ? s[pos] : s.slice(pos, pos + 2)
    }
    case 1: {
      const b = (state.input as Uint8Array)[pos]
      if (m.forCode.code(b) === negate) return NoMatch
      state.pos = pos + 1
      return b
    }
    default: {
      const t = (state.input as ReadonlyArray<unknown>)[pos]
      if (m.forCode.token(t) === negate) return NoMatch
      state.pos = pos + 1
      return t
    }
  }
}

/**
 * Scans forward while tokens satisfy the matcher (xor `negate`), up to `max`
 * tokens. Returns the offset reached, the number of tokens matched, and
 * whether the end of input was hit before `max` tokens.
 */
export const scan = (
  state: State<Input>,
  m: AnyMatcher,
  negate: boolean,
  max: number
): { readonly offset: number; readonly count: number; readonly hitEnd: boolean } => {
  let i = state.pos
  const end = state.end
  let count = 0
  switch (state.inputKind) {
    case 0: {
      const s = state.input as string
      const test = m.forString.code
      while (count < max) {
        if (i >= end) return { offset: i, count, hitEnd: true }
        const c = s.charCodeAt(i)
        if (c < 0xd800 || c > 0xdbff) {
          if (test(c) === negate) break
          i++
        } else {
          if (splitSurrogate(state, i)) return { offset: i, count, hitEnd: true }
          const cp = codePointAt(s, i)
          if (test(cp) === negate) break
          i += cp > 0xffff ? 2 : 1
        }
        count++
      }
      return { offset: i, count, hitEnd: false }
    }
    case 1: {
      const bytes = state.input as Uint8Array
      const test = m.forCode.code
      while (count < max) {
        if (i >= end) return { offset: i, count, hitEnd: true }
        if (test(bytes[i]) === negate) break
        i++
        count++
      }
      return { offset: i, count, hitEnd: false }
    }
    default: {
      const arr = state.input as ReadonlyArray<unknown>
      const test = m.forCode.token
      while (count < max) {
        if (i >= end) return { offset: i, count, hitEnd: true }
        if (test(arr[i]) === negate) break
        i++
        count++
      }
      return { offset: i, count, hitEnd: false }
    }
  }
}

/** Advances `n` tokens from `start`, returning the offset reached and the count. */
export const advance = (state: State<Input>, start: number, n: number): { offset: number; count: number } => {
  if (state.inputKind !== 0) {
    const offset = Math.min(state.end, start + n)
    return { offset, count: offset - start }
  }
  const s = state.input as string
  let i = start
  let count = 0
  while (count < n && i < state.end) {
    if (splitSurrogate(state, i)) break
    const c = s.charCodeAt(i)
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1
    count++
  }
  return { offset: i, count }
}

/** Counts tokens between two offsets. */
export const countTokens = (state: State<Input>, start: number, end: number): number => {
  if (state.inputKind !== 0) return end - start
  const s = state.input as string
  let count = 0
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < end && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i++
    count++
  }
  return count
}

/** Finds `needle` within `[from, state.end)`; returns -1 if absent. */
export const indexOf = (state: State<Input>, needle: Input, from: number): number => {
  // The whole needle must lie before `state.end`, which may narrow the input
  const last = state.end - needle.length
  if (from > last) return -1
  switch (state.inputKind) {
    case 0: {
      const i = (state.input as string).indexOf(needle as string, from)
      return i <= last ? i : -1
    }
    case 1: {
      const hay = state.input as Uint8Array
      const n = needle as Uint8Array
      if (n.byteLength === 0) return from
      const first = n[0]
      let i = hay.indexOf(first, from)
      while (i !== -1 && i <= last) {
        let j = 1
        while (j < n.length && hay[i + j] === n[j]) j++
        if (j === n.length) return i
        i = hay.indexOf(first, i + 1)
      }
      return -1
    }
    default: {
      const hay = state.input as ReadonlyArray<unknown>
      const n = needle as ReadonlyArray<unknown>
      outer: for (let i = from; i <= last; i++) {
        for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer
        return i
      }
      return -1
    }
  }
}

/**
 * Compares the input at the current position with a literal. Returns the
 * number of matching units if the literal matches completely (its length),
 * -1 on mismatch, or -2 when the input ends while matching a prefix.
 */
export const matchLiteral = (state: State<Input>, lit: Input, caseless: boolean): number => {
  const r = match(state, lit, caseless)
  // A failed match may have read up to its length past where it fails (see `Syntax`)
  if (r < 0 && state.syntax !== undefined) state.syntax.read(state.pos + Math.min(lit.length, state.end - state.pos))
  return r
}

const match = (state: State<Input>, lit: Input, caseless: boolean): number => {
  const pos = state.pos
  const len = lit.length
  const avail = state.end - pos
  const n = Math.min(len, avail)
  switch (state.inputKind) {
    case 0: {
      const s = state.input as string
      const l = lit as string
      if (!caseless) {
        if (avail >= len) return s.startsWith(l, pos) ? len : -1
        return l.startsWith(s.slice(pos)) ? -2 : -1
      }
      for (let i = 0; i < n; i++) {
        if (lowerAscii(s.charCodeAt(pos + i)) !== lowerAscii(l.charCodeAt(i))) return -1
      }
      return n === len ? len : -2
    }
    case 1: {
      const b = state.input as Uint8Array
      const l = lit as Uint8Array
      for (let i = 0; i < n; i++) {
        const x = b[pos + i]
        const y = l[i]
        if (caseless ? lowerAscii(x) !== lowerAscii(y) : x !== y) return -1
      }
      return n === len ? len : -2
    }
    default: {
      const a = state.input as ReadonlyArray<unknown>
      const l = lit as ReadonlyArray<unknown>
      for (let i = 0; i < n; i++) if (a[pos + i] !== l[i]) return -1
      return n === len ? len : -2
    }
  }
}

const lowerAscii = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c)
