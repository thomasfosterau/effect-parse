import { Input } from "@thomasfosterau/effect-parse"
import { Buffer } from "node:buffer"
import * as Arr from "effect/Array"
import * as Order from "effect/Order"
import * as Result from "effect/Result"
import { describe, expect, it } from "vite-plus/test"
import * as Ast from "../src/regex/ast.ts"
import * as CharSet from "../src/regex/charset.ts"
import * as Compile from "../src/regex/compile.ts"
import { LineDfa } from "../src/regex/dfa.ts"
import * as Syntax from "../src/regex/syntax.ts"
import { success } from "./utils.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const flags = Syntax.Flags.Unicode | Syntax.Flags.MultiLine

const backends: ReadonlyArray<Compile.Backend> = ["none", "closure", "jit", "wasm"]

/** The first match of `pattern` in `haystack` with a backend, as text and capture slots. */
const first = (pattern: string, haystack: string, backend: Compile.Backend, extraFlags = 0) => {
  const parsed = success(Syntax.parse(pattern, flags | extraFlags))
  const matcher = Compile.compile(parsed.regex, parsed.names.length, 0x0a, { captures: true, backend, multiline: true })
  const bytes = encoder.encode(haystack)
  const m = matcher.find(new Input.State(bytes), 0)
  if (m === undefined) return undefined
  const groups: Array<string | undefined> = []
  for (let g = 0; g < parsed.names.length; g++) {
    const s = m.groups?.[2 * g] ?? -1
    const e = m.groups?.[2 * g + 1] ?? -1
    groups.push(s < 0 ? undefined : decoder.decode(bytes.subarray(s, e)))
  }
  return { text: decoder.decode(bytes.subarray(m.start, m.end)), start: m.start, groups }
}

// [pattern, haystack, expected first match (undefined: none)], with Rust's
// leftmost-first semantics.
const cases: ReadonlyArray<readonly [string, string, string | undefined]> = [
  ["fo+", "xx foooo", "foooo"],
  ["a*ab", "aaab", "aaab"],
  ["(a|ab)(c|bcd)", "abcd", "abcd"],
  ["(ab|a)(c|bcd)", "abcd", "abc"],
  ["a+?", "aaa", "a"],
  ["a{2,3}", "aaaa", "aaa"],
  ["a{2,3}?", "aaaa", "aa"],
  ["a{2}", "a aa", "aa"],
  ["a{2,}", "aaaaa", "aaaaa"],
  ["(ab)+c", "abababc", "abababc"],
  ["(a*)*b", "aaab", "aaab"],
  ["(a|)+b", "aab", "aab"],
  ["(?:x|y)*?z", "xyxz", "xyxz"],
  ["\\bwor\\w+", "hello world", "world"],
  ["\\Bor\\B", "world", "or"],
  ["\\<wo", "a world", "wo"],
  ["ld\\>", "world!", "ld"],
  ["\\b{start}w", "w", "w"],
  ["o\\b{end}", "hello", "o"],
  ["^b", "a\nb", "b"],
  ["a$", "a\nb", "a"],
  ["(?-m)^b", "a\nb", undefined],
  ["\\Ab", "b", "b"],
  ["a\\z", "ba", "a"],
  ["(?i)HELLO", "say hello", "hello"],
  ["(?i)straße", "STRAẞE", "STRAẞE"],
  ["(?i:a)B", "AB ab aB", "AB"],
  ["a(?i)b|c", "aB C", "aB"],
  ["(?U)a+", "aaa", "a"],
  ["(?U)a+?", "aaa", "aaa"],
  ["(?s).", "\n", "\n"],
  [".", "\n", undefined],
  ["(?x) a  b # comment", "zab", "ab"],
  ["(?x)a\\ b", "a b", "a b"],
  ["(?x)[a b]+", "a a", "a"],
  ["[^\\s]+$", "a bc def", "def"],
  ["[a-z&&[^aeiou]]+", "aeixyz", "xyz"],
  ["[a-z--[aeiou]]+", "aeixyz", "xyz"],
  ["[a-c~~b-d]+", "bcad", "ad"],
  ["[[:alpha:]]+", "12ab3", "ab"],
  ["[[:^digit:]]+", "12ab3", "ab"],
  ["[]a]+", "]a]", "]a]"],
  ["[a-]+", "-a-", "-a-"],
  ["\\p{Greek}+", "abc αβγ", "αβγ"],
  ["\\p{sc=Greek}+", "abc αβγ", "αβγ"],
  ["\\pL+", "12ab", "ab"],
  ["\\P{L}+", "ab12", "12"],
  ["\\p{^L}+", "ab12", "12"],
  ["\\d+", "ab١٢٣", "١٢٣"],
  ["(?-u)\\d+", "ab١٢٣4", "4"],
  ["\\w+", "  naïve ", "naïve"],
  ["\\x41\\x{42}\\u0043\\u{44}\\U00000045", "ABCDE", "ABCDE"],
  ["🦀+", "a🦀🦀", "🦀🦀"],
  ["\\.\\*\\?", "a.*?", ".*?"],
  ["a|", "b", ""],
  ["", "abc", ""],
  ["x*", "abc", ""]
]

