/**
 * Number conversions shared by the `Ascii` and `Text` parsers and the
 * compilers.
 */
import type { Input } from "../Input.js"
import { Fail } from "../Input.js"
import { latin1 } from "./text.js"

const toText = (s: Input): string =>
  typeof s === "string" ? s : s instanceof Uint8Array ? latin1.text(s, 0, s.length) : s.join("")

/** The value of the text matched by `Ascii.float` and `Text.float`. */
export const toFloat = (s: Input): number => {
  if (typeof s === "string") {
    // Plain decimal notation (as opposed to `inf` or `nan`) ends in a digit or "."
    const last = s.charCodeAt(s.length - 1)
    if ((last >= 48 && last <= 57) || last === 46) return Number(s)
  }
  const t = toText(s).toLowerCase()
  const negative = t.startsWith("-")
  const body = t.startsWith("-") || t.startsWith("+") ? t.slice(1) : t
  if (body === "nan") return NaN
  if (body.startsWith("inf")) return negative ? -Infinity : Infinity
  return Number(t)
}

/**
 * The parsers that `Ascii.float` and `Text.float` map with `toFloat`: the
 * compilers replace them by {@link scanFloatString} and
 * {@link scanFloatBytes} when the text is in decimal notation.
 */
export const floatTexts = /*#__PURE__*/ new WeakSet<object>()

/** Adds a parser to {@link floatTexts}. */
export const floatText = <P extends object>(p: P): P => {
  floatTexts.add(p)
  return p
}

/** The powers of ten that doubles represent exactly. */
const exact = /*#__PURE__*/ Array.from({ length: 23 }, (_, i) => Number(`1e${i}`))

/**
 * Where the latest scan ended, when it succeeded, and the furthest offset it
 * read (when it succeeded or failed): streaming builds re-run the parser
 * when that is near the end of a partial input.
 */
export const floatScan = { end: 0, read: 0 }

const isDigit = (c: number): boolean => c >= 48 && c <= 57

// Exact products of doubles (Dekker), without allocating: `a * b` is
// `productHi + productLo` exactly, barring overflow and underflow
const Split = 134217729 // 2^27 + 1
let productHi = 0
let productLo = 0
const twoProduct = (a: number, b: number): void => {
  const p = a * b
  let t = Split * a
  const ah = t - (t - a)
  const al = a - ah
  t = Split * b
  const bh = t - (t - b)
  const bl = b - bh
  productHi = p
  productLo = ((ah * bh - p) + ah * bl + al * bh) + al * bl
}

/** 2^-96: a bound on the relative error of {@link decimal}'s 19-digit path. */
const Error19 = 1 / 2 ** 96

/**
 * The double nearest to `±(high * 10^low digits + low) * 10^e10`, where
 * `high` holds the first 15 significant digits, and `low` the next `lowDigits`
 * (at most 4). Returns `undefined` when this can't tell it apart from the
 * neighbouring doubles, for the caller to use `Number`.
 *
 * Up to 15 digits, the digits and a power of ten up to 10^22 are exact
 * doubles, so one multiplication or division rounds correctly (Clinger's
 * fast path). Up to 19 digits, the digits are an exact sum of two doubles,
 * and multiplying or dividing that by an exact power of ten gives the value
 * to within a relative 2^-96 (double-double arithmetic). It is then rounded
 * once, and kept only if the bounds of that error round to the same double:
 * this is never the case for an exact tie, so ties go to `Number` too.
 */
const decimal = (negative: boolean, high: number, low: number, lowDigits: number, e10: number): number | undefined => {
  let v: number
  if (lowDigits === 0) {
    if (e10 > 22 || e10 < -22) return undefined
    v = e10 === 0 ? high : e10 > 0 ? high * exact[e10]! : high / exact[-e10]!
  } else {
    if (e10 > 22 || e10 < -22) return undefined
    // The digits: high * 10^lowDigits + low = wh + wl, exactly
    twoProduct(high, exact[lowDigits]!)
    const wh = productHi + low
    const wl = productLo + (low - (wh - productHi))
    let xh: number
    let xl: number
    if (e10 >= 0) {
      const p = exact[e10]!
      twoProduct(wh, p)
      xh = productHi
      xl = productLo + wl * p
    } else {
      const p = exact[-e10]!
      xh = wh / p
      twoProduct(xh, p)
      xl = ((wh - productHi) - productLo + wl) / p
    }
    v = xh + xl
    const error = (xh < 0 ? -xh : xh) * Error19
    if (xh + (xl + error) !== v || xh + (xl - error) !== v) return undefined
  }
  return negative ? -v : v
}

/**
 * Matches and converts what `Ascii.float` matches at `i`, when it is in
 * decimal notation: an optional sign, then digits or "." (the other forms,
 * `nan` and `inf`, start with a letter). Returns the value, setting
 * `floatScan.end`; `Fail` if the float parser fails there (always with
 * `Backtrack`); or `undefined` if the text does not start like a decimal
 * number, for the caller to run the parser.
 *
 * Numbers with up to 19 significant digits and a decimal exponent up to 22
 * are converted by {@link decimal}, the rest by `Number`, so the value is
 * always what `Number` gives for the text.
 */
