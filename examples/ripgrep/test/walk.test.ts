import * as Result from "effect/Result"
import { describe, expect, it } from "vite-plus/test"
import * as Cli from "../src/cli/args.ts"
import * as Glob from "../src/walk/glob.ts"
import * as Ignore from "../src/walk/ignore.ts"
import * as Types from "../src/walk/types.ts"
import { success } from "./utils.ts"

const encoder = new TextEncoder()

const matches = (glob: string, path: string, caseInsensitive = false): boolean => {
  const compiled = success(Glob.compileGlob(glob, caseInsensitive))
  return compiled.matches(encoder.encode(path))
}

describe("globs", () => {
  it("matches gitignore-style wildcards", () => {
    expect(matches("*.rs", "main.rs")).toBe(true)
    expect(matches("*.rs", "src/main.rs")).toBe(false)
    expect(matches("**/*.rs", "src/a/main.rs")).toBe(true)
    expect(matches("**/*.rs", "main.rs")).toBe(true)
    expect(matches("src/**", "src/a/b")).toBe(true)
    expect(matches("a/**/b", "a/b")).toBe(true)
    expect(matches("a/**/b", "a/x/y/b")).toBe(true)
    expect(matches("?.txt", "a.txt")).toBe(true)
    expect(matches("?.txt", "/.txt")).toBe(false)
    expect(matches("[abc].txt", "b.txt")).toBe(true)
    expect(matches("[!abc].txt", "d.txt")).toBe(true)
    expect(matches("[!abc].txt", "a.txt")).toBe(false)
    expect(matches("*.{rs,toml}", "Cargo.toml")).toBe(true)
    expect(matches("\\*.txt", "*.txt")).toBe(true)
    expect(matches("\\*.txt", "a.txt")).toBe(false)
    expect(matches("*.PY", "x.py", true)).toBe(true)
    expect(matches("*.PY", "x.py")).toBe(false)
  })

  it("rejects malformed globs", () => {
    expect(Result.isFailure(Glob.compileGlob("[abc", false))).toBe(true)
  })
})

describe("ignore files", () => {
  const set = Ignore.parseIgnoreFile(
    "/r",
    "# comment\n\nbuild/\n*.log\n!keep.log\n/root-only\n\\#hash\ntrailing\\ \n",
    false,
    () => {}
  )

  it("applies the last matching rule", () => {
    expect(Ignore.decide(set, "debug.log", false)).toBe("ignore")
    expect(Ignore.decide(set, "keep.log", false)).toBe("whitelist")
    expect(Ignore.decide(set, "a/b/x.log", false)).toBe("ignore")
    expect(Ignore.decide(set, "main.rs", false)).toBe(undefined)
  })

  it("matches directory-only and anchored rules", () => {
    expect(Ignore.decide(set, "build", true)).toBe("ignore")
    expect(Ignore.decide(set, "build", false)).toBe(undefined)
    expect(Ignore.decide(set, "root-only", false)).toBe("ignore")
    expect(Ignore.decide(set, "sub/root-only", false)).toBe(undefined)
    expect(Ignore.decide(set, "#hash", false)).toBe("ignore")
    expect(Ignore.decide(set, "trailing ", false)).toBe("ignore")
  })

  it("reports malformed lines and keeps the rest", () => {
    const errors: Array<string> = []
    const parsed = Ignore.parseIgnoreFile("/r", "[bad\nok\n", false, (m) => errors.push(m))
    expect(errors.length).toBe(1)
    expect(parsed.rules.length).toBe(1)
  })

  it("reverses ! for overrides", () => {
    const o = success(
      Ignore.overrides("/r", [
        { glob: "*.rs", caseInsensitive: false },
        { glob: "!test.rs", caseInsensitive: false }
      ])
    )
    expect(o.hasWhitelist).toBe(true)
    expect(Ignore.decide(o.set, "main.rs", false)).toBe("whitelist")
    expect(Ignore.decide(o.set, "test.rs", false)).toBe("ignore")
  })
})

