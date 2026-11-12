import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test"
import * as Corpus from "../bench/corpus.ts"
import * as Differential from "../bench/differential.ts"
import { main } from "../src/main.ts"
import * as Input from "../src/search/input.ts"

const encoder = new TextEncoder()
let scratch = ""
let root = ""

beforeAll(() => {
  scratch = Fs.mkdtempSync(Path.join(Os.tmpdir(), "erg-test-"))
  root = Corpus.write(Path.join(scratch, "corpus"), { files: 30, lines: 60, seed: 7 })
})

afterAll(() => {
  Fs.rmSync(scratch, { recursive: true, force: true })
})

interface Outcome {
  readonly stdout: string
  readonly stderr: string
  readonly status: number
}

/** Runs `erg` in-process, as the `bin/erg.ts` entry point does, capturing its output. */
const erg = (
  argv: ReadonlyArray<string>,
  options: { readonly input?: string; readonly env?: Record<string, string> } = {}
): Outcome => {
  const out = Path.join(scratch, "stdout")
  const fd = Fs.openSync(out, "w+")
  let stderr = ""
  let status: number | Promise<number>
  try {
    status = main({
      argv,
      env: { RIPGREP_CONFIG_PATH: "", ...options.env },
      cwd: root,
      stdoutIsTty: false,
      stdout: fd,
      stderr: (m) => {
        stderr += m
      },
      stdin: { readable: options.input !== undefined, read: () => encoder.encode(options.input ?? "") },
      workerUrl: undefined
    })
  } finally {
    Fs.closeSync(fd)
  }
  // Without a worker URL the search runs on this thread, synchronously.
  return { stdout: Fs.readFileSync(out, "utf8"), stderr, status: Predicate.isNumber(status) ? status : -1 }
}

