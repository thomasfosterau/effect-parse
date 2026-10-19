import type { Encoding } from "../Encoding.js"
import type { Fail, State } from "../Input.js"

// -----------------------------------------------------------------------------
// Decoding results
// -----------------------------------------------------------------------------

/** `Encoding.decode`: the input is malformed. */
export const Invalid = -1
/** `Encoding.decode`: the input ends inside a sequence. */
export const Truncated = -2
/** `next`: the input has ended. */
export const End = -3

// -----------------------------------------------------------------------------
// Encodings
// -----------------------------------------------------------------------------

/**
 * Units below this value decode to themselves with width 1, so hot loops can
 * skip `decode`. Defaults to 0x80 for ASCII compatible encodings.
 */
const FastLimit: unique symbol = /*#__PURE__*/ Symbol.for("effect-parse/Encoding/FastLimit")

/** @internal */
export const fastLimit = (enc: Encoding<any>): number =>
  (enc as any)[FastLimit] ?? (enc.asciiCompatible && enc.unit === 1 ? 0x80 : 0)

const asciiChars: ReadonlyArray<string> = /*#__PURE__*/ Array.from({ length: 128 }, (_, i) => String.fromCharCode(i))

/** `String.fromCodePoint`, with the ASCII characters cached. */
export const charOf = (cp: number): string =>
  cp < 128 ? asciiChars[cp]! : cp < 0x10000 ? String.fromCharCode(cp) : String.fromCodePoint(cp)

const decodeString = (s: string, i: number, end: number): number => {
  const c = s.charCodeAt(i)
  if ((c & 0xf800) !== 0xd800) return c
  if (c <= 0xdbff) {
    if (i + 1 >= end) return Truncated
    const d = s.charCodeAt(i + 1)
    if ((d & 0xfc00) === 0xdc00) return ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000
  }
  return Invalid
}

/**
 * JavaScript strings: UTF-16 code units. Offsets are code-unit indices and
 * slices are `String.prototype.slice`s, so no decoding is needed.
 */
export const string: Encoding<string> = {
  name: "UTF-16",
  unit: 1,
  asciiCompatible: true,
  decode: decodeString,
  width: (cp) => cp > 0xffff ? 2 : 1,
  encode: (text) => text,
  text: (s, start, end) => s.slice(start, end),
  [FastLimit]: 0xd800
} as Encoding<string>

const decodeUtf8 = (b: Uint8Array, i: number, end: number): number => {
  const c = b[i]!
  if (c < 0x80) return c
  if (c < 0xc2) return Invalid
  if (c < 0xe0) {
    if (i + 1 >= end) return Truncated
    const d = b[i + 1]!
    return (d & 0xc0) === 0x80 ? ((c & 0x1f) << 6) | (d & 0x3f) : Invalid
  }
  if (c < 0xf0) {
    if (i + 1 >= end) return Truncated
    const d = b[i + 1]!
    // Reject overlong encodings (E0 80..9F) and surrogates (ED A0..BF)
    if (c === 0xe0 ? d < 0xa0 || d > 0xbf : c === 0xed ? d < 0x80 || d > 0x9f : (d & 0xc0) !== 0x80) return Invalid
    if (i + 2 >= end) return Truncated
    const e = b[i + 2]!
    return (e & 0xc0) === 0x80 ? ((c & 0x0f) << 12) | ((d & 0x3f) << 6) | (e & 0x3f) : Invalid
  }
  if (c < 0xf5) {
    if (i + 1 >= end) return Truncated
    const d = b[i + 1]!
    // Reject overlong encodings (F0 80..8F) and code points above U+10FFFF (F4 90..BF)
    if (c === 0xf0 ? d < 0x90 || d > 0xbf : c === 0xf4 ? d < 0x80 || d > 0x8f : (d & 0xc0) !== 0x80) return Invalid
    if (i + 2 >= end) return Truncated
    const e = b[i + 2]!
    if ((e & 0xc0) !== 0x80) return Invalid
    if (i + 3 >= end) return Truncated
    const f = b[i + 3]!
    return (f & 0xc0) === 0x80 ? ((c & 0x07) << 18) | ((d & 0x3f) << 12) | ((e & 0x3f) << 6) | (f & 0x3f) : Invalid
  }
  return Invalid
}

// Building short strings by hand is several times faster than a
// `TextDecoder` call, which has a high fixed cost.
const SHORT = 24

const utf8Decoder = /*#__PURE__*/ new TextDecoder("utf-8", { ignoreBOM: true })

/**
 * Decodes `b[start, end)`. Some platforms' `TextDecoder` rejects views of a
 * `SharedArrayBuffer`, so those are copied first.
 */