describe("file types", () => {
  it("defines ripgrep's default types", () => {
    const defs = success(Types.definitions([]))
    expect(defs.get("rust")).toEqual(["*.rs"])
    expect(Types.list(defs)).toContain("rust: *.rs\n")
  })

  it("adds, includes and clears types", () => {
    const rules: ReadonlyArray<Cli.TypeRule> = [
      { kind: "add", value: "foo:*.foo" },
      { kind: "add", value: "foo:*.bar" },
      { kind: "add", value: "both:include:foo,rust" },
      { kind: "clear", value: "python" }
    ]
    const defs = success(Types.definitions(rules))
    expect(defs.get("foo")).toEqual(["*.foo", "*.bar"])
    expect(defs.get("both")).toEqual(["*.foo", "*.bar", "*.rs"])
    expect(defs.has("python")).toBe(false)
    expect(Result.isFailure(Types.definitions([{ kind: "add", value: "nocolon" }]))).toBe(true)
    expect(Result.isFailure(Types.definitions([{ kind: "add", value: "x:include:nosuch" }]))).toBe(true)
  })

  it("selects and negates types", () => {
    const defs = success(Types.definitions([]))
    const select = success(Types.filter(defs, [{ kind: "select", value: "rust" }]))
    const negate = success(Types.filter(defs, [{ kind: "negate", value: "rust" }]))
    const all = success(Types.filter(defs, [{ kind: "select", value: "all" }]))
    expect(select?.(encoder.encode("a.rs"))).toBe(true)
    expect(select?.(encoder.encode("a.py"))).toBe(false)
    expect(negate?.(encoder.encode("a.rs"))).toBe(false)
    expect(negate?.(encoder.encode("a.py"))).toBe(true)
    expect(all?.(encoder.encode("a.py"))).toBe(true)
    expect(all?.(encoder.encode("a.unknownext"))).toBe(false)
    expect(Result.isFailure(Types.filter(defs, [{ kind: "select", value: "nosuch" }]))).toBe(true)
    expect(Result.isSuccess(Types.filter(defs, [])) && Types.filter(defs, [])).toEqual(Result.succeed(undefined))
  })
})

describe("command line", () => {
  const parse = (argv: ReadonlyArray<string>) => Cli.parseArgv(argv, Cli.defaults())

  it("clusters short flags and takes attached values", () => {
    const a = parse(["-inA3", "-efoo", "-C", "2", "--", "-v"])
    expect(a.caseMode).toBe("insensitive")
    expect(a.lineNumber).toBe(true)
    expect(a.afterContext).toBe(3)
    expect(a.context).toBe(2)
    expect(a.patterns).toEqual(["foo"])
    expect(a.positional).toEqual(["-v"])
  })

  it("reads long flags, values and negations; later flags win", () => {
    const a = parse([
      "--max-count=5",
      "--sort",
      "path",
      "--heading",
      "--no-heading",
      "--json",
      "--no-json",
      "--maxdepth",
      "2",
      "--passthrough"
    ])
    expect(a.maxCount).toBe(5)
    expect(a.sort).toEqual({ by: "path", reverse: false })
    expect(a.heading).toBe(false)
    expect(a.mode).toBe("standard")
    expect(a.maxDepth).toBe(2)
    expect(a.passthru).toBe(true)
  })

  it("counts -u", () => {
    const a = parse(["-uuu"])
    expect([a.noIgnore, a.hidden, a.binary]).toEqual([true, true, true])
  })

  it("rejects unknown flags and bad values", () => {
    for (const argv of [
      ["--nope"],
      ["-Q"],
      ["-A"],
      ["-A", "x"],
      ["--color", "sometimes"],
      ["--heading=yes"],
      ["--max-filesize", "10Q"],
      ["--path-separator", "ab"]
    ]) {
      expect(() => parse(argv), argv.join(" ")).toThrow(Cli.UsageError)
    }
  })

  it("parses sizes, separators and help", () => {
    expect(parse(["--max-filesize", "2K"]).maxFilesize).toBe(2048)
    expect(parse(["--context-separator", "\\t\\x41"]).contextSeparator).toBe("\tA")
    expect(parse(["--no-context-separator"]).contextSeparator).toBe(undefined)
    expect(parse(["-h"]).special).toBe("shortHelp")
    expect(parse(["--help"]).special).toBe("longHelp")
  })

  it("reads configuration files", () => {
    expect(Cli.configArguments("# c\n\n--smart-case\n  -n  \r\n")).toEqual(["--smart-case", "-n"])
  })
})