describe("regex semantics", () => {
  for (const backend of backends) {
    it(`matches like Rust's regex crate (${backend})`, () => {
      for (const [pattern, haystack, expected] of cases) {
        expect(first(pattern, haystack, backend)?.text, `${pattern} on ${JSON.stringify(haystack)}`).toBe(expected)
      }
    })
  }

  it("records capture groups, named and numbered", () => {
    for (const backend of backends) {
      expect(first("(a|ab)(c|bcd)(d*)", "abcd", backend)?.groups).toEqual(["abcd", "a", "bcd", ""])
      expect(first("(?P<word>\\w+) (?<n>\\d+)", "id 42", backend)?.groups).toEqual(["id 42", "id", "42"])
      expect(first("(a)|(b)", "b", backend)?.groups).toEqual(["b", undefined, "b"])
      expect(first("(ab)+", "ababab", backend)?.groups).toEqual(["ababab", "ab"])
    }
  })

  it("agrees between the interpreter and every compiler on every case", () => {
    for (const [pattern, haystack] of cases) {
      const reference = first(pattern, haystack, "none")
      for (const backend of backends)
        expect(first(pattern, haystack, backend), `${pattern} (${backend})`).toEqual(reference)
    }
  })

  it("rejects malformed patterns", () => {
    for (const bad of [
      "(",
      "a)",
      "[a",
      "a{2",
      "\\q",
      "[z-a]",
      "a{3,2}",
      "\\p{NoSuchProperty}",
      "(?<>a)",
      "(?--i)a",
      "\\x{110000}"
    ]) {
      expect(Result.isFailure(Syntax.parse(bad, flags)), bad).toBe(true)
    }
  })
})

describe("matcher", () => {
  it("finds successive matches from an offset", () => {
    const parsed = success(Syntax.parse("o", flags))
    const matcher = Compile.compile(parsed.regex, 1, 0x0a, { captures: false, backend: "jit", multiline: true })
    const state = new Input.State(encoder.encode("foo boo"))
    const starts: Array<number> = []
    for (let m = matcher.find(state, 0); m !== undefined; m = matcher.find(state, m.end)) starts.push(m.start)
    expect(starts).toEqual([1, 2, 5, 6])
    expect(matcher.matchAt(state, 1)).toBe(2)
    expect(matcher.matchAt(state, 0)).toBe(-1)
  })

  it("reports a pattern that nests past the stack", () => {
    const parsed = success(Syntax.parse("(?:ab|cd)+e", flags))
    const matcher = Compile.compile(parsed.regex, 1, 0x0a, { captures: false, backend: "none", multiline: true })
    const state = new Input.State(encoder.encode("ab".repeat(200_000)))
    expect(matcher.find(state, 0)).toBe(undefined)
    expect(matcher.takeOverflow()).toBe(0)
    expect(matcher.takeOverflow()).toBe(undefined)
  })
})