const decodeRange = (decoder: TextDecoder, b: Uint8Array, start: number, end: number): string => {
  const view = b.subarray(start, end)
  return decoder.decode(b.buffer instanceof ArrayBuffer ? view : view.slice())
}
const utf8Encoder = /*#__PURE__*/ new TextEncoder()

/** UTF-8 bytes. */
export const utf8: Encoding<Uint8Array> = {
  name: "UTF-8",
  unit: 1,
  asciiCompatible: true,
  decode: decodeUtf8,
  width: (cp) => cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4,
  encode: (text) => utf8Encoder.encode(text),
  text: (b, start, end) => {
    if (end - start > SHORT) return decodeRange(utf8Decoder, b, start, end)
    let out = ""
    for (let i = start; i < end;) {
      const c = b[i]!
      if (c < 0x80) {
        out += asciiChars[c]
        i++
      } else {
        const cp = decodeUtf8(b, i, end)
        out += cp < 0x10000 ? String.fromCharCode(cp) : String.fromCodePoint(cp)
        i += cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
      }
    }
    return out
  }
}

const makeUtf16 = (littleEndian: boolean): Encoding<Uint8Array> => {
  const lo = littleEndian ? 0 : 1
  const hi = 1 - lo
  let decoder: TextDecoder | undefined
  return {
    name: littleEndian ? "UTF-16LE" : "UTF-16BE",
    unit: 2,
    asciiCompatible: false,
    decode: (b, i, end) => {
      if (i + 1 >= end) return Truncated
      const c = b[i + lo]! | (b[i + hi]! << 8)
      if ((c & 0xf800) !== 0xd800) return c
      if (c > 0xdbff) return Invalid
      if (i + 3 >= end) return Truncated
      const d = b[i + 2 + lo]! | (b[i + 2 + hi]! << 8)
      return (d & 0xfc00) === 0xdc00 ? ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000 : Invalid
    },
    width: (cp) => cp > 0xffff ? 4 : 2,
    encode: (text) => {
      const out = new Uint8Array(text.length * 2)
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        out[2 * i + lo] = c & 0xff
        out[2 * i + hi] = c >> 8
      }
      return out
    },
    text: (b, start, end) => {
      if (end - start <= SHORT * 2) {
        // The range is well formed, so surrogate pairs can be copied unit by unit
        let out = ""
        for (let i = start; i < end; i += 2) out += String.fromCharCode(b[i + lo]! | (b[i + hi]! << 8))
        return out
      }
      decoder ??= new TextDecoder(littleEndian ? "utf-16le" : "utf-16be", { ignoreBOM: true })
      return decodeRange(decoder, b, start, end)
    }
  }
}

/** UTF-16 bytes, little endian. */
export const utf16le: Encoding<Uint8Array> = /*#__PURE__*/ makeUtf16(true)

/** UTF-16 bytes, big endian. */
export const utf16be: Encoding<Uint8Array> = /*#__PURE__*/ makeUtf16(false)

/** ISO-8859-1: every byte is the code point of the same value. */
export const latin1: Encoding<Uint8Array> = {
  name: "ISO-8859-1",
  unit: 1,
  asciiCompatible: true,
  decode: (b, i) => b[i]!,
  width: () => 1,
  encode: (text) => {
    const out = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c > 0xff) throw new RangeError(`${JSON.stringify(text[i])} can't be encoded as ISO-8859-1`)
      out[i] = c
    }
    return out
  },
  text: (b, start, end) => {
    let out = ""
    for (let i = start; i < end; i += 8192) {
      out += String.fromCharCode.apply(null, b.subarray(i, Math.min(end, i + 8192)) as unknown as Array<number>)
    }
    return out
  },
  [FastLimit]: 0x100
} as Encoding<Uint8Array>

// -----------------------------------------------------------------------------
// Reading code points from a State
// -----------------------------------------------------------------------------

/** The width of the code point returned by the latest {@link next}. */
export let width = 0

/**
 * Decodes the code point at the cursor without consuming it. Returns the
 * code point (setting {@link width}), {@link End}, {@link Invalid}, or
 * {@link Truncated} (only for partial input; on complete input a truncated
 * sequence is {@link Invalid}).
 */
export const next = (enc: Encoding<any>, state: State<any>, pos: number = state.pos): number => {
  const end = state.end
  if (pos >= end) return End
  const cp = enc.decode(state.input, pos, end)
  if (cp >= 0) {
    width = enc.width(cp)
    return cp
  }
  return cp === Truncated && !state.partial ? Invalid : cp
}

/**
 * Fails a parser that expected a code point but found `cp` (one of the
 * negative results of {@link next}, or a code point that did not match).
 */
export const failAt = (
  state: State<any>,
  cp: number,
  kind: Parameters<State["backtrack"]>[0],
  expected: ReadonlyArray<string>,
  offset: number = state.pos
): Fail => {
  if (cp === End) return state.eoi(kind, expected, 1)
  if (cp === Truncated) return state.incomplete(1, expected)
  return state.backtrack(kind, expected, offset)
}

