/**
 * The tree builder behind the `Syntax` module (see `docs/DESIGN.md`,
 * "Syntax trees").
 *
 * Trees are stored as *green* nodes, as in Roslyn and rust-analyzer: a green
 * node knows its kind, its width and its children's offsets relative to its
 * own start, but not where it is in the input or who its parent is. A subtree
 * that an edit doesn't touch can therefore be shared, unchanged, by the tree
 * before the edit and the tree after it. `Syntax.SyntaxNode` is the *red*
 * view: a green node, its absolute start and its parent, built lazily while
 * navigating.
 *
 * While parsing, completed nodes wait on a stack until the node around them
 * completes and adopts them. Nodes built by an attempt that is later
 * abandoned must not end up in the tree. Every combinator that abandons an
 * attempt moves the cursor back to (or before) where the attempt started,
 * and every node has a positive width, so the nodes of an abandoned attempt
 * are exactly those that end after the position the cursor moves back to:
 * the `pos` setter of {@link SyntaxState} drops them. This also covers
 * lookahead (`peek`, `not`) and custom parsers written with `Parser.make`.
 *
 * For incremental parsing, every node records how far its parse looked: the
 * furthest position the cursor reached and the furthest failure recorded
 * while it was being parsed (its *lookahead*). A node from the previous tree
 * is reused at a position when it was built by the same `Syntax.node`, and
 * the input it looked at, plus a margin for the tokens that read a little
 * past where they stop, is unchanged.
 */
import type * as Context from "effect/Context"
import type { Encoding } from "../Encoding.js"
import type { ErrMode, Input, Source } from "../Input.js"
import { Fail, Failure, State } from "../Input.js"

/** What a failure inside an `ERROR` node was. Offsets are relative to the node. */
export interface ErrorInfo {
  readonly failure: Failure
  readonly mode: ErrMode
}

/** A position-independent syntax tree node. */
export class Green {
  constructor(
    readonly kind: string,
    readonly named: boolean,
    /** The `Syntax.node` that built it; `undefined` for roots and errors, which are never reused alone. */
    readonly key: object | undefined,
    readonly width: number,
    /** How far its parse looked, relative to its start (at least `width`). */
    readonly lookahead: number,
    readonly children: ReadonlyArray<Green>,
    /** The children's starts, relative to this node's start. */
    readonly offsets: ReadonlyArray<number>,
    /** The children's field names, when any child has one. */
    readonly fields: ReadonlyArray<string | undefined> | undefined,
    readonly value: unknown,
    /** Set on `ERROR` nodes. */
    readonly error: ErrorInfo | undefined,
    /** Whether this node or a descendant is an `ERROR` node. */
    readonly hasError: boolean,
    /** What its parse left behind for error reporting, replayed when it is reused. */
    readonly diagnostics: Diagnostics | undefined
  ) {}
}

/**
 * The error-reporting state a node's parse leaves behind (see
 * `State.deepest` and `State.setHint`). A reused node replays it, so that
 * a reparse reports the errors a fresh parse does.
 */
export interface Diagnostics {
  /** The furthest failure, at its offset in the parse that built the node... */
  readonly deepest: Failure | undefined
  /** ...which started the node at `base`. */
  readonly base: number
  /** Relative to the node's start. */
  readonly hintOffset: number
  readonly hintExpected: ReadonlyArray<string> | undefined
}

/** A completed node waiting for its parent, at an absolute position. */
class Child {
  constructor(
    readonly green: Green,
    readonly start: number,
    readonly end: number,
    public field: string | undefined
  ) {}
}

export const errorKind = "ERROR"

const rebase = (f: Failure, start: number): Failure =>
  new Failure(f.offset - start, f.kind, f.expected, f.context, f.hasCause, f.cause, f.message, f.needed)

/** Moves a failure stored relative to a node back to absolute offsets. */
export const absolute = (f: Failure, start: number): Failure => rebase(f, -start)

/**
 * Builds a green node over `[start, end)` from the children waiting on the
 * stack.
 */
export const build = (
  kind: string,
  named: boolean,
  key: object | undefined,
  start: number,
  end: number,
  lookahead: number,
  entries: ReadonlyArray<Child>,
  value: unknown,
  error: ErrorInfo | undefined,
  diagnostics?: Diagnostics
): Green => {
  const n = entries.length
  const children = new Array<Green>(n)
  const offsets = new Array<number>(n)
  let fields: Array<string | undefined> | undefined
  let hasError = error !== undefined
  for (let i = 0; i < n; i++) {
    const e = entries[i]!
    children[i] = e.green
    offsets[i] = e.start - start
    if (e.green.hasError) hasError = true
    if (e.field !== undefined) (fields ??= new Array(n).fill(undefined))[i] = e.field
  }
  const width = end - start
  const looked = Math.max(lookahead, end) - start
  return new Green(kind, named, key, width, looked, children, offsets, fields, value, error, hasError, diagnostics)
}

