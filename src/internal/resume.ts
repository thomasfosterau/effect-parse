/**
 * Checkpoints for resumable (streaming) parses.
 *
 * In partial mode a parser only succeeds on what it has seen, so a value
 * parsed from a prefix of the input stays the same when more input
 * arrives. A repetition that runs out of input mid-way can therefore record
 * how far it got (its accumulator and position) before the failure
 * propagates. When the parse is attempted again with more input, the same
 * repetition, entered at the same offset, takes its checkpoint and carries
 * on from there instead of re-parsing every element.
 *
 * Checkpoints are keyed by a per-parser key and the offset the repetition
 * started at. Taking a checkpoint removes it, so its accumulator has a
 * single owner; the repetition saves a new one if it runs out again.
 *
 * A resumed repetition that then completes leaves a {@link Done}
 * checkpoint with its result, since the input may still run out after it
 * (in trailing whitespace, say) and the next attempt would otherwise parse
 * it all again. `Done` checkpoints stay in place when taken.
 */
import type { State } from "../Input.js"

/** The checkpoints of a resumable parse. */
export type Checkpoints = Map<object, Map<number, unknown>>

/** Takes (and removes) the checkpoint of `key` entered at `offset`, if any. */
export const take = (state: State<any>, key: object, offset: number): unknown => {
  const byKey = state.resume?.get(key)
  if (byKey === undefined) return undefined
  const checkpoint = byKey.get(offset)
  if (checkpoint !== undefined && !(checkpoint instanceof Done)) byKey.delete(offset)
  return checkpoint
}

/** The result of a repetition that completed, and where it ended. */
export class Done {
  constructor(
    readonly value: unknown,
    readonly pos: number
  ) {}
}

/**
 * Returns `value`, the result of a repetition entered at `entry`; when the
 * repetition was resumed from a checkpoint, records it as {@link Done}.
 */
export const done = <A>(state: State<any>, key: object, entry: number, resumed: boolean, value: A): A => {
  if (resumed && state.resume !== undefined) save(state, key, entry, new Done(value, state.pos))
  return value
}

/** Records the checkpoint of `key` entered at `offset`. */
export const save = (state: State<any>, key: object, offset: number, checkpoint: unknown): void => {
  const resume = state.resume
  if (resume === undefined) return
  let byKey = resume.get(key)
  if (byKey === undefined) resume.set(key, (byKey = new Map()))
  byKey.set(offset, checkpoint)
}