// Command lines checked against ripgrep 14 byte for byte (stdout and exit
// status). `--sort path` makes ripgrep's file order deterministic.
const cases: ReadonlyArray<ReadonlyArray<string>> = [
  ["parser"],
  ["-n", "parser"],
  ["-i", "sherlock"],
  ["-S", "sherlock"],
  ["-S", "Sherlock"],
  ["-w", "foo"],
  ["-x", "parser crlf\r?"],
  ["-c", "parser"],
  ["--count-matches", "parser"],
  ["-l", "TODO"],
  ["--files-without-match", "TODO"],
  ["-v", "-c", "e"],
  ["-o", "-n", "\\w+@\\w+\\.com"],
  ["--column", "-n", "fn \\w+"],
  ["-b", "FIXME"],
  ["-A", "2", "-n", "Moriarty"],
  ["-B1", "-C", "1", "Watson"],
  ["-C2", "--heading", "-n", "Baker"],
  ["--vimgrep", "Holmes"],
  ["-r", "[$1]", "(Sher)lock"],
  ["-o", "-r", "<${name}>", "(?P<name>Wat)son"],
  ["-m", "2", "parser"],
  ["--passthru", "Sherlock", "crlf.txt"],
  ["-M", "20", "parser", "long.txt"],
  ["-M", "20", "--max-columns-preview", "parser", "long.txt"],
  ["--json", "Holmes", "src"],
  ["-t", "rust", "Error"],
  ["-T", "md", "-l", "e"],
  ["-g", "*.py", "-l", "def"],
  ["-g", "!*.py", "-l", "def"],
  ["--iglob", "*.PY", "-l", "def"],
  ["--hidden", "-l", "hidden"],
  ["-u", "-l", "parser"],
  ["-uu", "-l", "parser"],
  ["-uuu", "-l", "parser"],
  ["--no-ignore", "-l", "log"],
  ["parser", "binary.dat"],
  ["-a", "parser", "binary.dat"],
  ["-c", "parser", "utf16.txt"],
  ["-E", "none", "-c", "parser", "utf16.txt"],
  ["\\p{Greek}+", "-o"],
  ["(?i)straße", "-o"],
  ["\\bλόγος\\b", "-c"],
  ["[[:upper:]][[:lower:]]+ [[:upper:]]", "-o"],
  ["\\d{3}\\.\\d{1,3}", "-c"],
  ["-F", "a.b(", "-c"],
  ["-e", "Watson", "-e", "Moriarty", "-c"],
  ["-U", "Sherlock Holmes\\r\\nparser", "-n"],
  ["-U", "-c", "\\n\\n"],
  ["--files"],
  ["--files", "-t", "py"],
  ["-q", "parser"],
  ["--null", "-l", "Holmes"],
  ["--trim", "-n", "^\\s+export"],
  ["-n", "--no-filename", "TODO", "src"],
  ["-H", "parser", "no-newline.txt"],
  ["$", "-c", "no-newline.txt"],
  ["", "-c"],
  ["^", "-c"],
  ["x*", "-o", "-c"],
  ["-d", "1", "-l", "parser"],
  ["--type-list"],
  ["--stop-on-nonmatch", "-n", "parser", "keep.log"],
  ["-c", "-z", "parser"],
  ["--max-filesize", "1K", "-l", "parser"],
  ["--field-match-separator", "|", "-n", "Holmes", "src/file0.ts"],
  ["-n", "--color", "always", "Holmes", "src"],
  ["--colors", "match:fg:blue", "--color", "always", "-o", "Watson"],
  ["-p", "Holmes", "src/lib"],
  ["--count", "--include-zero", "Moriarty", "src"],
  ["-v", "-n", "e", "crlf.txt"],
  ["--crlf", "-n", "crlf$"],
  ["--null-data", "-c", "parser"],
  ["--sortr", "path", "-l", "TODO"],
  ["-v", "-n", "-C1", "e", "src/file0.ts"],
  ["-n", "-A1", "-m1", "Holmes", "src"],
  ["--passthru", "-n", "Sherlock", "crlf.txt", "keep.log"],
  ["--heading", "-C1", "parser", "keep.log", "crlf.txt"],
  ["-o", "-b", "Watson"],
  ["--vimgrep", "e\\b"],
  ["-o", "a+?"],
  ["-o", "(a|ab)(c|bcd)"],
  ["-o", "\\w+?r"],
  ["-o", "(?:[a-z]+_){2,}[a-z]+"],
  ["-o", "\\b\\w{5}\\b", "docs"],
  ["-c", "(?s)parser.after", "binary.dat"],
  ["-U", "--multiline-dotall", "-c", "parser.before"],
  ["-w", "foo_bar|zeta", "-o"],
  ["-o", "(?i)ß+"],
  ["-c", "\\p{Lu}\\p{Ll}+", "docs"],
  ["-o", "[^\\x00-\\x7F]+", "docs/file8.md"],
  ["-c", "\\D\\S\\W"],
  ["-e", "", "-c", "crlf.txt"],
  ["-x", "-c", ""],
  ["-o", "\\Bars\\B|\\bpar"],
  ["-c", "^\\s*$"],
  ["-o", "\\x{1F980}|🦀"],
  ["-c", "(?x) parse  r # comment"],
  ["-i", "-o", "ΩΜΈΓΑ"],
  ["-o", "[[:alpha:]&&[^a-m]]{4}", "src/file0.ts"],
  ["-n", "-r", "", "Holmes", "src/lib"],
  ["--color", "always", "-r", "X", "Holmes", "src/lib"],
  ["-o", "-n", "--column", "parser", "long.txt"],
  ["--count-matches", "-v", "e", "src"],
  ["-L", "-l", "Sherlock"],
  ["--no-heading", "--context-separator", "##", "-C1", "Watson", "src"],
  ["--no-context-separator", "-A1", "Watson", "src"],
  ["--field-context-separator", "=", "-B1", "Moriarty", "src"],
  ["-l", "--no-messages", "x", "missing.txt", "keep.log"],
  ["nope", "missing.txt"],
  ["(unclosed"],
  ["--bogus-flag", "x"],
  ["-A"],
  ["--type", "nosuchtype", "x"],
  ["a\\nb"],
  ["--stats", "-q", "Holmes"],
  ["-m", "0", "parser"],
  [
    "--colors",
    "path:fg:0x10,0x20,0x30",
    "--colors",
    "line:bg:200",
    "--colors",
    "match:style:underline",
    "--colors",
    "match:style:nobold",
    "--colors",
    "column:fg:cyan",
    "--colors",
    "match:style:intense",
    "--colors",
    "match:fg:green",
    "--color",
    "always",
    "--column",
    "-n",
    "Watson",
    "src"
  ],
  [
    "--colors",
    "path:none",
    "--colors",
    "match:style:italic",
    "--colors",
    "line:style:bold",
    "--colors",
    "match:bg:yellow",
    "--color",
    "ansi",
    "-H",
    "Holmes",
    "crlf.txt"
  ],
  ["--colors", "nope:fg:red", "--color", "always", "x"],
  ["--colors", "match:fg:mauve", "--color", "always", "x"],
  ["--colors", "match:style:wavy", "--color", "always", "x"],
  ["--colors", "match:sparkle:red", "--color", "always", "x"],
  ["--colors", "match", "--color", "always", "x"]
]