// Results of `scan`, kept in module variables to avoid allocating
/** Offset reached by the latest {@link scan}. */
export let scanOffset = 0
/** Number of code points matched by the latest {@link scan}. */
export let scanCount = 0
/**
 * Why the latest {@link scan} stopped: 0 = a non-matching code point or the
 * maximum count, or one of {@link End}, {@link Invalid}, {@link Truncated}.
 */
export let scanStop = 0

/**
 * Scans code points from `pos` while `test(cp) !== negate`, up to `max`
 * code points. `fast` is `fastLimit(enc)`, which callers can precompute.
 */
export const scan = (
  enc: Encoding<any>,
  state: State<any>,
  test: (cp: number) => boolean,
  negate: boolean,
  max: number,
  pos: number = state.pos,
  fast: number = fastLimit(enc)
): void => {
  const end = state.end
  const decode = enc.decode
  let i = pos
  let count = 0
  let stop = 0
  if (state.inputKind === 0) {
    const s = state.input as string
    while (count < max) {
      if (i >= end) {
        stop = End
        break
      }
      const c = s.charCodeAt(i)
      if (c < fast) {
        if (test(c) === negate) break
        i++
      } else {
        const cp = decode(s, i, end)
        if (cp < 0) {
          stop = cp === Truncated && state.partial ? Truncated : Invalid
          break
        }
        if (test(cp) === negate) break
        i += enc.width(cp)
      }
      count++
    }
  } else {
    const b = state.input as Uint8Array
    while (count < max) {
      if (i >= end) {
        stop = End
        break
      }
      const c = b[i]!
      if (c < fast) {
        if (test(c) === negate) break
        i++
      } else {
        const cp = decode(b, i, end)
        if (cp < 0) {
          stop = cp === Truncated && state.partial ? Truncated : Invalid
          break
        }
        if (test(cp) === negate) break
        i += enc.width(cp)
      }
      count++
    }
  }
  scanOffset = i
  scanCount = count
  scanStop = stop
}

const always = () => true

/**
 * Checks that `[start, end)` is well formed, counting its code points.
 * Returns the count, or `-1 - offset` of the first malformed sequence.
 */
export const validate = (enc: Encoding<any>, state: State<any>, start: number, end: number): number => {
  const savedEnd = state.end
  const savedPartial = state.partial
  state.end = end
  state.partial = false
  scan(enc, state, always, false, Infinity, start)
  state.end = savedEnd
  state.partial = savedPartial
  return scanStop === Invalid ? -1 - scanOffset : scanCount
}

// -----------------------------------------------------------------------------
// Case folding
// -----------------------------------------------------------------------------

const foldCache = /*#__PURE__*/ new Map<number, number>()

const single = (s: string): number => {
  const cp = s.codePointAt(0)!
  return s.length === (cp > 0xffff ? 2 : 1) ? cp : -1
}

/**
 * Simple case folding of a code point: the lowercase of its uppercase, when
 * both map to a single code point (so `"K"` (Kelvin) and `"ſ"` fold to `"k"`
 * and `"s"`), otherwise the code point itself.
 */
export const fold = (cp: number): number => {
  if (cp < 128) return cp >= 65 && cp <= 90 ? cp + 32 : cp
  let f = foldCache.get(cp)
  if (f === undefined) {
    const c = String.fromCodePoint(cp)
    const upper = c.toUpperCase()
    const viaUpper = single(upper) >= 0 ? single(upper.toLowerCase()) : -1
    f = viaUpper >= 0 ? viaUpper : single(c.toLowerCase())
    if (f < 0) f = cp
    foldCache.set(cp, f)
  }
  return f
}

// -----------------------------------------------------------------------------
// Error rendering
// -----------------------------------------------------------------------------

/**
 * Walks the code points of `[start, end)` leniently: malformed sequences
 * are reported as `-1` and skipped one code unit at a time.
 */
export const walk = (
  enc: Encoding<any>,
  input: string | Uint8Array,
  start: number,
  end: number,
  f: (cp: number, offset: number, width: number) => boolean | void
): void => {
  let i = start
  while (i < end) {
    let cp = enc.decode(input, i, end)
    let w: number
    if (cp >= 0) {
      w = enc.width(cp)
    } else {
      cp = -1
      w = Math.min(enc.unit, end - i)
    }
    if (f(cp, i, w) === false) return
    i += w
  }
}

/** Decodes `[start, end)`, replacing malformed sequences with U+FFFD. */
export const lenientText = (enc: Encoding<any>, input: string | Uint8Array, start: number, end: number): string => {
  let out = ""
  walk(enc, input, start, end, (cp) => {
    out += cp < 0 ? "�" : charOf(cp)
  })
  return out
}
