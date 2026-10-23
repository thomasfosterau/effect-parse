/**
 * Tied failures, merged only when read.
 *
 * A combinator that tries several parsers at the same position (an
 * alternation, a permutation round, an operator table) reports the merge
 * of their failures, left to right, as `mergeFailures` would. Most of the
 * time one of the later attempts succeeds and the merge is thrown away, so
 * {@link TiedFailures} keeps the last two failures tied with the running
 * one unmerged, and {@link TiedFailures.fail} hands them to the state with
 * `State.failTies`, which merges them on first read (#38, #44).
 *
 * `Parser.alt` does the same fold in locals, since it is the hottest
 * combinator and cannot afford an accumulator per call.
 */
import type { Failure, Fail, Input, State } from "../Input.js"
import { mergeExpected, mergeTiedFailures } from "../Input.js"

/** The failures of a round of attempts, folded lazily. */
export class TiedFailures {
  /** The running failure, before the pending ties are merged into it. */
  failure: Failure | undefined = undefined
  /** The oldest pending tie, at `failure`'s offset. */
  tie1: Failure | undefined = undefined
  /** The newest pending tie, at `failure`'s offset. */
  tie2: Failure | undefined = undefined

  /** Forgets every failure, for a new round. */
  clear(): void {
    this.failure = undefined
    this.tie1 = undefined
    this.tie2 = undefined
  }

  /**
   * Folds in the failure the latest attempt left on `state`, taking over
   * its own unmerged ties when it is the furthest.
   */
  add<I extends Input>(state: State<I>): void {
    const head = state.failureHead
    const running = this.failure
    if (running === undefined || head.offset > running.offset) {
      this.failure = head
      this.tie1 = state.failureTie1
      this.tie2 = state.failureTie2
      return
    }
    if (head.offset < running.offset) return
    const failure = state.failure
    const tie1 = this.tie1
    if (tie1 === undefined) this.tie1 = failure
    else if (this.tie2 === undefined) this.tie2 = failure
    else {
      // A third tie: fold the oldest pending one in, keeping the order
      this.failure = mergeTiedFailures(running, tie1, mergeExpected(running.expected, tie1.expected))
      this.tie1 = this.tie2
      this.tie2 = failure
    }
  }

  /**
   * Fails `state` with the folded failure (recoverably), or with its
   * current failure when nothing was folded.
   */
  fail<I extends Input>(state: State<I>): Fail {
    const failure = this.failure
    if (failure === undefined) return state.failWith("Backtrack", state.failure)
    const tie1 = this.tie1
    return tie1 === undefined ? state.failWith("Backtrack", failure) : state.failTies(failure, tie1, this.tie2)
  }

  /**
   * Records the folded expectations as a hint when the folded failure lies
   * where `state` stopped (an attempt that fails without consuming input).
   */
  hint<I extends Input>(state: State<I>): void {
    const failure = this.failure
    if (failure === undefined || failure.offset !== state.pos) return
    let expected = failure.expected
    if (this.tie1 !== undefined) expected = mergeExpected(expected, this.tie1.expected)
    if (this.tie2 !== undefined) expected = mergeExpected(expected, this.tie2.expected)
    state.setHint(failure.offset, expected)
  }
}
