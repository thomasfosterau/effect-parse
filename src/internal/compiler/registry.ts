/**
 * The registry of compiled parsers, keyed by parser (see the `Compiler`
 * module). Compiled steps are built lazily, once per input kind.
 *
 * Nothing here imports a compiler: a parser is registered with the backend
 * that compiles it, so a program bundles only the backends it uses.
 */
import type { State } from "../../Input.js"
import type { ParserLike } from "../node.js"
import type { Fallback, Step } from "./closure.js"

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

/** A compiler: builds the compiled form of a parser for an input kind. */
export interface Backend {
  readonly build: (p: ParserLike, kind: 0 | 1 | 2, resumable: boolean) => Compiled
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

/**
 * The compiled form of a registered parser for an input kind, compiling it
 * if needed. `resumable` selects the build used by streaming parses, which
 * supports partial input and checkpoints.
 */
export const compiled = (p: ParserLike, kind: 0 | 1 | 2, resumable = false): Compiled | undefined => {
  const entry = registry.get(p)
  if (entry === undefined) return undefined
  const index = resumable ? kind + 3 : kind
  return entry.byKind[index] ??= entry.backend.build(p, kind, resumable)
}

/** The compiled step for running `p` on `state`, if it is registered. */
export const stepFor = (p: ParserLike, state: State<any>, resumable = false): Step | undefined =>
  compiled(p, state.inputKind, resumable)?.step
