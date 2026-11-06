/**
 * The summary printers: `-c`, `--count-matches`, `-l` and
 * `--files-without-match`.
 *
 * @since 0.0.0
 */
import type { OutputMode } from "../cli/args.ts"
import type { SearchResult } from "../search/searcher.ts"
import * as Color from "./color.ts"
import type { Output } from "./output.ts"
import type { FileInfo, Printer, Totals } from "./printer.ts"
import * as Printers from "./printer.ts"

/**
 * The summary printers' settings.
 *
 * @since 0.0.0
 */
export interface SummaryOptions {
  readonly mode: Exclude<OutputMode, "standard" | "json">
  readonly withFilename: boolean
  readonly includeZero: boolean
  readonly nullPath: boolean
  readonly fieldMatchSeparator: string
  readonly colors: ReadonlyMap<Color.ColorTarget, Color.Spec> | undefined
  readonly invert: boolean
  readonly quiet: boolean
  readonly stats: boolean
  readonly lineTerminator: string
}

const noop = () => {}

/**
 * Builds a summary printer.
 *
 * @since 0.0.0
 */
export const summaryPrinter = (o: SummaryOptions, out: Output): Printer => {
  const path = (info: FileInfo) => {
    const spec = o.colors?.get("path")
    if (spec === undefined) out.text(info.path)
    else out.text(Color.start(spec) + info.path + Color.reset)
  }
  const pathLine = (info: FileInfo) => {
    path(info)
    out.text(o.nullPath ? "\0" : o.lineTerminator)
    out.endLine()
  }
  /** `-c` / `--count-matches`: `path:count`. */
  const count = (info: FileInfo, result: SearchResult) => {
    // ripgrep prints no count for an implicit file it stopped searching at binary data.
    if (result.stoppedAtBinary) return
    const n = o.mode === "count" || o.invert ? result.matchedLines : result.matches
    if (n === 0 && !o.includeZero) return
    if (o.withFilename) {
      path(info)
      out.text(o.nullPath ? "\0" : o.fieldMatchSeparator)
    }
    out.text(`${n}${o.lineTerminator}`)
    out.endLine()
  }
  const end = (info: FileInfo, result: SearchResult): boolean => {
    const matched = result.matchedLines > 0 || result.binaryMatched
    if (o.mode === "filesWithoutMatch") {
      const printed = !matched && !result.binaryQuit
      if (printed && !o.quiet) pathLine(info)
      return printed
    }
    if (o.quiet) return matched
    if (o.mode === "filesWithMatches") {
      if (matched) pathLine(info)
    } else {
      count(info, result)
    }
    return matched
  }
  return {
    allMatches: o.mode === "countMatches" || o.stats,
    file: (info) => ({
      sink: { matched: noop, context: noop, contextBreak: noop },
      end: (result: SearchResult) => end(info, result)
    }),
    finish: (t: Totals) => {
      if (o.stats) {
        t.bytesPrinted = out.written
        out.text(Printers.statsText(t))
      }
    }
  }
}