describe("syntax helpers", () => {
  it("escapes every metacharacter for --fixed-strings", () => {
    const literal = "a.b*c?(d)[e]{f}|g^h$i\\j#k&l-m~n o"
    const parsed = success(Syntax.parse(`(?:${Syntax.escape(literal)})`, flags))
    expect(parsed.regex).toEqual({ _tag: "Literal", text: literal })
  })

  it("detects uppercase literals for --smart-case, ignoring escapes", () => {
    expect(Syntax.hasUppercaseLiteral("Foo")).toBe(true)
    expect(Syntax.hasUppercaseLiteral("foo\\W\\S\\p{Lu}\\D")).toBe(false)
    expect(Syntax.hasUppercaseLiteral("[A-Z]")).toBe(true)
  })

  it("computes minimum lengths", () => {
    const len = (p: string) => {
      const r = Syntax.parse(p, flags)
      return Result.isSuccess(r) ? Ast.minLength(r.success.regex) : -1
    }
    expect(len("abc")).toBe(3)
    expect(len("a*")).toBe(0)
    expect(len("(ab){2}|c")).toBe(1)
    expect(len("^$")).toBe(0)
    expect(len("é")).toBe(2)
  })
})

describe("character sets", () => {
  it("implements the class algebra", () => {
    const az = CharSet.normalize([[0x61, 0x7a]])
    const vowels = CharSet.of(0x61, 0x65, 0x69, 0x6f, 0x75)
    expect(CharSet.difference(az, vowels)).toEqual(CharSet.intersect(az, CharSet.negate(vowels)))
    expect(CharSet.symmetricDifference(az, az)).toEqual([])
    expect(CharSet.union(CharSet.negate(az), az)).toEqual(CharSet.all)
    expect(CharSet.has(CharSet.all, 0xd800)).toBe(false)
    expect(CharSet.single(CharSet.of(0x41))).toBe(0x41)
    expect(CharSet.single(az)).toBe(undefined)
    expect(CharSet.isAscii(az)).toBe(true)
    expect(CharSet.isEmpty(CharSet.none)).toBe(true)
  })

  it("folds case simply, as Rust does", () => {
    expect(Arr.sort(CharSet.caseVariants(0x6b), Order.Number)).toEqual([0x4b, 0x6b, 0x212a])
    expect(CharSet.has(CharSet.caseFold(CharSet.of(0xdf)), 0x1e9e)).toBe(true)
  })

  it("precomputes the Unicode tables this Node computes", () => {
    const word = ["Alphabetic", "M", "Nd", "Pc", "Join_Control"].map((p) => CharSet.unicodeProperty(p) ?? [])
    expect(CharSet.unicodeWord()).toEqual(CharSet.union(...word))
    expect(CharSet.unicodeDigit()).toEqual(CharSet.unicodeProperty("Nd"))
    expect(CharSet.unicodeSpace()).toEqual(CharSet.unicodeProperty("White_Space"))
  })

  it("resolves Unicode property names loosely", () => {
    expect(CharSet.unicodeProperty("Greek")).toEqual(CharSet.unicodeProperty("sc=greek"))
    expect(CharSet.unicodeProperty("gc=Lu")).toEqual(CharSet.unicodeProperty("Lu"))
    expect(CharSet.unicodeProperty("scx=Hira")).not.toBe(undefined)
    expect(CharSet.unicodeProperty("any")).toEqual(CharSet.all)
    expect(CharSet.unicodeProperty("whitespace")).toEqual(CharSet.unicodeSpace())
    expect(CharSet.unicodeProperty("nope=x")).toBe(undefined)
    expect(CharSet.unicodeProperty("NoSuchThing")).toBe(undefined)
  })
})

