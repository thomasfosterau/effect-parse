/**
 * Finds the next occurrence of any of a few byte strings, with the native
 * `Buffer#indexOf` (a vectorised substring search) per string, caching each
 * string's next occurrence so the input is scanned once per string.
 *
 * @since 0.0.0
 */
import { Buffer } from "node:buffer"

/**
 * A multi-literal search over one haystack at a time.
 *
 * @since 0.0.0
 */
export class LiteralFinder {
  private readonly literals: ReadonlyArray<Uint8Array>
  private readonly next: Float64Array
  private readonly from: Float64Array
  private haystack: Uint8Array | undefined = undefined
  private view: Buffer = Buffer.alloc(0)

  constructor(literals: ReadonlyArray<Uint8Array>) {
    this.literals = literals
    this.next = new Float64Array(literals.length)
    this.from = new Float64Array(literals.length)
  }

  private use(haystack: Uint8Array): void {
    if (this.haystack === haystack) return
    this.haystack = haystack
    this.view = Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength)
    this.from.fill(Infinity)
  }

  /** The offset of the first occurrence at or after `pos` of any literal, or -1. */
  find(haystack: Uint8Array, pos: number): number {
    this.use(haystack)
    let best = Infinity
    for (let i = 0; i < this.literals.length; i++) {
      if (!(this.from[i] <= pos && pos <= this.next[i])) {
        const at = this.view.indexOf(this.literals[i], pos)
        this.next[i] = at < 0 ? Infinity : at
        this.from[i] = pos
      }
      if (this.next[i] < best) best = this.next[i]
    }
    return best === Infinity ? -1 : best
  }

  /** The first literal, in priority order, that occurs at `pos`, or undefined. */
  literalAt(haystack: Uint8Array, pos: number): Uint8Array | undefined {
    outer: for (const lit of this.literals) {
      if (pos + lit.length > haystack.length) continue
      for (let k = 0; k < lit.length; k++) if (haystack[pos + k] !== lit[k]) continue outer
      return lit
    }
    return undefined
  }
}