export const scanFloatString = (s: string, i: number, end: number): number | Fail | undefined => {
  const start = i
  let c = i < end ? s.charCodeAt(i) : -1
  if (c === 45 || c === 43) {
    c = i + 1 < end ? s.charCodeAt(i + 1) : -1
    if (!isDigit(c) && c !== 46) return undefined
    i++
  } else if (!isDigit(c) && c !== 46) {
    return undefined
  }
  // The first 15 significant digits, the next 4, how many there are in all,
  // and the decimal exponent of the last one kept
  let high = 0
  let low = 0
  let digits = 0
  let e10 = 0
  if (c !== 46) {
    do {
      if (digits < 15) {
        if (high !== 0 || c !== 48) {
          high = high * 10 + (c - 48)
          digits++
        }
      } else {
        if (digits < 19) low = low * 10 + (c - 48)
        else e10++
        digits++
      }
      c = ++i < end ? s.charCodeAt(i) : -1
    } while (isDigit(c))
    if (c === 46) c = ++i < end ? s.charCodeAt(i) : -1
  } else {
    // "." must be followed by a digit
    c = ++i < end ? s.charCodeAt(i) : -1
    if (!isDigit(c)) {
      floatScan.read = i
      return Fail
    }
  }
  while (isDigit(c)) {
    if (digits < 15) {
      if (high !== 0 || c !== 48) {
        high = high * 10 + (c - 48)
        digits++
      }
      e10--
    } else {
      if (digits < 19) {
        low = low * 10 + (c - 48)
        e10--
      }
      digits++
    }
    c = ++i < end ? s.charCodeAt(i) : -1
  }
  let read = i
  if (c === 101 || c === 69) {
    // The exponent is optional: without digits, it is not consumed
    let j = i + 1
    c = j < end ? s.charCodeAt(j) : -1
    const negative = c === 45
    if (negative || c === 43) c = ++j < end ? s.charCodeAt(j) : -1
    if (isDigit(c)) {
      let e = 0
      do {
        // Past this, the number can only overflow or underflow
        if (e < 1e6) e = e * 10 + (c - 48)
        c = ++j < end ? s.charCodeAt(j) : -1
      } while (isDigit(c))
      e10 += negative ? -e : e
      i = j
    }
    read = j
  }
  floatScan.end = i
  floatScan.read = read
  const negative = s.charCodeAt(start) === 45
  if (high === 0) return negative ? -0 : 0
  const v = digits > 19 ? undefined : decimal(negative, high, low, digits > 15 ? digits - 15 : 0, e10)
  return v === undefined ? Number(s.slice(start, i)) : v
}

/** {@link scanFloatString} on bytes, or the units of an ASCII compatible encoding. */
export const scanFloatBytes = (b: Uint8Array, i: number, end: number): number | Fail | undefined => {
  const start = i
  let c = i < end ? b[i]! : -1
  if (c === 45 || c === 43) {
    c = i + 1 < end ? b[i + 1]! : -1
    if (!isDigit(c) && c !== 46) return undefined
    i++
  } else if (!isDigit(c) && c !== 46) {
    return undefined
  }
  let high = 0
  let low = 0
  let digits = 0
  let e10 = 0
  if (c !== 46) {
    do {
      if (digits < 15) {
        if (high !== 0 || c !== 48) {
          high = high * 10 + (c - 48)
          digits++
        }
      } else {
        if (digits < 19) low = low * 10 + (c - 48)
        else e10++
        digits++
      }
      c = ++i < end ? b[i]! : -1
    } while (isDigit(c))
    if (c === 46) c = ++i < end ? b[i]! : -1
  } else {
    c = ++i < end ? b[i]! : -1
    if (!isDigit(c)) {
      floatScan.read = i
      return Fail
    }
  }
  while (isDigit(c)) {
    if (digits < 15) {
      if (high !== 0 || c !== 48) {
        high = high * 10 + (c - 48)
        digits++
      }
      e10--
    } else {
      if (digits < 19) {
        low = low * 10 + (c - 48)
        e10--
      }
      digits++
    }
    c = ++i < end ? b[i]! : -1
  }
  let read = i
  if (c === 101 || c === 69) {
    let j = i + 1
    c = j < end ? b[j]! : -1
    const negative = c === 45
    if (negative || c === 43) c = ++j < end ? b[j]! : -1
    if (isDigit(c)) {
      let e = 0
      do {
        if (e < 1e6) e = e * 10 + (c - 48)
        c = ++j < end ? b[j]! : -1
      } while (isDigit(c))
      e10 += negative ? -e : e
      i = j
    }
    read = j
  }
  floatScan.end = i
  floatScan.read = read
  const negative = b[start] === 45
  if (high === 0) return negative ? -0 : 0
  const v = digits > 19 ? undefined : decimal(negative, high, low, digits > 15 ? digits - 15 : 0, e10)
  return v === undefined ? Number(asciiText(b, start, i)) : v
}

/** The text of ASCII bytes. */
const asciiText = (b: Uint8Array, start: number, end: number): string =>
  String.fromCharCode.apply(null, b.subarray(start, end) as unknown as Array<number>)