/**
 * Lines of very different lengths, over several batches, so the batched
 * search's stretches finish unevenly and take over each other's lines.
 */
const randomLines = (lines: ReadonlyArray<string>): string => {
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  return Array.from({ length: 12000 }, () => {
    const line = lines[Math.floor(random() * lines.length)] ?? ""
    return random() < 0.02 ? line.repeat(400) : line
  }).join("\n")
}

/** The DFA's hits, one line at a time. */
const lineByLine = (dfa: LineDfa | undefined, bytes: Buffer): Array<number> => {
  const hits: Array<number> = []
  for (let p = 0; p <= bytes.length;) {
    const nl = bytes.indexOf(0x0a, p)
    const hit = dfa?.find(bytes, p, nl < 0 ? bytes.length : nl) ?? -1
    // A line that reads to the end of the input reports a match there, as the empty line after it does.
    if (hit >= 0 && hits.at(-1) !== hit) hits.push(hit)
    if (nl < 0) break
    p = nl + 1
  }
  return hits
}

/** The DFA's hits, a batch at a time. */
const batched = (dfa: LineDfa | undefined, bytes: Buffer): Array<number> => {
  const hits: Array<number> = []
  for (let hit = dfa?.findLine(bytes, 0) ?? -1; hit >= 0;) {
    hits.push(hit)
    const nl = hit >= bytes.length ? -1 : bytes.indexOf(0x0a, hit)
    hit = nl < 0 ? -1 : (dfa?.findLine(bytes, nl + 1) ?? -1)
  }
  return hits
}