/**
 * A stretch of the new input copied unchanged from the previous one:
 * `[newStart, newStart + length)` is `[oldStart, oldStart + length)`.
 */
export interface Segment {
  readonly newStart: number
  readonly oldStart: number
  readonly length: number
}

/** What a reparse may reuse. */
export interface Previous {
  readonly root: Green
  readonly oldLength: number
  readonly newLength: number
  readonly segments: ReadonlyArray<Segment>
  readonly input: Input
  /** How far past its lookahead a parser may have read, besides a token at the lookahead. */
  readonly extra: number
  readonly encoding: Encoding<any> | undefined
}

/** The hooks that `Syntax` combinators and `Parser.resumeAfter`/`retryAfter` call. */
export interface Builder {
  node(state: State<any>, step: (state: State<any>) => unknown, key: object, kind: string, named: boolean): unknown
  field(state: State<any>, step: (state: State<any>) => unknown, name: string): unknown
  /** After error recovery: `[start, pos)` was skipped after `failure`. */
  skipped(start: number, failure: Failure, mode: ErrMode): void
  /**
   * Called by token parsers that read input up to `end` (exclusive) beyond
   * where they leave the cursor or record a failure.
   */
  read(end: number): void
}

/** The parse state of a `Syntax` parse. */
export class SyntaxState<I extends Input = Input> extends State<I> implements Builder {
  // Declared, not defined: `State`'s constructor sets `pos` through the
  // accessor below before these could be initialized
  declare cursor: number
  /** The furthest position the cursor reached, or failure recorded, since the innermost open node started. */
  declare highWater: number
  /** Completed nodes waiting for their parent, in input order. */
  declare stack: Array<Child>
  declare previous: Previous | undefined
  /** How many nodes were reused from the previous tree. */
  declare reused: number
  /** Where {@link find} found the last node it found. */
  declare lastParent: Green | undefined
  declare lastParentStart: number

  static {
    Object.defineProperty(this.prototype, "pos", {
      get(this: SyntaxState) {
        return this.cursor
      },
      set(this: SyntaxState, p: number) {
        if (p < this.cursor) {
          // An attempt was abandoned (or a lookahead finished): drop its nodes
          const stack = this.stack
          while (stack.length > 0 && stack[stack.length - 1]!.end > p) stack.pop()
        }
        if (p > this.highWater) this.highWater = p
        this.cursor = p
      },
      configurable: true,
      enumerable: true
    })
  }

  constructor(source: I | Source<I>, options: {
    readonly context?: Context.Context<never> | undefined
  }, previous: Previous | undefined) {
    super(source, { context: options.context })
    this.highWater = this.cursor
    this.stack = []
    this.previous = previous
    this.reused = 0
    this.lastParent = undefined
    this.lastParentStart = 0
    this.syntax = this
    // Error recovery is always on: like Tree-sitter, a syntax parse always produces a tree
    this.recovered = []
  }

  override failWith(mode: ErrMode, failure: Failure): Fail {
    if (failure.offset > this.highWater) this.highWater = failure.offset
    return super.failWith(mode, failure)
  }

  override setHint(offset: number, expected: ReadonlyArray<string>): void {
    if (offset > this.highWater) this.highWater = offset
    super.setHint(offset, expected)
  }

  node(state: State<any>, step: (state: State<any>) => unknown, key: object, kind: string, named: boolean): unknown {
    const start = this.cursor
    const stack = this.stack
    if (this.previous !== undefined) {
      const green = this.reusable(key, start)
      if (green !== undefined) {
        this.reused++
        const end = start + green.width
        state.pos = end
        const looked = start + green.lookahead
        if (looked > this.highWater) this.highWater = looked
        const d = green.diagnostics
        if (d !== undefined) {
          if (d.deepest !== undefined) this.deepen(start === d.base ? d.deepest : rebase(d.deepest, d.base - start))
          if (d.hintExpected !== undefined) this.setHint(start + d.hintOffset, d.hintExpected)
        }
        stack.push(new Child(green, start, end, undefined))
        return green.value
      }
    }
    const mark = stack.length
    const outer = this.highWater
    const outerDeepest = this.deepest
    const hintOffset = this.hintOffset
    const hintExpected = this.hintExpected
    this.highWater = start
    // Collect the furthest failure of this node alone, then merge it as `failWith` would have
    this.deepest = undefined
    const a = step(state)
    const looked = this.highWater
    if (outer > looked) this.highWater = outer
    const deepest = this.deepest as Failure | undefined
    this.deepest = outerDeepest
    if (deepest !== undefined) this.deepen(deepest)
    if (a === Fail) {
      if (stack.length > mark) stack.length = mark
      return a
    }
    const end = this.cursor
    // Like Tree-sitter's rules, nodes are never empty: an empty match adds nothing to the tree
    if (end === start) return a
    const hinted = this.hintOffset !== hintOffset || this.hintExpected !== hintExpected
    const diagnostics: Diagnostics | undefined = deepest === undefined && !hinted ? undefined : {
      deepest,
      base: start,
      hintOffset: this.hintOffset - start,
      hintExpected: hinted ? this.hintExpected : undefined
    }
    const entries = stack.splice(mark)
    stack.push(new Child(build(kind, named, key, start, end, looked, entries, a, undefined, diagnostics), start, end, undefined))
    return a
  }

