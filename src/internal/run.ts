/**
 * Running a parser on a caller-owned `State`, compiled when possible.
 *
 * Shared by `Parser.run` and `ParserStream.parseMany`, which keep one
 * state across many small runs.
 */
import { Fail, type State } from "../Input.js"
import * as Registry from "./compiler/registry.js"
import type { ParserLike } from "./node.js"
import * as Stack from "./stack.js"

/**
 * Runs `p` on `state` from `state.pos`: its compiled form when it has one
 * and the state allows it, else its step. A compiled run that fails is
 * thrown away and the step runs again from the same position, so a
 * failure leaves the state exactly as the interpreter would; with
 * `diagnostics` false it is not, and the state keeps the compiled run's
 * `mode`, with the cursor back at the start. Partial states (and states
 * with streaming checkpoints) use the resumable build.
 */
export const runOn = <A>(
  p: ParserLike,
  step: (state: State<any>) => A | Fail,
  state: State<any>,
  diagnostics: boolean = true
): A | Fail => {
  if (state.tracer !== undefined || state.recovered !== undefined || state.syntax !== undefined) {
    return Stack.run(step, state)
  }
  const compiled = Registry.compiled(p, state.inputKind, state.partial || state.resume !== undefined)
  return compiled === undefined ? Stack.run(step, state) : attempt(compiled, step, state, diagnostics)
}

/**
 * Runs a compiled step on `state`: directly when it guards against
 * call-stack overflows itself (the JIT's), else under `Stack.run`.
 */
export const runCompiled = <A>(step: (state: State<any>) => A, guarded: boolean, state: State<any>): A | Fail =>
  guarded ? step(state) : Stack.run(step, state)

/**
 * Runs the compiled step of `compiled` (or, if compiling failed, the
 * parser's); if it fails, rewinds and, with `diagnostics`, runs the
 * parser's step to record the failure.
 */
const attempt = <A>(
  compiled: Registry.Compiled,
  step: (state: State<any>) => A | Fail,
  state: State<any>,
  diagnostics: boolean
): A | Fail => {
  const c = compiled.step
  if (c === undefined) return Stack.run(step, state)
  const start = state.pos
  const a = runCompiled(c, compiled.guarded, state)
  if (a !== Fail) {
    // SAFETY: the compiled step returns what the parser's step returns
    return a as A
  }
  state.rewind(start)
  return diagnostics ? Stack.run(step, state) : Fail
}

/** What `prepare` holds before its first run: nothing compiled. */
const uncompiled: Registry.Compiled = {
  backend: "interpreted",
  step: undefined,
  guarded: false,
  fallbacks: [],
  error: undefined
}

/**
 * `runOn(p, p.step, state, diagnostics)` as a function of the state, with
 * the per-run lookup done once: the compiled step is looked up again only
 * when the input kind or the build (plain or resumable) changes from the
 * previous run.
 */
export const prepare = <A>(
  p: ParserLike,
  step: (state: State<any>) => A | Fail,
  diagnostics: boolean
): ((state: State<any>) => A | Fail) => {
  // The build of the previous run: its input kind (-1 before the first run) and whether it is resumable
  let kind = -1
  let resumable = false
  let compiled = uncompiled
  return (state) => {
    if (state.tracer !== undefined || state.recovered !== undefined || state.syntax !== undefined) {
      return Stack.run(step, state)
    }
    const r = state.partial || state.resume !== undefined
    if (state.inputKind !== kind || r !== resumable) {
      compiled = Registry.compiled(p, state.inputKind, r) ?? uncompiled
      kind = state.inputKind
      resumable = r
    }
    return attempt(compiled, step, state, diagnostics)
  }
}
