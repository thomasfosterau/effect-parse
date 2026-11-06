/**
 * Gitignore-format files (`.gitignore`, `.ignore`, `.rgignore`,
 * `.git/info/exclude`, the global excludes file and `--ignore-file`), and
 * ripgrep's `-g` overrides, which use the same format with the meaning of
 * `!` reversed.
 *
 * @since 0.0.0
 */
import * as Result from "effect/Result"
import * as Glob from "./glob.ts"
import * as Arr from "effect/Array"
import * as Str from "effect/String"

/**
 * One line of an ignore file.
 *
 * @since 0.0.0
 */
export interface Rule {
  readonly glob: Glob.Glob
  /** `!pattern`: re-includes what an earlier rule ignored. */
  readonly whitelist: boolean
  /** `pattern/`: matches directories only. */
  readonly dirOnly: boolean
}

/**
 * The rules of one ignore file, whose patterns are relative to `root`.
 *
 * @since 0.0.0
 */
export interface RuleSet {
  readonly root: string
  readonly rules: ReadonlyArray<Rule>
}

/**
 * A rule set's verdict on a path.
 *
 * @since 0.0.0
 */
export type Decision = "ignore" | "whitelist" | undefined

const encoder = new TextEncoder()

/** Removes trailing spaces that are not escaped with a backslash. */
const trimTrailing = (line: string): string => {
  let end = line.length
  while (end > 0 && line[end - 1] === " " && line[end - 2] !== "\\") end--
  return line.slice(0, end)
}

/**
 * Parses one gitignore line into a rule, or `undefined` for a blank line or
 * a comment. Errors are malformed globs.
 *
 * @since 0.0.0
 */
const parseLine = (raw: string, caseInsensitive: boolean): Result.Result<Rule | undefined, string> => {
  let line = trimTrailing(raw.endsWith("\r") ? raw.slice(0, -1) : raw)
  if (Str.isEmpty(line) || line.startsWith("#")) return Result.succeed(undefined)
  let whitelist = false
  if (line.startsWith("!")) {
    whitelist = true
    line = line.slice(1)
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1)
  }
  let dirOnly = false
  if (line.endsWith("/") && !line.endsWith("\\/")) {
    dirOnly = true
    line = line.slice(0, -1)
  }
  if (Str.isEmpty(line)) return Result.succeed(undefined)
  // A pattern with a slash is anchored to the file's directory; one without
  // matches a name at any depth.
  const anchored = line.includes("/")
  const pattern = anchored ? line.replace(/^\//, "") : `**/${line}`
  return Result.map(Glob.compileGlob(pattern, caseInsensitive), (glob) => ({ glob, whitelist, dirOnly }))
}

/**
 * Parses an ignore file's text. Malformed lines are reported through
 * `onError` and skipped, as ripgrep does.
 *
 * @since 0.0.0
 */
export const parseIgnoreFile = (
  root: string,
  text: string,
  caseInsensitive: boolean,
  onError: (message: string) => void
): RuleSet => {
  const rules: Array<Rule> = []
  for (const line of text.split("\n")) {
    const parsed = parseLine(line, caseInsensitive)
    if (Result.isFailure(parsed)) onError(parsed.failure)
    else if (parsed.success !== undefined) rules.push(parsed.success)
  }
  return { root, rules }
}

/**
 * The verdict of a rule set on a path relative to its root: the last
 * matching rule wins.
 *
 * @since 0.0.0
 */
export const decide = (set: RuleSet, relative: string, isDir: boolean): Decision => {
  if (Arr.isReadonlyArrayEmpty(set.rules)) return undefined
  const bytes = encoder.encode(relative)
  for (let i = set.rules.length - 1; i >= 0; i--) {
    const rule = set.rules[i]
    if (rule.dirOnly && !isDir) continue
    if (rule.glob.matches(bytes)) return rule.whitelist ? "whitelist" : "ignore"
  }
  return undefined
}

/**
 * `-g` / `--iglob` overrides: a matching glob includes a path, a matching
 * `!glob` excludes it, and when any including glob exists, files that match
 * none are excluded.
 *
 * @since 0.0.0
 */
export interface Overrides {
  readonly set: RuleSet
  readonly hasWhitelist: boolean
}

/**
 * Builds the overrides from `-g` / `--iglob` globs.
 *
 * @since 0.0.0
 */
export const overrides = (
  root: string,
  globs: ReadonlyArray<{ readonly glob: string; readonly caseInsensitive: boolean }>
): Result.Result<Overrides, string> => {
  const rules: Array<Rule> = []
  for (const { caseInsensitive, glob } of globs) {
    const parsed = parseLine(glob, caseInsensitive)
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
    // In an override, `!` excludes and a bare glob includes.
    if (parsed.success !== undefined) rules.push({ ...parsed.success, whitelist: !parsed.success.whitelist })
  }
  return Result.succeed({ set: { root, rules }, hasWhitelist: rules.some((r) => r.whitelist) })
}
