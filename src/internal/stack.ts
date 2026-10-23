/**
 * Call-stack overflows.
 *
 * The interpreter and the compiled backends recurse once (or more) per
 * nesting level of a recursive grammar, so deeply nested input, such as
 * thousands of `{`, can exhaust the call stack. The runners catch the
 * engine's overflow error and report a `TooDeep` failure instead, keeping
 * their `Result` contract on untrusted input.
 */
import * as Predicate from "effect/Predicate"
import type { Fail, State } from "../Input.js"

/** The message of a `TooDeep` failure. */
const tooDeepMessage = "input is nested too deeply: parsing exhausted the call stack"

/**
 * Whether `e` is the engine's call-stack overflow: a `RangeError` in V8
 * and JavaScriptCore, an `InternalError` ("too much recursion") in
 * SpiderMonkey.
 */
export const isStackOverflow = (e: unknown): boolean =>
  (e instanceof RangeError && /call stack/i.test(e.message)) ||
  (Predicate.hasProperty(e, "name") &&
    Predicate.hasProperty(e, "message") &&
    e.name === "InternalError" &&
    Predicate.isString(e.message) &&
    /recursion/i.test(e.message))

/**
 * Runs `step`, turning a call-stack overflow into an unrecoverable
 * `TooDeep` failure at the offset parsing had reached. Other exceptions
 * propagate.
 */
export const run = <S extends State<any>, A>(step: (state: S) => A, state: S): A | Fail => {
  try {
    return step(state)
  } catch (e) {
    if (!isStackOverflow(e)) throw e
    return state.failMessage("Cut", "TooDeep", tooDeepMessage)
  }
}