describe.skipIf(!Differential.hasRipgrep())("against ripgrep 14.1", () => {
  it("prints exactly what ripgrep prints", () => {
    for (const c of cases) {
      const args = ["--sort", "path", ...c]
      const expected = Differential.rg(args, root)
      const actual = erg(args)
      expect(Differential.normalizeTimings(actual.stdout), `rg ${args.join(" ")}`).toBe(
        Differential.normalizeTimings(expected.stdout)
      )
      expect(actual.status, `exit status of rg ${args.join(" ")}`).toBe(expected.status)
    }
  })

  it("searches standard input like ripgrep", () => {
    for (const [c, input] of [
      [["-n", "b"], "a\nb\nc\n"],
      [["-c", "x"], "x\nx\n"],
      [["-", "keep.log", "-l", "parser"], "parser\n"]
    ] as const) {
      expect(erg(c, { input }).stdout, c.join(" ")).toBe(Differential.rg(c, root, {}, input).stdout)
    }
  })

  it("reads RIPGREP_CONFIG_PATH like ripgrep", () => {
    const config = Path.join(scratch, "rgrc")
    Fs.writeFileSync(config, "# comment\n--ignore-case\n-n\n")
    for (const c of [
      ["sherlock", "crlf.txt"],
      ["--no-config", "sherlock", "crlf.txt"]
    ]) {
      const env = { RIPGREP_CONFIG_PATH: config }
      expect(erg(c, { env }).stdout, c.join(" ")).toBe(Differential.rg(c, root, env).stdout)
    }
  })
})

/** Runs `erg` in-process with worker threads available, awaiting a parallel search. */
const ergParallel = async (argv: ReadonlyArray<string>): Promise<Outcome> => {
  const out = Path.join(scratch, "stdout-parallel")
  const fd = Fs.openSync(out, "w+")
  let stderr = ""
  try {
    const status = await main({
      argv,
      env: { RIPGREP_CONFIG_PATH: "" },
      cwd: root,
      stdoutIsTty: false,
      stdout: fd,
      stderr: (m) => {
        stderr += m
      },
      stdin: { readable: false, read: () => new Uint8Array() },
      workerUrl: new URL("../src/worker.ts", import.meta.url)
    })
    return { stdout: Fs.readFileSync(out, "utf8"), stderr, status }
  } finally {
    Fs.closeSync(fd)
  }
}

// Workers run in plain Node, outside this runner's module aliases: they load
// the package as a dependent does, from its build.
const built = Fs.existsSync(Path.join(import.meta.dirname, "..", "..", "..", "dist", "index.js"))

describe.skipIf(!built)("in parallel", () => {
  it("prints what one thread prints, in the same order", async () => {
    for (const c of [
      ["-n", "parser"],
      ["--heading", "-n", "Holmes"],
      ["-C1", "Watson"],
      ["-c", "e"],
      ["-l", "TODO"],
      ["--json", "Moriarty"],
      ["--stats", "Baker"],
      ["-q", "Sherlock"],
      ["nothing-matches-this"],
      ["x", "missing.txt", "src"]
    ]) {
      const one = await ergParallel(["-j1", ...c])
      const many = await ergParallel(["-j4", ...c])
      expect(Differential.normalizeTimings(many.stdout), c.join(" ")).toBe(Differential.normalizeTimings(one.stdout))
      expect(many.status, c.join(" ")).toBe(one.status)
    }
  })
})

