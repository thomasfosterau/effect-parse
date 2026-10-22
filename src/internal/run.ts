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
 * failure leaves the state exactly as the interpreter would. Partial states
 * (and states with streaming checkpoints) use the resumable build.
 */
export const runOn = <A>(p: ParserLike, step: (state: State<any>) => A | Fail, state: State<any>): A | Fail => {
  if (state.tracer === undefined && state.recovered === undefined && state.syntax === undefined) {
    const compiled = Registry.stepFor(p, state, state.partial || state.resume !== undefined)
    if (compiled !== undefined) {
      const start = state.pos
      const a = Stack.run(compiled, state)
      if (a !== Fail) {
        // SAFETY: the compiled step returns what the parser's step returns
        return a as A
      }
      state.pos = start
    }
  }
  return Stack.run(step, state)
}
