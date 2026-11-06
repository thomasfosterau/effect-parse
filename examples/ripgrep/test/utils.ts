import * as Formatter from "effect/Formatter"
import * as Result from "effect/Result"
import { assert } from "vite-plus/test"

/** The success of `result`, failing the test on a failure. */
export const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) return assert.fail(`expected success, got: ${Formatter.format(result.failure)}`)
  return result.success
}