describe("erg", () => {
  it("prints matching lines with ripgrep's defaults", () => {
    expect(erg(["Sherlock", "crlf.txt"])).toEqual({ stdout: "Sherlock Holmes\r\n", stderr: "", status: 0 })
    expect(erg(["-n", "parser", "keep.log", "crlf.txt"]).stdout).toBe(
      "keep.log:1:parser kept log line\ncrlf.txt:2:parser crlf\r\n"
    )
    expect(erg(["nothing-matches-this", "crlf.txt"]).status).toBe(1)
  })

  it("reports errors with status 2", () => {
    expect(erg(["x", "missing.txt"])).toMatchObject({
      status: 2,
      stderr: "erg: missing.txt: No such file or directory (os error 2)\n"
    })
    expect(erg(["(unclosed"]).stderr).toContain("regex parse error")
    expect(erg(["--bogus"]).stderr).toBe("erg: unrecognized flag --bogus\n")
    expect(erg([]).stderr).toContain("requires at least one pattern")
    expect(erg(["-P", "x"]).stderr).toContain("PCRE2 is not available")
    expect(erg(["-E", "no-such-encoding", "x"]).stderr).toContain("unknown encoding")
    expect(erg(["--colors", "nope:fg:red", "--color", "always", "x"]).status).toBe(2)
  })

  it("prints help, version and generated files", () => {
    expect(erg(["-h"]).stdout).toContain("--max-columns-preview")
    expect(erg(["--help"]).stdout).toContain("NEGATIONS AND ALIASES")
    expect(erg(["-V"]).stdout).toContain("ripgrep 14.1.0 compatible")
    expect(erg(["--pcre2-version"]).status).toBe(1)
    for (const kind of ["man", "complete-bash", "complete-zsh", "complete-fish", "complete-powershell"]) {
      expect(erg(["--generate", kind]).stdout.length, kind).toBeGreaterThan(100)
    }
  })

  it("searches standard input when given no path", () => {
    expect(erg(["-n", "b"], { input: "a\nb\n" }).stdout).toBe("2:b\n")
    expect(erg(["-f", "-", "crlf.txt"], { input: "Holmes\nlast\n" }).stdout).toBe("Sherlock Holmes\r\nlast line\r\n")
  })

  it("decodes encodings, decompresses and preprocesses", () => {
    expect(erg(["-c", "utf16", "utf16.txt"]).stdout).toBe("1\n")
    expect(erg(["-E", "latin1", "-c", "parser", "keep.log"]).stdout).toBe("1\n")
    Fs.writeFileSync(Path.join(root, "pre.sh"), "#!/bin/sh\ntr a-z A-Z\n", { mode: 0o755 })
    expect(erg(["--pre", "./pre.sh", "PARSER", "keep.log"]).stdout).toBe("PARSER KEPT LOG LINE\n")
    expect(erg(["--pre", "./pre.sh", "--pre-glob", "*.txt", "-c", "PARSER", "keep.log"]).status).toBe(1)
    Fs.rmSync(Path.join(root, "pre.sh"))
  })

  it("refuses to expand a compressed file past the limit (#120)", () => {
    const zlib = process.getBuiltinModule("node:zlib")
    const text = encoder.encode("parser\n".repeat(20_000))
    const cases: ReadonlyArray<readonly [string, Uint8Array]> = [
      ["bomb.gz", zlib.gzipSync(text)],
      ["bomb.br", zlib.brotliCompressSync(text)]
    ]
    cases.forEach(([name, packed]) => {
      // 140 000 bytes from a few hundred: within the limit it is searched, over it it is an error, not an allocation
      expect(packed.length, name).toBeLessThan(2000)
      expect(
        Result.map(Input.decompress(name, packed), (b) => b.length),
        name
      ).toEqual(Result.succeed(text.length))
      const over = Input.decompress(name, packed, 4096)
      expect(Result.isFailure(over) && over.failure, name).toMatch(
        /^(gzip|brotli): .*(larger than|Cannot create a Buffer)/i
      )
      expect(Result.isFailure(Input.decompress(name, encoder.encode("not compressed"))), name).toBe(true)
    })
    expect(Input.MaxDecompressed).toBe(1 << 30)
    // Through the command line: the file is reported and skipped, and the search goes on
    Fs.writeFileSync(Path.join(root, "broken.gz"), "not gzip")
    const out = erg(["-z", "-c", "parser", "broken.gz", "keep.log"])
    Fs.rmSync(Path.join(root, "broken.gz"))
    expect(out.stdout).toBe("keep.log:1\n")
    expect(out.stderr).toContain("broken.gz")
    expect(out.status).toBe(2)
  })

  it("writes hyperlinks when colours are on", () => {
    const out = erg(["--color", "always", "--hyperlink-format", "vscode", "-H", "Sherlock", "crlf.txt"]).stdout
    expect(out).toContain(`\x1b]8;;vscode://file${Path.join(root, "crlf.txt")}:1:1\x1b\\`)
  })

  it("runs with every effect-parse backend", () => {
    for (const ERG_COMPILER of ["jit", "closure", "wasm", "none"]) {
      expect(erg(["-c", "Holmes|Watson", "docs"], { env: { ERG_COMPILER } }).stdout, ERG_COMPILER).toBe(
        erg(["-c", "Holmes|Watson", "docs"]).stdout
      )
    }
  })
})
