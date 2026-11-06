/**
 * The searcher: finds the matching lines of one buffer and reports them,
 * with their context, to a {@link Sink}.
 *
 * The whole buffer is searched at once, as ripgrep does: the matcher finds
 * the next match anywhere after the cursor, and the lines it touches are
 * reported as one group. Outside multiline mode the line terminator is
 * removed from every class, so a match never crosses a line.
 *
 * @since 0.0.0
 */
import { Buffer } from "node:buffer"
import { Input } from "@thomasfosterau/effect-parse"
import type { Match, Matcher } from "../regex/compile.ts"
import * as Arr from "effect/Array"

/**
 * How binary files (those containing a NUL byte) are handled: ripgrep stops
 * searching implicit files at the first NUL (`quit`), searches explicit ones
 * but prints a notice instead of lines (`convert`), and with `-a` treats
 * every file as text (`none`).
 *
 * @since 0.0.0
 */
export type BinaryMode = "quit" | "convert" | "none"

/**
 * The searcher's settings.
 *
 * @since 0.0.0
 */
export interface SearchOptions {
  readonly matcher: Matcher
  readonly lineTerminator: number
  readonly invert: boolean
  readonly maxCount: number | undefined
  readonly before: number
  readonly after: number
  readonly passthru: boolean
  readonly stopOnNonmatch: boolean
  /** Whether the sink needs every match in a line (colors, `-o`, `--json`, ...), not just the first. */
  readonly allMatches: boolean
  /** Whether matches may span lines (`-U`). */
  readonly multiline: boolean
  readonly binary: BinaryMode
  /** Whether the sink reads line numbers (counting them costs a pass over the lines). */
  readonly lineNumbers: boolean
}

/**
 * A run of whole lines `[start, end)` (`end` includes the terminator).
 *
 * @since 0.0.0
 */
export interface Lines {
  readonly start: number
  readonly end: number
  /** The 1-based number of the first line. */
  readonly lineNumber: number
}

/**
 * Receives what the searcher finds.
 *
 * @since 0.0.0
 */
export interface Sink {
  /** Matching lines and the matches in them (empty for inverted matches). */
  readonly matched: (buffer: Uint8Array, lines: Lines, matches: ReadonlyArray<Match>) => void
  /** A context line. */
  readonly context: (buffer: Uint8Array, lines: Lines, kind: "before" | "after" | "other") => void
  /** A gap between non-adjacent context groups. */
  readonly contextBreak: () => void
}

/**
 * What a search found.
 *
 * @since 0.0.0
 */
export interface SearchResult {
  /** How many bytes were searched (less than the buffer when binary data stopped the search). */
  readonly bytesSearched: number
  readonly matchedLines: number
  readonly matches: number
  /** The offset of the first NUL byte, when the file was found to be binary. */
  readonly binaryOffset: number | undefined
  /** `quit` mode: whether the search stopped at binary data after printing matches. */
  readonly stoppedAtBinary: boolean
  /** `quit` mode: the file holds binary data, so (part of) it was not searched. */
  readonly binaryQuit: boolean
  /** `convert` mode: binary data was found before any output, so lines were withheld. */
  readonly binaryMatched: boolean
}

/** ripgrep's read buffer: binary detection happens a buffer at a time. */
const BUFFER = 64 * 1024

/** Counts line terminators incrementally, for monotonically increasing offsets. */
class LineCounter {
  private pos = 0
  private line = 1
  private readonly buffer: Uint8Array
  private readonly terminator: number
  constructor(buffer: Uint8Array, terminator: number) {
    this.buffer = buffer
    this.terminator = terminator
  }
  at(offset: number): number {
    const b = this.buffer
    const t = this.terminator
    if (offset < this.pos) {
      this.pos = 0
      this.line = 1
    }
    let i = b.indexOf(t, this.pos)
    while (i >= 0 && i < offset) {
      this.line++
      i = b.indexOf(t, i + 1)
    }
    this.pos = offset
    return this.line
  }
}

const lineEnd = (b: Uint8Array, t: number, pos: number, limit: number): number => {
  const i = b.indexOf(t, pos)
  return i < 0 || i >= limit ? limit : i + 1
}

const lineStart = (b: Uint8Array, t: number, pos: number): number => (pos === 0 ? 0 : b.lastIndexOf(t, pos - 1) + 1)

/** A run of lines to report as a hit, with the matches in it. */
interface Hit {
  readonly start: number
  readonly end: number
  readonly matches: ReadonlyArray<Match>
}

/** Where binary detection stops a search, and the offset of the first NUL byte. */
interface BinaryLimit {
  readonly limit: number
  readonly nul: number | undefined
}

/** Where binary detection stops a search, and where the first NUL byte is. */
const binaryLimit = (buffer: Uint8Array, options: SearchOptions): BinaryLimit => {
  const nul = options.binary === "none" ? -1 : buffer.indexOf(0)
  if (nul < 0) return { limit: buffer.length, nul: undefined }
  const limit =
    options.binary === "quit"
      ? lineStart(buffer, options.lineTerminator, Math.floor(nul / BUFFER) * BUFFER)
      : buffer.length
  return { limit, nul }
}