  read(end: number): void {
    // `highWater` is the last position looked at, `end` is exclusive
    if (end - 1 > this.highWater) this.highWater = end - 1
  }

  /** Records `failure` as the furthest failure if it is, as `failWith` does. */
  private deepen(failure: Failure): void {
    if (this.deepest === undefined || failure.offset >= this.deepest.offset) this.deepest = failure
  }

  field(state: State<any>, step: (state: State<any>) => unknown, name: string): unknown {
    const stack = this.stack
    const mark = stack.length
    const a = step(state)
    if (a !== Fail) for (let i = mark; i < stack.length; i++) stack[i]!.field = name
    return a
  }

  skipped(start: number, failure: Failure, mode: ErrMode): void {
    const stack = this.stack
    let i = stack.length
    while (i > 0 && stack[i - 1]!.start >= start && stack[i - 1]!.end > start) i--
    const end = this.cursor
    const green = build(errorKind, true, undefined, start, end, this.highWater, stack.splice(i), undefined, {
      failure: rebase(failure, start),
      mode
    })
    stack.push(new Child(green, start, end, undefined))
  }

  /**
   * Builds the root over the whole input from the nodes left on the stack.
   * When the parse failed, or stopped before the end, the rest of the input
   * becomes an `ERROR` node.
   */
  finish(kind: string, value: unknown, fatal: ErrorInfo | undefined, errorStart: number): Green {
    const entries = this.stack.splice(0)
    const end = this.end
    if (fatal !== undefined) {
      const last = entries.length > 0 ? entries[entries.length - 1]!.end : 0
      const start = Math.max(Math.min(errorStart, end), last)
      const error = build(errorKind, true, undefined, start, end, end, [], undefined, {
        failure: rebase(fatal.failure, start),
        mode: fatal.mode
      })
      entries.push(new Child(error, start, end, undefined))
    }
    return build(kind, true, undefined, 0, end, Math.max(end, this.highWater), entries, value, undefined)
  }

  /**
   * The outermost node of the previous tree built by `key` that starts at
   * `offset`. Reused nodes are mostly siblings, found one after the other,
   * so the search starts from the parent of the last one found when
   * `offset` lies inside it: no ancestor of that parent can start there.
   */
  private find(offset: number, key: object): Green | undefined {
    let node = this.previous!.root
    let start = 0
    const last = this.lastParent
    if (last !== undefined && offset > this.lastParentStart && offset < this.lastParentStart + last.width) {
      node = last
      start = this.lastParentStart
    }
    while (true) {
      const offsets = node.offsets
      // The last child starting at or before `offset`
      let lo = 0
      let hi = offsets.length - 1
      let found = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (start + offsets[mid]! <= offset) {
          found = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      if (found < 0) return undefined
      const child = node.children[found]!
      const childStart = start + offsets[found]!
      if (offset >= childStart + child.width) return undefined
      if (childStart === offset && child.key === key) {
        this.lastParent = node
        this.lastParentStart = start
        return child
      }
      node = child
      start = childStart
    }
  }

  /** The node of the previous tree built by `key` at `pos` (in the new input), if it can be reused. */
  private reusable(key: object, pos: number): Green | undefined {
    const previous = this.previous!
    const segments = previous.segments
    // The segment containing `pos`
    let lo = 0
    let hi = segments.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const seg = segments[mid]!
      if (pos < seg.newStart) hi = mid - 1
      else if (pos >= seg.newStart + seg.length) lo = mid + 1
      else {
        const old = seg.oldStart + (pos - seg.newStart)
        const green = this.find(old, key)
        if (green === undefined) return undefined
        const segEnd = seg.oldStart + seg.length
        // The input it looked at must be unchanged; past the end of both inputs counts as unchanged
        if (old + green.lookahead + tokenWidth(previous.input, old + green.lookahead) + previous.extra <= segEnd) {
          return green
        }
        if (segEnd === previous.oldLength && seg.newStart + seg.length === previous.newLength) return green
        return undefined
      }
    }
    return undefined
  }
}

/**
 * How many units a token parser may read at `offset`, where a parse
 * stopped looking: one code point. Of a string, that is two units at a high
 * surrogate. Of bytes in an unknown encoding, up to four.
 */
const tokenWidth = (input: Input, offset: number): number => {
  if (typeof input === "string") {
    const c = input.charCodeAt(offset)
    return c >= 0xd800 && c <= 0xdbff ? 2 : 1
  }
  return input instanceof Uint8Array ? 4 : 1
}
