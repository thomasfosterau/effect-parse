import { Result } from "effect"
import { expect } from "vite-plus/test"
import type { Input, Parser, ParseError } from "../src/index.js"
import { Parser as P } from "../src/index.js"

/** Asserts that `parser` consumes all of `input` and produces `expected`. */
export const expectSuccess = <A, E, I extends Input.Input>(
  parser: Parser.Parser<A, E, never, I>,
  input: NoInfer<I>,
  expected: A
): void => {
  const result = P.parse(parser, input)
  if (Result.isFailure(result)) {
    throw new Error(`expected success, got:\n${result.failure.message}`)
  }
  expect(result.success).toEqual(expected)
}

/** Asserts that parsing fails, returning the error. */
export const expectFailure = <A, E, I extends Input.Input>(
  parser: Parser.Parser<A, E, never, I>,
  input: NoInfer<I>
): ParseError.ParseError<E> => {
  const result = P.parse(parser, input)
  if (Result.isSuccess(result)) {
    throw new Error(`expected failure, got: ${JSON.stringify(result.success)}`)
  }
  return result.failure
}

/** nom-style: returns `[remaining, output]`. */
export const peek = <A, E, I extends Input.Input>(parser: Parser.Parser<A, E, never, I>, input: NoInfer<I>) =>
  Result.mapError(P.parsePeek(parser, input), (e) => e.message)
