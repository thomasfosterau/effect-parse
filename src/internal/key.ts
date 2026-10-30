/**
 * Identity keys: a parser that keeps state across parses (resume
 * checkpoints, reusable syntax nodes) creates one `Key` when it is built and
 * looks its state up by that key's reference.
 */

/** A per-parser identity, compared by reference. */
export class Key {
  // Nominal: an empty class would accept any object
  declare private readonly brand: void
}
