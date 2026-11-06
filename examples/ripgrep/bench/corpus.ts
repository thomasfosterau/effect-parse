/**
 * A deterministic corpus for the differential tests and the benchmarks: a
 * directory tree of source-like text in several languages, with the files
 * ripgrep treats specially (ignore files, hidden files, a binary file, a
 * UTF-16 file, long lines, CRLF line endings).
 *
 * @since 0.0.0
 */
import * as Fs from "node:fs"
import * as Path from "node:path"

/** A small, seeded PRNG (mulberry32), so every run builds the same corpus. */
const random = (seed: number) => {
  let a = seed >>> 0
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const words = [
  "parser",
  "token",
  "stream",
  "input",
  "offset",
  "error",
  "result",
  "value",
  "match",
  "search",
  "buffer",
  "line",
  "column",
  "effect",
  "context",
  "layer",
  "service",
  "schema",
  "string",
  "number",
  "array",
  "record",
  "option",
  "either",
  "struct",
  "class",
  "function",
  "return",
  "const",
  "let",
  "async",
  "await",
  "yield",
  "Sherlock",
  "Holmes",
  "Watson",
  "Moriarty",
  "Baker",
  "Street",
  "detective",
  "mystery",
  "clue",
  "evidence",
  "naïve",
  "café",
  "Ωμέγα",
  "λόγος",
  "日本語",
  "テキスト",
  "русский",
  "текст",
  "emoji",
  "🦀",
  "ß",
  "ẞ",
  "Straße"
]

const identifiers = ["fooBar", "foo_bar", "FOO_BAR", "x1", "y2", "zeta", "alpha_beta", "parseInput", "runEffect"]

/**
 * The shape of a generated corpus.
 *
 * @since 0.0.0
 */
export interface CorpusOptions {
  /** Number of ordinary text files. */
  readonly files: number
  /** Lines per file. */
  readonly lines: number
  readonly seed: number
}

const languages: ReadonlyArray<readonly [string, (pick: () => string, n: () => number) => string]> = [
  ["ts", (w, n) => `export const ${w()}_${n()} = (${w()}: number) => ${w()}.${w()}(${n()}) // TODO ${w()} ${w()}`],
  ["rs", (w, n) => `fn ${w()}_${n()}(${w()}: &str) -> Result<${w()}, Error> { ${w()}(${n()}) } // FIXME ${w()}`],
  ["py", (w, n) => `def ${w()}_${n()}(${w()}, ${w()}=${n()}):  # ${w()} ${w()} ${w()}`],
  ["md", (w) => `${w()} ${w()} ${w()}, ${w()} ${w()}. ${w()} ${w()} ${w()} ${w()}!`],
  ["txt", (w, n) => `${w()} ${n()} ${w()} ${w()}\t${w()} ${w()} ${w()}@example.com ${n()}.${n()}.${n()}.${n()}`]
]

/**
 * Writes the corpus under `root` (replacing it) and returns `root`.
 *
 * @example
 * ```ts
 * import * as Corpus from "./corpus.ts"
 *
 * Corpus.write("/tmp/corpus", { files: 50, lines: 200, seed: 1 })
 * ```
 *
 * @since 0.0.0
 */
export const write = (root: string, options: CorpusOptions): string => {
  Fs.rmSync(root, { recursive: true, force: true })
  const rand = random(options.seed)
  const pick = () => {
    const r = rand()
    return r < 0.1 ? identifiers[Math.floor(rand() * identifiers.length)] : words[Math.floor(rand() * words.length)]
  }
  const num = () => Math.floor(rand() * 1000)
  const file = (relative: string, content: string | Uint8Array) => {
    const p = Path.join(root, relative)
    Fs.mkdirSync(Path.dirname(p), { recursive: true })
    Fs.writeFileSync(p, content)
  }
  for (let i = 0; i < options.files; i++) {
    const [ext, line] = languages[i % languages.length]
    const dir = ["src", "src/lib", "docs", "tests", "vendor/pkg", "build"][i % 6]
    const lines: Array<string> = []
    for (let j = 0; j < options.lines; j++) {
      const r = rand()
      lines.push(r < 0.05 ? "" : r < 0.08 ? `    ${line(pick, num)}` : line(pick, num))
    }
    file(`${dir}/file${i}.${ext}`, lines.join("\n") + (i % 7 === 3 ? "" : "\n"))
  }
  file(".gitignore", "build/\n*.log\n!keep.log\n")
  file("vendor/.ignore", "pkg/file10.*\n")
  file(".hidden/secret.txt", "Sherlock hidden secret\nparser hidden\n")
  file(".dotfile", "parser in a dotfile\n")
  file("debug.log", "parser log line\n")
  file("keep.log", "parser kept log line\n")
  file("crlf.txt", "Sherlock Holmes\r\nparser crlf\r\nlast line\r\n")
  file("long.txt", `${"parser ".repeat(3000)}\nshort parser line\n`)
  file(
    "binary.dat",
    new Uint8Array([
      ...new TextEncoder().encode("parser before\n"),
      0,
      1,
      2,
      ...new TextEncoder().encode("\nparser after\n")
    ])
  )
  const utf16 = "Sherlock in UTF-16\nparser utf16\n"
  const le = new Uint8Array(2 + utf16.length * 2)
  le[0] = 0xff
  le[1] = 0xfe
  for (let i = 0; i < utf16.length; i++) {
    le[2 + 2 * i] = utf16.charCodeAt(i) & 0xff
    le[3 + 2 * i] = utf16.charCodeAt(i) >> 8
  }
  file("utf16.txt", le)
  file("empty.txt", "")
  file("no-newline.txt", "parser without newline")
  // A git repository marker, so .gitignore applies.
  Fs.mkdirSync(Path.join(root, ".git"), { recursive: true })
  return root
}
