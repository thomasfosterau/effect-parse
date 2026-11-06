/**
 * The standard printer: matching lines (or `-o` matches, or `--vimgrep`
 * records), with paths, line numbers, columns, byte offsets, context,
 * colours, replacements and ripgrep's long-line and binary notices.
 *
 * @since 0.0.0
 */
import * as Predicate from "effect/Predicate"
import type { Match } from "../regex/compile.ts"
import type { Lines, SearchResult, Sink } from "../search/searcher.ts"
import * as Color from "./color.ts"
import type { Output } from "./output.ts"
import type { FileEnd, FileInfo, FilePrinter, Printer, Template, Totals } from "./printer.ts"
import * as Printers from "./printer.ts"
import * as Arr from "effect/Array"

/**
 * The standard printer's settings.
 *
 * @since 0.0.0
 */
export interface StandardOptions {
  readonly withFilename: boolean
  readonly heading: boolean
  readonly lineNumber: boolean
  readonly column: boolean
  readonly byteOffset: boolean
  readonly onlyMatching: boolean
  readonly vimgrep: boolean
  readonly replace: Template | undefined
  readonly trim: boolean
  readonly maxColumns: number | undefined
  readonly maxColumnsPreview: boolean
  readonly nullPath: boolean
  readonly contextSeparator: string | undefined
  /** Whether context lines were requested (`-A`, `-B`, `-C`). */
  readonly context: boolean
  readonly fieldMatchSeparator: string
  readonly fieldContextSeparator: string
  readonly colors: ReadonlyMap<Color.ColorTarget, Color.Spec> | undefined
  readonly hyperlink: { readonly format: string; readonly host: string } | undefined
  readonly lineTerminator: number
  readonly invert: boolean
  readonly stats: boolean
  readonly quiet: boolean
  /**
   * Whether the printer writes the separators between files itself. Off
   * when files are printed apart (in parallel) and joined by the caller,
   * which writes {@link separator} between them.
   */
  readonly separateFiles: boolean
}

/**
 * What goes between the output of two files: a blank line under
 * `--heading`; with context, the context separator, unless the second
 * file's output is a binary notice.
 *
 * @since 0.0.0
 */
export const separator = (o: StandardOptions, separate: boolean): string => {
  if (o.heading) return "\n"
  return separate && o.context && o.contextSeparator !== undefined ? `${o.contextSeparator}\n` : ""
}

type LineKind = "matching" | "context"

/** Where a printed line is: its number and, for a match, the column. */
interface Position {
  readonly lineNumber: number
  readonly column: number | undefined
}

const isSpace = (b: number): boolean => b === 0x20 || (b >= 0x09 && b <= 0x0d)

/**
 * Builds the standard printer.
 *
 * @since 0.0.0
 */
