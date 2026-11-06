/**
 * The directory walker: which files ripgrep searches, in which order.
 *
 * Explicit paths are always searched. Below a directory, entries are
 * filtered in ripgrep's order of precedence: `-g` overrides, then ignore
 * files (`.rgignore`, `.ignore`, `.gitignore`, `.git/info/exclude`,
 * `--ignore-file`, the global excludes file; deeper directories first
 * within each), then hidden names, then file types.
 *
 * @since 0.0.0
 */
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import * as Arr from "effect/Array"
import * as Order from "effect/Order"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import type { Args } from "../cli/args.ts"
import * as Ignore from "./ignore.ts"
import type * as Types from "./types.ts"

/**
 * A file to search: the path as printed, and whether it was named on the
 * command line.
 *
 * @since 0.0.0
 */
export interface Entry {
  readonly path: string
  /** The absolute path, for reading. */
  readonly absolute: string
  readonly explicit: boolean
  readonly stdin: boolean
}

/**
 * The walker's settings, derived from the command line.
 *
 * @since 0.0.0
 */
export interface WalkOptions {
  readonly args: Args
  readonly overrides: Ignore.Overrides | undefined
  readonly types: Types.Filter | undefined
  readonly cwd: string
  /** Reports an error (a missing path, an unreadable directory, a bad ignore file). */
  readonly onError: (message: string) => void
  /** Reports an ignore-file parse error (suppressed by `--no-ignore-messages`). */
  readonly onIgnoreError: (message: string) => void
}

const encoder = new TextEncoder()

const toPosix = (p: string): string => (Path.sep === "/" ? p : p.split(Path.sep).join("/"))

const osMessages: ReadonlyMap<string, string> = new Map([
  ["ENOENT", "No such file or directory"],
  ["EACCES", "Permission denied"],
  ["EISDIR", "Is a directory"],
  ["ENOTDIR", "Not a directory"],
  ["ELOOP", "Too many levels of symbolic links"],
  ["EPERM", "Operation not permitted"]
])

/** ripgrep's wording of an I/O error, including the OS error number. */
export const describeError = (error: unknown): string => {
  const code = Predicate.hasProperty(error, "code") ? String(error.code) : ""
  const errno = Predicate.hasProperty(error, "errno") ? Math.abs(Number(error.errno)) : 0
  const text = osMessages.get(code) ?? (Predicate.hasProperty(error, "message") ? String(error.message) : String(error))
  return errno > 0 ? `${text} (os error ${errno})` : text
}