/** One search of one buffer. */
class Search {
  private readonly buffer: Uint8Array
  private readonly options: SearchOptions
  private readonly sink: Sink
  private readonly t: number
  private readonly limit: number
  /** The end of the last line: a match at the very end of a buffer that ends with a terminator lies on no line. */
  private readonly lastLineEnd: number
  private readonly state: Input.State<Uint8Array>
  private readonly counter: LineCounter
  private readonly contextual: boolean

  // The match iteration.
  private pending: Match | undefined = undefined
  private searchFrom = 0
  private exhausted = false
  // Inverted search reports the lines between groups instead.
  private invertCursor = 0
  private invertGroup: Hit | undefined | null = null
  // What has been reported.
  private printedAny = false
  private lastEmittedEnd = -1

  constructor(buffer: Uint8Array, options: SearchOptions, sink: Sink, limit: number) {
    this.buffer = buffer
    this.options = options
    this.sink = sink
    this.t = options.lineTerminator
    this.limit = limit
    this.lastLineEnd = limit > 0 && buffer[limit - 1] === this.t ? limit - 1 : limit
    this.state = new Input.State(buffer)
    this.counter = new LineCounter(buffer, this.t)
    this.contextual = options.before > 0 || options.after > 0
  }

  private lines(start: number, end: number): Lines {
    return { start, end, lineNumber: this.options.lineNumbers ? this.counter.at(start) : 0 }
  }

  private lineEnd(pos: number): number {
    return lineEnd(this.buffer, this.t, pos, this.limit)
  }

  /** The next match starting at or after `from` on a line within the limit. */
  find(from: number): Match | undefined {
    if (from > this.lastLineEnd) return undefined
    const m = this.options.matcher.find(this.state, from)
    if (m === undefined) return undefined
    // A match must start on a line: before the limit, or at the end of a
    // last line that has no terminator.
    const { lastLineEnd, limit } = this
    return m.start < limit || (m.start === limit && limit > 0 && lastLineEnd === limit) ? m : undefined
  }

  /**
   * The match after `m`, with the regex crate's iteration rules: the search
   * resumes where `m` ended, an empty match right after a non-empty one is
   * skipped, and after an empty match the search moves on one byte.
   */
  findAfter(m: Match): Match | undefined {
    if (m.end === m.start) return this.find(m.end + 1)
    const n = this.find(m.end)
    return n !== undefined && n.start === m.end && n.end === n.start ? this.find(m.end + 1) : n
  }

  /** The next group of lines touched by matches, with the matches. */
  nextGroup(): Hit | undefined {
    const first = this.pending ?? (this.exhausted ? undefined : this.find(this.searchFrom))
    this.pending = undefined
    if (first === undefined) {
      this.exhausted = true
      return undefined
    }
    const matches = [first]
    const end = this.extendGroup(first, matches)
    this.searchFrom = end
    // A group that reaches the last line leaves nothing to search after it.
    if (end >= this.limit && this.pending === undefined) this.exhausted = true
    return { start: lineStart(this.buffer, this.t, first.start), end, matches }
  }

  /**
   * Collects the further matches in the group that `first` starts (only
   * when the sink needs them, or in multiline mode, where a later match may
   * extend the group), and returns where the group ends.
   */
  private extendGroup(first: Match, matches: Array<Match>): number {
    let end = this.lineEnd(Math.max(first.start, first.end - 1))
    if (!this.options.allMatches && !this.options.multiline) return end
    for (let m = this.findAfter(first); ; m = this.findAfter(m)) {
      if (m === undefined) {
        this.exhausted = true
        return end
      }
      // A further match must start inside the group's lines; one at the very
      // end of an unterminated last line belongs to that line.
      if (m.start >= end) {
        if (m.start >= this.limit) this.exhausted = true
        else this.pending = m
        return end
      }
      if (this.options.allMatches) matches.push(m)
      if (m.end > end) end = this.lineEnd(m.end - 1)
    }
  }

  /** The next line that does not match (`-v`). */
  nextInverted(): Hit | undefined {
    while (this.invertCursor < this.limit) {
      if (this.invertGroup === null) this.invertGroup = this.nextGroup()
      if (this.invertGroup === undefined || this.invertCursor < this.invertGroup.start) {
        const end = this.lineEnd(this.invertCursor)
        const hit = { start: this.invertCursor, end, matches: [] }
        this.invertCursor = end
        return hit
      }
      this.invertCursor = this.invertGroup.end
      this.invertGroup = null
    }
    return undefined
  }

  /** A `--` between groups that are not adjacent. */
  private separate(start: number): void {
    if (this.contextual && this.printedAny && this.lastEmittedEnd >= 0 && start > this.lastEmittedEnd) {
      this.sink.contextBreak()
    }
  }