export const standardPrinter = (o: StandardOptions, out: Output): Printer => {
  let filesPrinted = 0

  const colored = (target: Color.ColorTarget, text: string | Uint8Array) => {
    const spec = o.colors?.get(target)
    if (spec === undefined) {
      if (Predicate.isString(text)) out.text(text)
      else out.bytes(text)
      return
    }
    out.text(Color.start(spec))
    if (Predicate.isString(text)) out.text(text)
    else out.bytes(text)
    out.text(Color.reset)
  }

  const file = (info: FileInfo): FilePrinter => {
    let started = false
    // The path, encoded once per file: it may be printed on every line.
    const pathBytes = new TextEncoder().encode(info.path)
    const writePath = (line: number, column: number) => {
      if (o.hyperlink !== undefined && o.colors !== undefined && o.hyperlink.format !== "") {
        const url = Color.hyperlink(o.hyperlink.format, o.hyperlink.host, info.absolute, line, column)
        out.text(`\x1b]8;;${url}\x1b\\`)
        colored("path", pathBytes)
        out.text("\x1b]8;;\x1b\\")
      } else {
        colored("path", pathBytes)
      }
    }
    let began: FileEnd["began"] = "no"
    const begin = (separate: boolean) => {
      if (started) return
      started = true
      began = separate ? "separate" : "joined"
      if (o.separateFiles && filesPrinted > 0) out.text(separator(o, separate))
      if (o.heading && o.withFilename) {
        writePath(1, 1)
        out.text(o.nullPath ? "\0" : "\n")
      }
      filesPrinted++
    }

    const prefix = (sep: string, lineNumber: number, column: number | undefined, offset: number) => {
      if (o.withFilename && !o.heading) {
        writePath(lineNumber, column ?? 1)
        out.text(o.nullPath ? "\0" : sep)
      }
      if (o.lineNumber) {
        const spec = o.colors?.get("line")
        if (spec === undefined) out.decimal(lineNumber)
        else colored("line", String(lineNumber))
        out.text(sep)
      }
      if (o.column && column !== undefined) {
        colored("column", String(column))
        out.text(sep)
      }
      if (o.byteOffset) {
        out.text(String(offset))
        out.text(sep)
      }
    }

    /** Writes `[start, end)` of a line with each match replaced (`--replace`). */
    const replaced = (
      buffer: Uint8Array,
      start: number,
      end: number,
      matches: ReadonlyArray<Match>,
      template: Template
    ) => {
      let pos = start
      for (const m of matches) {
        if (m.end <= start || m.start >= end) continue
        const s = Math.max(m.start, start)
        if (s > pos) out.range(buffer, pos, s)
        if (m.start >= start) colored("match", Printers.expand(template, buffer, m.groups, m.start, m.end))
        pos = Math.min(m.end, end)
      }
      if (pos < end) out.range(buffer, pos, end)
    }

    /** Writes `[start, end)` of a line, colouring the parts inside `matches`. */
    const highlighted = (buffer: Uint8Array, start: number, end: number, matches: ReadonlyArray<Match>) => {
      let pos = start
      for (const m of matches) {
        const s = Math.max(m.start, start)
        const e = Math.min(m.end, end)
        if (e <= s) continue
        if (s > pos) out.range(buffer, pos, s)
        colored("match", buffer.subarray(s, e))
        pos = e
      }
      if (pos < end) out.range(buffer, pos, end)
    }

    const content = (buffer: Uint8Array, start: number, end: number, matches: ReadonlyArray<Match>) => {
      if (o.replace !== undefined) replaced(buffer, start, end, matches, o.replace)
      else if (o.colors === undefined) out.range(buffer, start, end)
      else highlighted(buffer, start, end, matches)
    }

    /** The printed part of a line: without its terminator, and with `--trim`, without leading whitespace. */
    const body = (buffer: Uint8Array, start: number, end: number): readonly [number, number] => {
      const bodyEnd = end > start && buffer[end - 1] === o.lineTerminator ? end - 1 : end
      let bodyStart = start
      while (o.trim && bodyStart < bodyEnd && isSpace(buffer[bodyStart])) bodyStart++
      return [bodyStart, bodyEnd]
    }

    /** `-M`: the first `maxColumns` characters and a notice, or the notice alone. */
    const truncated = (
      buffer: Uint8Array,
      start: number,
      end: number,
      matches: ReadonlyArray<Match>,
      kind: LineKind,
      maxColumns: number
    ) => {
      if (!o.maxColumnsPreview) {
        out.text(kind === "matching" ? "[Omitted long matching line]" : "[Omitted long context line]")
        return
      }
      let cut = start
      for (let chars = 0; cut < end && chars < maxColumns; chars++) {
        cut++
        while (cut < end && (buffer[cut] & 0xc0) === 0x80) cut++
      }
      content(buffer, start, cut, matches)
      out.text(" [... omitted end of long line]")
    }

    const line = (
      buffer: Uint8Array,
      start: number,
      end: number,
      at: Position,
      matches: ReadonlyArray<Match>,
      kind: LineKind
    ) => {
      const [bodyStart, bodyEnd] = body(buffer, start, end)
      prefix(kind === "matching" ? o.fieldMatchSeparator : o.fieldContextSeparator, at.lineNumber, at.column, start)
      if (o.maxColumns !== undefined && bodyEnd - bodyStart > o.maxColumns) {
        truncated(buffer, bodyStart, bodyEnd, matches, kind, o.maxColumns)
      } else {
        content(buffer, bodyStart, bodyEnd, matches)
      }
      out.byte(o.lineTerminator)
      out.endLine()
    }

    const lineStartOf = (buffer: Uint8Array, lines: Lines, offset: number): number => {
      if (offset <= lines.start) return lines.start
      return Math.max(lines.start, buffer.lastIndexOf(o.lineTerminator, offset - 1) + 1)
    }
    const lineNumberOf = (buffer: Uint8Array, lines: Lines, offset: number): number => {
      let n = lines.lineNumber
      for (
        let i = buffer.indexOf(o.lineTerminator, lines.start);
        i >= 0 && i < offset;
        i = buffer.indexOf(o.lineTerminator, i + 1)
      )
        n++
      return n
    }

    /** `-o` and `--vimgrep`: one record per match. */
    const eachMatch = (buffer: Uint8Array, lines: Lines, m: Match) => {
      const ls = lineStartOf(buffer, lines, m.start)
      const at = { lineNumber: lineNumberOf(buffer, lines, m.start), column: m.start - ls + 1 }
      if (o.vimgrep) {
        const le = buffer.indexOf(o.lineTerminator, m.start)
        line(buffer, ls, le < 0 ? buffer.length : le + 1, at, [m], "matching")
        return
      }
      prefix(o.fieldMatchSeparator, at.lineNumber, at.column, m.start)
      colored(
        "match",
        o.replace === undefined
          ? buffer.subarray(m.start, m.end)
          : Printers.expand(o.replace, buffer, m.groups, m.start, m.end)
      )
      out.byte(o.lineTerminator)
      out.endLine()
    }

    /** The column of a line's first match, 1-based; 1 for an inverted match. */
    const columnOf = (matches: ReadonlyArray<Match>, s: number, e: number): number | undefined => {
      if (Arr.isReadonlyArrayEmpty(matches)) return 1
      const first = matches.find((m) => m.end > s && m.start < e) ?? matches.find((m) => m.start === s)
      return first === undefined ? undefined : Math.max(first.start, s) - s + 1
    }

    const matchedLines = (buffer: Uint8Array, lines: Lines, matches: ReadonlyArray<Match>) => {
      let n = lines.lineNumber
      for (let s = lines.start; s < lines.end; n++) {
        const i = buffer.indexOf(o.lineTerminator, s)
        const e = i < 0 || i >= lines.end ? lines.end : i + 1
        const column = o.column ? columnOf(matches, s, e) : undefined
        line(buffer, s, e, { lineNumber: n, column }, matches, "matching")
        s = e
      }
    }

    const sink: Sink = {
      matched: (buffer, lines, matches) => {
        if (o.quiet) return
        begin(true)
        if (!o.onlyMatching && !o.vimgrep) {
          matchedLines(buffer, lines, matches)
          return
        }
        for (const m of matches) eachMatch(buffer, lines, m)
        if (Arr.isReadonlyArrayEmpty(matches))
          line(buffer, lines.start, lines.end, { lineNumber: lines.lineNumber, column: undefined }, [], "matching")
      },
      context: (buffer, lines, _kind) => {
        if (o.quiet) return
        begin(true)
        line(buffer, lines.start, lines.end, { lineNumber: lines.lineNumber, column: undefined }, [], "context")
      },
      contextBreak: () => {
        if (o.quiet || o.contextSeparator === undefined) return
        out.text(`${o.contextSeparator}\n`)
      }
    }

    return {
      sink,
      end: (result: SearchResult) => {
        const matched = result.matchedLines > 0
        if (o.quiet) return Printers.ended(matched)
        if (result.binaryMatched) {
          begin(false)
          if (o.withFilename && !o.heading) {
            writePath(1, 1)
            out.text(": ")
          }
          out.text(`binary file matches (found "\\0" byte around offset ${result.binaryOffset ?? 0})\n`)
        } else if (result.stoppedAtBinary) {
          if (o.withFilename && !o.heading) {
            writePath(1, 1)
            out.text(": ")
          }
          out.text(
            `WARNING: stopped searching binary file after match (found "\\0" byte around offset ${result.binaryOffset ?? 0})\n`
          )
        }
        return { matched, printed: 0, began }
      }
    }
  }

  return {
    // vimgrep and hyperlinks need them even when they are not printed.
    lineNumbers: o.lineNumber || o.vimgrep || o.hyperlink !== undefined,
    allMatches: o.onlyMatching || o.vimgrep || o.colors !== undefined || o.replace !== undefined || o.column || o.stats,
    file,
    finish: (t: Totals) => {
      if (o.stats) {
        t.bytesPrinted = out.written
        out.text(Printers.statsText(t))
      }
    }
  }
}
