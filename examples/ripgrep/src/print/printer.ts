/**
 * What every printer shares: the per-file interface the main loop drives,
 * and the totals reported by `--stats` and the JSON summary.
 *
 * @since 0.0.0
 */
import * as Predicate from "effect/Predicate"
import type { SearchResult, Sink } from "../search/searcher.ts"

/**
 * The file being printed.
 *
 * @since 0.0.0
 */
export interface FileInfo {
  /** The path as printed (after `--path-separator`). */
  readonly path: string
  /** The absolute path, for hyperlinks. */
  readonly absolute: string
}

/**
 * Totals over a whole run.
 *
 * @since 0.0.0
 */
export interface Totals {
  matches: number
  matchedLines: number
  filesWithMatches: number
  filesSearched: number
  bytesPrinted: number
  bytesSearched: number
  searchNanos: number
  startNanos: bigint
}

/**
 * A new set of totals, starting the clock now.
 *
 * @since 0.0.0
 */
export const totals = (): Totals => ({
  matches: 0,
  matchedLines: 0,
  filesWithMatches: 0,
  filesSearched: 0,
  bytesPrinted: 0,
  bytesSearched: 0,
  searchNanos: 0,
  startNanos: process.hrtime.bigint()
})

/**
 * The printer for one file.
 *
 * @since 0.0.0
 */
export interface FilePrinter {
  readonly sink: Sink
  /** Called once the file has been searched. Returns whether the file counts as a match for the exit status. */
  readonly end: (result: SearchResult, bytesSearched: number, nanos: number) => boolean
}

/**
 * A printer: one of the output modes.
 *
 * @since 0.0.0
 */
export interface Printer {
  /** Whether the sink needs every match in a line, not just whether the line matched. */
  readonly allMatches: boolean
  readonly file: (info: FileInfo) => FilePrinter
  /** Called after the last file. */
  readonly finish: (totals: Totals) => void
}

/**
 * The `--stats` block ripgrep prints after the results.
 *
 * @since 0.0.0
 */
export const statsText = (t: Totals): string => {
  const total = Number(process.hrtime.bigint() - t.startNanos) / 1e9
  return [
    "",
    `${t.matches} matches`,
    `${t.matchedLines} matched lines`,
    `${t.filesWithMatches} files contained matches`,
    `${t.filesSearched} files searched`,
    `${t.bytesPrinted} bytes printed`,
    `${t.bytesSearched} bytes searched`,
    `${(t.searchNanos / 1e9).toFixed(6)} seconds spent searching`,
    `${total.toFixed(6)} seconds`,
    ""
  ].join("\n")
}

/**
 * A `--replace` template: `$1`, `${1}`, `$name`, `${name}` and `$$`.
 *
 * @since 0.0.0
 */
export type Template = ReadonlyArray<string | number>

/**
 * Parses a `--replace` template against the group names of the pattern.
 * Unknown groups expand to nothing, as in ripgrep.
 *
 * @since 0.0.0
 */
export const parseTemplate = (template: string, names: ReadonlyArray<string | undefined>): Template => {
  const parts: Array<string | number> = []
  const re = /\$(\$|\{([^}]*)\}|([_0-9A-Za-z]+))/g
  let last = 0
  for (const m of template.matchAll(re)) {
    parts.push(template.slice(last, m.index))
    last = m.index + m[0].length
    if (m[1] === "$") {
      parts.push("$")
      continue
    }
    const ref = m[2] ?? m[3] ?? ""
    const index = /^\d+$/.test(ref) ? Number(ref) : names.indexOf(ref)
    if (index >= 0 && index < names.length) parts.push(index)
  }
  parts.push(template.slice(last))
  return parts.filter((p) => p !== "")
}

const encoder = new TextEncoder()

/**
 * Expands a template for one match.
 *
 * @since 0.0.0
 */
export const expand = (
  template: Template,
  buffer: Uint8Array,
  groups: ReadonlyArray<number> | undefined,
  start: number,
  end: number
): Uint8Array => {
  const chunks: Array<Uint8Array> = []
  for (const part of template) {
    if (Predicate.isString(part)) {
      chunks.push(encoder.encode(part))
      continue
    }
    const s = part === 0 ? start : (groups?.[2 * part] ?? -1)
    const e = part === 0 ? end : (groups?.[2 * part + 1] ?? -1)
    if (s >= 0 && e >= s) chunks.push(buffer.subarray(s, e))
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}