  private emitContext(start: number, end: number, kind: "before" | "after" | "other"): void {
    for (let s = start; s < end;) {
      const e = this.lineEnd(s)
      this.separate(s)
      this.sink.context(this.buffer, this.lines(s, e), kind)
      this.lastEmittedEnd = e
      this.printedAny = true
      s = e
    }
  }

  emitHit(hit: Hit, withheld: boolean): void {
    this.separate(hit.start)
    if (!withheld) this.sink.matched(this.buffer, this.lines(hit.start, hit.end), hit.matches)
    this.printedAny = true
    this.lastEmittedEnd = hit.end
  }

  /** The lines `[from, to)` between hits: after-context, then before-context. */
  gap(from: number, to: number, hadHit: boolean): void {
    if (from >= to) return
    if (this.options.passthru) {
      this.emitContext(from, to, "other")
      return
    }
    let afterEnd = from
    if (hadHit) {
      for (let n = 0; n < this.options.after && afterEnd < to; n++) afterEnd = this.lineEnd(afterEnd)
      this.emitContext(from, afterEnd, "after")
    }
    let beforeStart = to
    for (let n = 0; n < this.options.before && beforeStart > afterEnd; n++) {
      beforeStart = lineStart(this.buffer, this.t, beforeStart - 1)
    }
    this.emitContext(beforeStart, to, "before")
  }

  /**
   * The after-context once `--max-count` is reached: ripgrep still shows
   * the lines that match there as matches, without counting them.
   */
  trailing(from: number): void {
    let s = from
    for (let n = 0; n < this.options.after && s < this.limit; n++) {
      const e = this.lineEnd(s)
      const matches: Array<Match> = []
      for (let m = this.find(s); m !== undefined && m.start < e; m = this.findAfter(m)) matches.push(m)
      if (Arr.isReadonlyArrayNonEmpty(matches) !== this.options.invert) {
        this.sink.matched(this.buffer, this.lines(s, e), this.options.invert ? [] : matches)
      } else {
        this.sink.context(this.buffer, this.lines(s, e), "after")
      }
      s = e
    }
  }

  /** The context after the last hit. */
  finish(cursor: number, hits: number): void {
    const { after, maxCount, passthru } = this.options
    if (passthru) this.gap(cursor, this.limit, hits > 0)
    else if (hits > 0 && after > 0 && hits === maxCount) this.trailing(cursor)
    else if (hits > 0 && after > 0)
      this.gap(cursor, afterContextEnd(this.buffer, this.t, cursor, this.limit, after), true)
  }
}

/**
 * Searches `buffer`, reporting to `sink`.
 *
 * @example
 * ```ts
 * import * as Searcher from "./searcher.ts"
 * ```
 *
 * @since 0.0.0
 */
export const search = (input: Uint8Array, options: SearchOptions, sink: Sink): SearchResult => {
  // As a Buffer (a view, no copy): its indexOf, which finds every line end
  // and NUL byte, is a native memchr; a plain Uint8Array's is not.
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const { limit, nul } = binaryLimit(buffer, options)
  const withheld = options.binary === "convert" && nul !== undefined && nul < BUFFER
  const run = new Search(buffer, options, sink, limit)
  const next = options.invert ? () => run.nextInverted() : () => run.nextGroup()
  let matchedLines = 0
  let matches = 0
  let cursor = 0
  let hits = 0
  const more = () => (hits === options.maxCount ? undefined : next())
  for (let hit = more(); hit !== undefined; hit = more()) {
    if (options.stopOnNonmatch && hits > 0 && hit.start !== cursor) break
    run.gap(cursor, hit.start, hits > 0)
    run.emitHit(hit, withheld)
    hits++
    // In multiline mode ripgrep counts each match group as one matching line.
    matchedLines += options.multiline ? 1 : countLines(buffer, options.lineTerminator, hit.start, hit.end)
    matches += options.invert ? 0 : hit.matches.length
    cursor = hit.end
  }
  run.finish(cursor, hits)
  const quit = options.binary === "quit" && nul !== undefined
  return {
    bytesSearched: limit,
    matchedLines,
    matches,
    binaryOffset: nul,
    stoppedAtBinary: quit && hits > 0,
    binaryQuit: quit,
    binaryMatched: withheld && hits > 0
  }
}

const afterContextEnd = (b: Uint8Array, t: number, from: number, limit: number, n: number): number => {
  let end = from
  for (let i = 0; i < n && end < limit; i++) end = lineEnd(b, t, end, limit)
  return end
}

const countLines = (b: Uint8Array, t: number, start: number, end: number): number => {
  let n = 0
  for (let i = b.indexOf(t, start); i >= 0 && i < end; i = b.indexOf(t, i + 1)) n++
  return end > start && b[end - 1] !== t ? n + 1 : Math.max(n, 1)
}