describe("line DFA", () => {
  const lines = [
    "fn evidence_193(foo_bar: &str) -> Result<Clue, Error> { x(12) }",
    "Sherlock Holmes and Dr. Watson at 221B Baker Street",
    "naïve café Ωμέγα λόγος 日本語 🦀 straße STRASSE",
    "",
    "    indented TODO: parse_input(42)",
    "x",
    "aaab ab abab",
    "tab\there; end$",
    "123.45.67.89 10.0.0.1"
  ]
  const patterns = [
    "\\w+_\\w+\\(\\d+\\)",
    "[a-z]+@[a-z]+\\.com",
    "\\p{Greek}+",
    "^\\s+\\w",
    "\\w+$",
    "^$",
    "^x$",
    "(?i)straße",
    "a*ab",
    "(ab)+",
    "\\d{1,3}\\.\\d{1,3}",
    "[^\\x00-\\x7F]+",
    "Sherlock|Watson",
    "x*",
    "^",
    "$",
    "[[:upper:]]{2,}",
    "(?:a|b)*c"
  ]
  it("leaves word boundaries to the matcher", () => {
    for (const pattern of ["e\\b", "\\bword", "\\Bor", "\\<a"]) {
      expect(LineDfa.make(success(Syntax.parse(pattern, flags)).regex, 0x0a), pattern).toBe(undefined)
    }
  })

  it("finds a match in exactly the lines the matcher does", () => {
    for (const pattern of patterns) {
      const parsed = success(Syntax.parse(`(?:${pattern})`, flags))
      const dfa = LineDfa.make(parsed.regex, 0x0a)
      expect(dfa, pattern).toBeDefined()
      const matcher = Compile.compile(parsed.regex, 1, 0x0a, { captures: false, backend: "none", multiline: true })
      for (const line of lines) {
        const bytes = encoder.encode(`${line}\n`)
        const expected = matcher.find(new Input.State(bytes), 0)
        const hit = dfa?.find(bytes, 0, bytes.length - 1) ?? -1
        const inLine = expected !== undefined && expected.start < bytes.length
        expect(hit >= 0 && hit < bytes.length, `${pattern} on ${JSON.stringify(line)}`).toBe(inLine)
      }
    }
  })

  it("finds the same lines a batch at a time as one line at a time", () => {
    // As outside multiline mode, where no class matches the line terminator.
    const banned = CharSet.of(0x0a)
    const body = randomLines(lines)
    for (const pattern of patterns) {
      const parsed = success(Syntax.parse(`(?:${pattern})`, flags))
      const regex = Ast.mapClasses(parsed.regex, (set) => CharSet.difference(set, banned))
      for (const text of [`${body}\n`, body]) {
        const bytes = Buffer.from(text)
        const expected = lineByLine(LineDfa.make(regex, 0x0a), bytes)
        expect(batched(LineDfa.make(regex, 0x0a), bytes), pattern).toEqual(expected)
      }
    }
  })

  it("finds matches in the same lines with the line search as with the match search", () => {
    const banned = CharSet.of(0x0a)
    const bytes = Buffer.from(`${randomLines(lines)}\n`)
    const lineOf = (o: number) => (o === 0 ? 0 : bytes.lastIndexOf(0x0a, o - 1) + 1)
    const linesBy = (search: (state: Input.State<Uint8Array>, from: number) => Compile.Match | undefined) => {
      const found: Array<number> = []
      const state = new Input.State<Uint8Array>(bytes)
      for (let m = search(state, 0); m !== undefined;) {
        found.push(lineOf(m.start))
        const nl = bytes.indexOf(0x0a, m.start)
        m = nl < 0 ? undefined : search(state, nl + 1)
      }
      return found
    }
    for (const pattern of [...patterns, "Sherlock Holmes", "(?i)sherlock holmes", "parse_\\w+"]) {
      const parsed = success(Syntax.parse(`(?:${pattern})`, flags))
      const regex = Ast.mapClasses(parsed.regex, (set) => CharSet.difference(set, banned))
      const options = { captures: false, backend: "none", multiline: false } as const
      const matcher = Compile.compile(regex, 1, 0x0a, options)
      const findLine = matcher.findLine
      if (findLine === undefined) continue
      expect(linesBy(findLine), pattern).toEqual(linesBy(matcher.find))
    }
  })

  it("finds the same matches from the reversed regex's starts as from every start", () => {
    // Multiline mode searches without the line DFAs; with no class matching
    // the terminator, it finds the same matches.
    const banned = CharSet.of(0x0a)
    const bytes = Buffer.from(`${randomLines(lines).slice(0, 200_000)}\n`)
    const all = (matcher: Compile.Matcher) => {
      const found: Array<string> = []
      const state = new Input.State<Uint8Array>(bytes)
      for (let m = matcher.find(state, 0); m !== undefined;) {
        found.push(`${m.start}-${m.end}`)
        m = matcher.find(state, m.end === m.start ? m.end + 1 : m.end)
      }
      return found
    }
    for (const pattern of [...patterns, "(?i)sherlock holmes", "[a-z]+_\\w+\\(", "\\d+\\.\\d+|\\w+"]) {
      const parsed = success(Syntax.parse(`(?:${pattern})`, flags))
      const regex = Ast.mapClasses(parsed.regex, (set) => CharSet.difference(set, banned))
      const lined = Compile.compile(regex, 1, 0x0a, { captures: false, backend: "none", multiline: false })
      const plain = Compile.compile(regex, 1, 0x0a, { captures: false, backend: "none", multiline: true })
      expect(all(lined), pattern).toEqual(all(plain))
    }
  })

  it("searches several lines, from mid-line, to the end of the text", () => {
    const parsed = success(Syntax.parse("(?:b+$)", flags))
    const dfa = LineDfa.make(parsed.regex, 0x0a)
    const text = encoder.encode("abc\nab\nzz\nxb")
    expect(dfa?.find(text, 0, text.length)).toBe(6)
    expect(dfa?.find(text, 7, text.length)).toBe(text.length)
    expect(dfa?.find(text, 0, 3)).toBe(-1)
  })
})
