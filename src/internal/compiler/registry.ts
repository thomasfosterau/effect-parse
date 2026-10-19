/**
 * The registry of compiled parsers, keyed by parser (see `Parser.compile`).
 * Compiled steps are built lazily, once per input kind.
 */
import type { State } from "../../Input.js"
import type { ParserLike } from "../node.js"
import type { Fallback, Step } from "./closure.js"
import { compileClosure } from "./closure.js"
import { compileJit, jitSupported } from "./jit.js"

/** Which compiler to use. */
export type Backend = "auto" | "closure"

/** What was compiled for a parser and an input kind. */
export interface Compiled {
  /** The compiler actually used. */
  readonly backend: "jit" | "closure" | undefined
  readonly step: Step | undefined
  /** Parts of the grammar that run interpreted, and why. */
  readonly fallbacks: ReadonlyArray<Fallback>
  /** Why compilation failed, if it did (the parser then runs interpreted). */
  readonly error: unknown
  /** Why the JIT failed, if it did (the closure compiler is then used). */
  readonly jitError?: unknown
  /** The generated source, for the JIT. */
  readonly source?: string
}

interface Entry {
  readonly backend: Backend
  readonly byKind: Array<Compiled | undefined>
}

const registry = /*#__PURE__*/ new WeakMap<ParserLike, Entry>()

export const register = (p: ParserLike, backend: Backend): void => {
  const entry = registry.get(p)
  if (entry === undefined || entry.backend !== backend) registry.set(p, { backend, byKind: [] })
}

export const isRegistered = (p: ParserLike): boolean => registry.has(p)

const build = (p: ParserLike, kind: 0 | 1 | 2, backend: Backend, resumable: boolean): Compiled => {
  if (backend === "auto" && jitSupported()) {
    try {
      const { fallbacks, source, step } = compileJit(p, kind, resumable)
      return { backend: "jit", step, fallbacks, error: undefined, source }
    } catch (error) {
      // Fall back to the closure compiler, remembering why
      return { ...buildClosure(p, kind, resumable), jitError: error }
    }
  }
  return buildClosure(p, kind, resumable)
}

const buildClosure = (p: ParserLike, kind: 0 | 1 | 2, resumable: boolean): Compiled => {
  try {
    const { fallbacks, step } = compileClosure(p, kind, resumable)
    return { backend: "closure", step, fallbacks, error: undefined }
  } catch (error) {
    return { backend: undefined, step: undefined, fallbacks: [], error }
  }
}

/**
 * The compiled form of a registered parser for an input kind, compiling it
 * if needed. `resumable` selects the build used by streaming parses, which
 * supports partial input and checkpoints.
 */
export const compiled = (p: ParserLike, kind: 0 | 1 | 2, resumable = false): Compiled | undefined => {
  const entry = registry.get(p)
  if (entry === undefined) return undefined
  const index = resumable ? kind + 3 : kind
  return entry.byKind[index] ??= build(p, kind, entry.backend, resumable)
}

/** The compiled step for running `p` on `state`, if it is registered. */
export const stepFor = (p: ParserLike, state: State<any>, resumable = false): Step | undefined =>
  compiled(p, state.inputKind, resumable)?.step
