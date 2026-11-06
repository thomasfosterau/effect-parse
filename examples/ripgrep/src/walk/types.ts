/**
 * File types (`-t`, `-T`, `--type-add`, `--type-clear`, `--type-list`):
 * named sets of globs matched against file names.
 *
 * @since 0.0.0
 */
import * as Arr from "effect/Array"
import * as Order from "effect/Order"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import type { TypeRule } from "../cli/args.ts"
import { defaultTypes } from "./defaultTypes.ts"
import * as Glob from "./glob.ts"

/**
 * Type names and their globs, sorted by name.
 *
 * @since 0.0.0
 */
export type Definitions = ReadonlyMap<string, ReadonlyArray<string>>

/**
 * Applies `--type-add` and `--type-clear` to the default definitions.
 * `name:include:a,b` adds the globs of types `a` and `b`.
 *
 * @since 0.0.0
 */
export const definitions = (rules: ReadonlyArray<TypeRule>): Result.Result<Definitions, string> => {
  const defs = new Map<string, Array<string>>(defaultTypes.map(([name, globs]) => [name, [...globs]]))
  for (const rule of rules) {
    if (rule.kind === "clear") defs.delete(rule.value)
    if (rule.kind !== "add") continue
    const added = add(defs, rule.value)
    if (added !== undefined) return Result.fail(added)
  }
  const byName = Order.mapInput(Order.String, (entry: readonly [string, ReadonlyArray<string>]) => entry[0])
  return Result.succeed(new Map(Arr.sort(defs, byName)))
}

/** The globs a `--type-add` spec adds: a glob, or `include:` other types' globs. */
const specGlobs = (defs: ReadonlyMap<string, ReadonlyArray<string>>, spec: string): ReadonlyArray<string> | string => {
  if (!spec.startsWith("include:")) return [spec]
  const globs: Array<string> = []
  for (const other of spec.slice("include:".length).split(",")) {
    const included = defs.get(other)
    if (included === undefined) return `unrecognized file type: ${other}`
    globs.push(...included)
  }
  return globs
}

/** Applies one `--type-add`; returns an error message for a malformed one. */
const add = (defs: Map<string, Array<string>>, value: string): string | undefined => {
  const colon = value.indexOf(":")
  if (colon <= 0) return `invalid definition (format is type:glob, e.g., html:*.html): ${value}`
  const name = value.slice(0, colon)
  const globs = specGlobs(defs, value.slice(colon + 1))
  if (Predicate.isString(globs)) return globs
  defs.set(name, [...(defs.get(name) ?? []), ...globs])
  return undefined
}

/**
 * A predicate over file names: whether `-t` / `-T` let a file through.
 *
 * @since 0.0.0
 */
export type Filter = (name: Uint8Array) => boolean

const compileAll = (globs: ReadonlyArray<string>): Result.Result<ReadonlyArray<Glob.Glob>, string> => {
  const out: Array<Glob.Glob> = []
  for (const g of globs) {
    const compiled = Glob.compileGlob(g, false)
    if (Result.isFailure(compiled)) return Result.fail(compiled.failure)
    out.push(compiled.success)
  }
  return Result.succeed(out)
}

const globsOf = (defs: Definitions, name: string): Result.Result<ReadonlyArray<string>, string> => {
  if (name === "all") return Result.succeed([...defs.values()].flat())
  const globs = defs.get(name)
  return globs === undefined ? Result.fail(`unrecognized file type: ${name}`) : Result.succeed(globs)
}

/**
 * The filter for the `-t` / `-T` selections, or `undefined` when there are
 * none. A file passes if it matches a selected type (when any are selected)
 * and no negated one.
 *
 * @since 0.0.0
 */
export const filter = (
  defs: Definitions,
  rules: ReadonlyArray<TypeRule>
): Result.Result<Filter | undefined, string> => {
  const selected: Array<string> = []
  const negated: Array<string> = []
  for (const rule of rules) {
    if (rule.kind !== "select" && rule.kind !== "negate") continue
    const globs = globsOf(defs, rule.value)
    if (Result.isFailure(globs)) return Result.fail(globs.failure)
    ;(rule.kind === "select" ? selected : negated).push(...globs.success)
  }
  if (Arr.isReadonlyArrayEmpty(selected) && Arr.isReadonlyArrayEmpty(negated)) {
    const anySelect = rules.some((r) => r.kind === "select")
    return Result.succeed(anySelect ? () => false : undefined)
  }
  const include = compileAll(selected)
  const exclude = compileAll(negated)
  if (Result.isFailure(include)) return Result.fail(include.failure)
  if (Result.isFailure(exclude)) return Result.fail(exclude.failure)
  const inc = include.success
  const exc = exclude.success
  const anySelect = rules.some((r) => r.kind === "select")
  return Result.succeed((name: Uint8Array) => {
    if (exc.some((g) => g.matches(name))) return false
    return !anySelect || inc.some((g) => g.matches(name))
  })
}

/**
 * The `--type-list` output: `name: glob, glob` per line.
 *
 * @since 0.0.0
 */
export const list = (defs: Definitions): string =>
  [...defs].map(([name, globs]) => `${name}: ${globs.join(", ")}\n`).join("")