const readText = (file: string): string | undefined => {
  try {
    return Fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** The excludes file git uses: `core.excludesFile`, else `$XDG_CONFIG_HOME/git/ignore`. */
const globalExcludesFile = (): string | undefined => {
  const home = Os.homedir()
  const config = readText(Path.join(home, ".gitconfig"))
  const configured = config === undefined ? undefined : /^\s*excludesfile\s*=\s*(.+?)\s*$/im.exec(config)?.[1]
  if (configured !== undefined) return configured.replace(/^~(?=\/|$)/, home)
  const xdg = process.env.XDG_CONFIG_HOME
  return Path.join(xdg !== undefined && xdg !== "" ? xdg : Path.join(home, ".config"), "git", "ignore")
}

/** The ignore files read in one directory, by kind. */
interface DirIgnores {
  readonly dir: string
  readonly rgignore: Ignore.RuleSet | undefined
  readonly ignore: Ignore.RuleSet | undefined
  readonly gitignore: Ignore.RuleSet | undefined
  readonly exclude: Ignore.RuleSet | undefined
  readonly isRepo: boolean
}

/** An immutable stack of ignore files, deepest first. */
interface Scope {
  readonly dirs: ReadonlyArray<DirIgnores>
  readonly inRepo: boolean
}

type Kind = "rgignore" | "ignore" | "gitignore" | "exclude"

const isDirectory = (p: string): boolean => {
  try {
    return Fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const exists = (p: string): boolean => Fs.existsSync(p)

const ignoreKinds: ReadonlyArray<Kind> = ["rgignore", "ignore", "gitignore", "exclude"]

const relativeTo = (set: Ignore.RuleSet, abs: string): string => toPosix(Path.relative(set.root, abs))

/** The ignore files in effect, and their verdicts on paths. */
class IgnoreRules {
  private readonly options: WalkOptions
  private readonly useIgnore: boolean
  private readonly dot: boolean
  private readonly vcs: boolean
  private readonly exclude: boolean
  private readonly requireGit: boolean
  /** `--ignore-file` files. */
  private readonly extra: ReadonlyArray<Ignore.RuleSet>
  /** The global excludes file. */
  private readonly global: Ignore.RuleSet | undefined

  constructor(options: WalkOptions) {
    const { args } = options
    this.options = options
    this.useIgnore = !args.noIgnore
    this.dot = this.useIgnore && !args.noIgnoreDot
    this.vcs = this.useIgnore && !args.noIgnoreVcs
    this.exclude = this.vcs && !args.noIgnoreExclude
    this.requireGit = !args.noRequireGit
    this.extra =
      args.noIgnoreFiles || args.noIgnore
        ? []
        : args.ignoreFiles.flatMap((f) => this.load(Path.resolve(options.cwd, f), options.cwd) ?? [])
    const globalFile = this.vcs && !args.noIgnoreGlobal ? globalExcludesFile() : undefined
    this.global = globalFile === undefined ? undefined : this.load(globalFile, options.cwd)
  }

  private load(file: string, root: string): Ignore.RuleSet | undefined {
    const text = readText(file)
    if (text === undefined) return undefined
    const report = (message: string) => this.options.onIgnoreError(`${file}: ${message}`)
    return Ignore.parseIgnoreFile(root, text, this.options.args.ignoreFileCaseInsensitive, report)
  }

  private dirIgnores(dir: string): DirIgnores {
    const isRepo = exists(Path.join(dir, ".git"))
    return {
      dir,
      rgignore: this.dot ? this.load(Path.join(dir, ".rgignore"), dir) : undefined,
      ignore: this.dot ? this.load(Path.join(dir, ".ignore"), dir) : undefined,
      gitignore: this.vcs ? this.load(Path.join(dir, ".gitignore"), dir) : undefined,
      exclude: this.exclude && isRepo ? this.load(Path.join(dir, ".git", "info", "exclude"), dir) : undefined,
      isRepo
    }
  }

  /** The scope inside `dir`, below `scope`. */
  enter(scope: Scope, dir: string): Scope {
    const here = this.dirIgnores(dir)
    return { dirs: [here, ...scope.dirs], inRepo: scope.inRepo || here.isRepo }
  }

  /** The scope of a search root: the ignore files of its ancestors, unless `--no-ignore-parent`. */
  rootScope(abs: string): Scope {
    let scope: Scope = { dirs: [], inRepo: false }
    if (!this.useIgnore || this.options.args.noIgnoreParent) return scope
    const ancestors: Array<string> = []
    for (let d = Path.dirname(abs); ; d = Path.dirname(d)) {
      ancestors.unshift(d)
      if (Path.dirname(d) === d) break
    }
    for (const d of ancestors) scope = this.enter(scope, d)
    return scope
  }

  /** The verdict of the deepest ignore file of one kind that has one. */
  private decideKind(scope: Scope, kind: Kind, abs: string, isDir: boolean): Ignore.Decision {
    if ((kind === "gitignore" || kind === "exclude") && this.requireGit && !scope.inRepo) return undefined
    for (const d of scope.dirs) {
      const set = d[kind]
      const verdict = set === undefined ? undefined : Ignore.decide(set, relativeTo(set, abs), isDir)
      if (verdict !== undefined) return verdict
    }
    return undefined
  }

  /** The verdict of the ignore files on a path, in ripgrep's order of precedence. */
  decide(scope: Scope, abs: string, isDir: boolean): Ignore.Decision {
    if (!this.useIgnore && Arr.isReadonlyArrayEmpty(this.extra)) return undefined
    for (const kind of ignoreKinds) {
      const verdict = this.decideKind(scope, kind, abs, isDir)
      if (verdict !== undefined) return verdict
    }
    for (const set of this.extra) {
      const verdict = Ignore.decide(set, relativeTo(set, abs), isDir)
      if (verdict !== undefined) return verdict
    }
    const global = this.global
    if (global === undefined || (this.requireGit && !scope.inRepo)) return undefined
    return Ignore.decide(global, relativeTo(global, abs), isDir)
  }
}

/** A directory entry, with symbolic links resolved. */
interface Resolved {
  readonly name: string
  readonly abs: string
  readonly shown: string
  readonly isDir: boolean
  readonly stat: Fs.Stats | undefined
}

/** Where a directory walk is: its ignore scope, depth and ancestry. */
interface Place {
  readonly scope: Scope
  readonly depth: number
  readonly rootDev: number
  /** The real paths of the directories above, to detect loops with `-L`. */
  readonly seen: ReadonlySet<string>
}

const childPath = (display: string, name: string): string =>
  display === "" ? name : display.endsWith("/") ? display + name : `${display}/${name}`

class Walker {
  private readonly options: WalkOptions
  private readonly args: Args
  private readonly visit: (entry: Entry) => void
  private readonly rules: IgnoreRules
  private readonly sortGlobally: boolean
  private readonly collected: Array<{ readonly entry: Entry; readonly stat: Fs.Stats }> = []

  constructor(options: WalkOptions, visit: (entry: Entry) => void) {
    this.options = options
    this.args = options.args
    this.visit = visit
    this.rules = new IgnoreRules(options)
    const sort = this.args.sort
    this.sortGlobally = sort !== undefined && sort.by !== "none" && sort.by !== "path"
  }

  private emit(entry: Entry, stat: Fs.Stats | undefined): void {
    if (this.sortGlobally && stat !== undefined) this.collected.push({ entry, stat })
    else this.visit(entry)
  }

  root(root: string): void {
    if (root === "-") {
      this.visit({ path: "<stdin>", absolute: "", explicit: true, stdin: true })
      return
    }
    // The implicit root (no paths given) is the current directory, printed
    // without a "./" prefix.
    const abs = Path.resolve(this.options.cwd, root === "" ? "." : root)
    let stat: Fs.Stats
    try {
      stat = Fs.statSync(abs)
    } catch (error) {
      this.options.onError(`${root}: ${describeError(error)}`)
      return
    }
    if (!stat.isDirectory()) {
      this.emit({ path: root, absolute: abs, explicit: true, stdin: false }, stat)
      return
    }
    const scope = this.rules.enter(this.rules.rootScope(abs), abs)
    this.descend(abs, root, { scope, depth: 0, rootDev: stat.dev, seen: new Set([Fs.realpathSync(abs)]) })
  }

  private entries(dir: string, display: string): ReadonlyArray<Fs.Dirent> {
    let entries: Array<Fs.Dirent>
    try {
      entries = Fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      this.options.onError(`${display}: ${describeError(error)}`)
      return []
    }
    const sort = this.args.sort
    if (sort?.by !== "path") return entries
    const byName = Order.mapInput(Order.String, (d: Fs.Dirent) => d.name)
    return Arr.sort(entries, sort.reverse ? Order.flip(byName) : byName)
  }

  /** A directory entry's kind, following symbolic links with `-L`; `undefined` for anything not searched. */
  private resolve(dirent: Fs.Dirent, dir: string, display: string): Resolved | undefined {
    const name = dirent.name
    const abs = Path.join(dir, name)
    const shown = childPath(display, name)
    if (!dirent.isSymbolicLink()) {
      if (!dirent.isDirectory() && !dirent.isFile()) return undefined
      return { name, abs, shown, isDir: dirent.isDirectory(), stat: undefined }
    }
    if (!this.args.follow) return undefined
    try {
      const stat = Fs.statSync(abs)
      return stat.isDirectory() || stat.isFile() ? { name, abs, shown, isDir: stat.isDirectory(), stat } : undefined
    } catch (error) {
      this.options.onError(`${shown}: ${describeError(error)}`)
      return undefined
    }
  }

  /** `-g` overrides first; then ignore files, hidden names and `-t` / `-T`. */
  private admitted(entry: Resolved, scope: Scope): boolean {
    const override = this.overridden(entry)
    if (override !== undefined) return override === "whitelist"
    const verdict = this.rules.decide(scope, entry.abs, entry.isDir)
    if (verdict !== undefined) return verdict === "whitelist" && this.typed(entry)
    if (!this.args.hidden && entry.name.startsWith(".")) return false
    return this.typed(entry)
  }

  private typed(entry: Resolved): boolean {
    const types = this.options.types
    return entry.isDir || types === undefined || types(encoder.encode(entry.name))
  }

  private overridden(entry: Resolved): Ignore.Decision {
    const o = this.options.overrides
    if (o === undefined) return undefined
    const relative = toPosix(Path.relative(this.options.cwd, entry.abs))
    const verdict = Ignore.decide(o.set, relative.startsWith("..") ? toPosix(entry.shown) : relative, entry.isDir)
    if (verdict !== undefined) return verdict
    return o.hasWhitelist && !entry.isDir ? "ignore" : undefined
  }

  private descend(dir: string, display: string, place: Place): void {
    if (this.args.maxDepth !== undefined && place.depth >= this.args.maxDepth) return
    for (const dirent of this.entries(dir, display)) {
      const entry = this.resolve(dirent, dir, display)
      if (entry === undefined || !this.admitted(entry, place.scope)) continue
      if (entry.isDir) this.directory(entry, place)
      else this.file(entry)
    }
  }

  private directory(entry: Resolved, place: Place): void {
    const stat = entry.stat ?? Fs.statSync(entry.abs)
    if (this.args.oneFileSystem && stat.dev !== place.rootDev) return
    let seen = place.seen
    if (this.args.follow) {
      const real = Fs.realpathSync(entry.abs)
      if (seen.has(real)) {
        this.options.onError(`File system loop found: ${entry.shown} points to an ancestor ${real}`)
        return
      }
      seen = new Set([...seen, real])
    }
    const scope = this.rules.enter(place.scope, entry.abs)
    this.descend(entry.abs, entry.shown, { scope, depth: place.depth + 1, rootDev: place.rootDev, seen })
  }

  private file(entry: Resolved): void {
    const max = this.args.maxFilesize
    const stat = max !== undefined || this.sortGlobally ? (entry.stat ?? Fs.statSync(entry.abs)) : entry.stat
    if (max !== undefined && stat !== undefined && stat.size > max) return
    this.emit({ path: entry.shown, absolute: entry.abs, explicit: false, stdin: false }, stat)
  }

  /** With `--sort modified|accessed|created`: every file, in that order. */
  finish(): void {
    const sort = this.args.sort
    if (!this.sortGlobally || sort === undefined) return
    const key = (s: Fs.Stats): number =>
      sort.by === "modified" ? s.mtimeMs : sort.by === "accessed" ? s.atimeMs : s.birthtimeMs
    const byKey = Order.mapInput(Order.Number, (c: { readonly stat: Fs.Stats }) => key(c.stat))
    for (const { entry } of Arr.sort(this.collected, sort.reverse ? Order.flip(byKey) : byKey)) this.visit(entry)
  }
}

/**
 * Walks the given paths and calls `visit` for each file to search, in
 * order. With `--sort` other than `path`, all files are collected and sorted
 * first.
 *
 * @since 0.0.0
 */
export const walk = (roots: ReadonlyArray<string>, options: WalkOptions, visit: (entry: Entry) => void): void => {
  const walker = new Walker(options, visit)
  for (const root of roots) walker.root(root)
  walker.finish()
}

/**
 * A file's size in bytes, or 0 if it cannot be read.
 *
 * @since 0.0.0
 */
export const sizeOf = (path: string): number => {
  try {
    return Fs.statSync(path).size
  } catch {
    return 0
  }
}

/**
 * Whether a path names a directory (used to decide whether to print file
 * names by default).
 *
 * @since 0.0.0
 */
export const isDirectoryPath = isDirectory

/**
 * Builds the `-g` overrides, relative to `cwd`.
 *
 * @since 0.0.0
 */
export const buildOverrides = (args: Args, cwd: string): Result.Result<Ignore.Overrides | undefined, string> => {
  if (Arr.isReadonlyArrayEmpty(args.globs)) return Result.succeed(undefined)
  const globs = args.globs.map((g) => ({
    glob: g.glob,
    caseInsensitive: g.caseInsensitive || args.globCaseInsensitive
  }))
  return Ignore.overrides(cwd, globs)
}
