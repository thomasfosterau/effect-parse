/**
 * The JSON grammar of `examples/json.ts` fused by hand into straight-line
 * code: one function per rule, inlined `charCodeAt` tests, no intermediate
 * values and a failure sentinel only. It is the reference point for the
 * compiled parsers in `json.bench.ts`, not a supported parser: it returns
 * `undefined` on any error.
 */
const FAIL = undefined

let s = ""
let p = 0

const ws = () => {
  let c = s.charCodeAt(p)
  while (c === 32 || c === 10 || c === 13 || c === 9) c = s.charCodeAt(++p)
}

const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)

const hex4 = (): number => {
  if (p + 4 > s.length) return -1
  for (let i = 0; i < 4; i++) if (!isHex(s.charCodeAt(p + i))) return -1
  const v = parseInt(s.slice(p, p + 4), 16)
  p += 4
  return v
}

const string = (): string | undefined => {
  // at the opening quote
  p++
  let out = ""
  while (true) {
    const start = p
    let c = s.charCodeAt(p)
    while (p < s.length && c !== 34 && c !== 92 && c >= 32) c = s.charCodeAt(++p)
    if (p > start) out += s.slice(start, p)
    if (p >= s.length) return FAIL
    if (c === 34) {
      p++
      return out
    }
    if (c !== 92) return FAIL
    p++
    const e = s.charCodeAt(p++)
    switch (e) {
      case 34:
        out += '"'
        break
      case 92:
        out += "\\"
        break
      case 47:
        out += "/"
        break
      case 98:
        out += "\b"
        break
      case 102:
        out += "\f"
        break
      case 110:
        out += "\n"
        break
      case 114:
        out += "\r"
        break
      case 116:
        out += "\t"
        break
      case 117: {
        const hi = hex4()
        if (hi < 0) return FAIL
        if (hi >= 0xd800 && hi <= 0xdbff) {
          if (s.charCodeAt(p) !== 92 || s.charCodeAt(p + 1) !== 117) return FAIL
          p += 2
          const lo = hex4()
          if (lo < 0xdc00 || lo > 0xdfff) return FAIL
          out += String.fromCharCode(hi, lo)
        } else {
          out += String.fromCharCode(hi)
        }
        break
      }
      default:
        return FAIL
    }
  }
}

const digits = () => {
  const start = p
  let c = s.charCodeAt(p)
  while (c >= 48 && c <= 57) c = s.charCodeAt(++p)
  return p > start
}

const number = (): number | undefined => {
  const start = p
  let c = s.charCodeAt(p)
  if (c === 43 || c === 45) c = s.charCodeAt(++p)
  if (c === 46) {
    p++
    if (!digits()) return FAIL
  } else {
    if (!digits()) return FAIL
    if (s.charCodeAt(p) === 46) {
      p++
      digits()
    }
  }
  c = s.charCodeAt(p)
  if (c === 101 || c === 69) {
    const save = p
    c = s.charCodeAt(++p)
    if (c === 43 || c === 45) p++
    if (!digits()) p = save
  }
  const n = Number(s.slice(start, p))
  return Number.isFinite(n) ? n : FAIL
}

const value = (): unknown => {
  let v: unknown
  switch (s.charCodeAt(p)) {
    case 110:
      if (!s.startsWith("null", p)) return FAIL
      p += 4
      v = null
      break
    case 116:
      if (!s.startsWith("true", p)) return FAIL
      p += 4
      v = true
      break
    case 102:
      if (!s.startsWith("false", p)) return FAIL
      p += 5
      v = false
      break
    case 34:
      v = string()
      break
    case 91: {
      p++
      ws()
      const out: Array<unknown> = []
      if (s.charCodeAt(p) !== 93) {
        while (true) {
          const x = value()
          if (x === FAIL) return FAIL
          out.push(x)
          if (s.charCodeAt(p) !== 44) break
          p++
          ws()
        }
      }
      if (s.charCodeAt(p) !== 93) return FAIL
      p++
      v = out
      break
    }
    case 123: {
      p++
      ws()
      const out: Record<string, unknown> = {}
      if (s.charCodeAt(p) === 34) {
        while (true) {
          const k = string()
          if (k === FAIL) return FAIL
          ws()
          if (s.charCodeAt(p) !== 58) return FAIL
          p++
          ws()
          const x = value()
          if (x === FAIL) return FAIL
          out[k] = x
          if (s.charCodeAt(p) !== 44) break
          p++
          ws()
          if (s.charCodeAt(p) !== 34) return FAIL
        }
      }
      if (s.charCodeAt(p) !== 125) return FAIL
      p++
      v = out
      break
    }
    default:
      v = number()
  }
  if (v === FAIL) return FAIL
  ws()
  return v
}

export const parseFused = (input: string): unknown => {
  s = input
  p = 0
  ws()
  const v = value()
  return p === s.length ? v : FAIL
}
