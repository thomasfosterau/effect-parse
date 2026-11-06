/**
 * The `--json` printer: ripgrep's JSON Lines messages (`begin`, `match`,
 * `context`, `end` and the final `summary`), field for field.
 *
 * @since 0.0.0
 */
import type { Match } from "../regex/compile.ts"
import type { Lines, SearchResult, Sink } from "../search/searcher.ts"
import type { Output } from "./output.ts"
import type { FileEnd, FileInfo, Printer, Totals } from "./printer.ts"

const strict = new TextDecoder("utf-8", { fatal: true })

/** `{"text": ...}` for UTF-8, `{"bytes": base64}` otherwise, as ripgrep writes data. */
const data = (b: Uint8Array): string => {
  try {
    return `{"text":${JSON.stringify(strict.decode(b))}}`
  } catch {
    let binary = ""
    for (const byte of b) binary += String.fromCharCode(byte)
    return `{"bytes":${JSON.stringify(btoa(binary))}}`
  }
}

const encoder = new TextEncoder()

const duration = (nanos: number, sortedKeys: boolean): string => {
  const secs = Math.floor(nanos / 1e9)
  const rest = Math.round(nanos - secs * 1e9)
  const human = `${(nanos / 1e9).toFixed(6)}s`
  return sortedKeys
    ? `{"human":"${human}","nanos":${rest},"secs":${secs}}`
    : `{"secs":${secs},"nanos":${rest},"human":"${human}"}`
}

/**
 * The JSON printer's settings.
 *
 * @since 0.0.0
 */
export interface JsonOptions {
  readonly lineNumber: boolean
  readonly quiet: boolean
}

/**
 * Builds the JSON printer.
 *
 * @since 0.0.0
 */
export const jsonPrinter = (o: JsonOptions, out: Output): Printer => {
  const file = (info: FileInfo) => {
    const path = data(encoder.encode(info.path))
    let begun = false
    let printed = 0
    const emit = (line: string) => {
      if (o.quiet) return
      const bytes = encoder.encode(`${line}\n`)
      printed += bytes.length
      out.bytes(bytes)
      out.endLine()
    }
    const begin = () => {
      if (begun) return
      begun = true
      emit(`{"type":"begin","data":{"path":${path}}}`)
    }
    const record = (type: string, buffer: Uint8Array, lines: Lines, matches: ReadonlyArray<Match>) => {
      begin()
      const submatches = matches
        .map(
          (m) =>
            `{"match":${data(buffer.subarray(m.start, m.end))},"start":${m.start - lines.start},"end":${m.end - lines.start}}`
        )
        .join(",")
      const lineNumber = o.lineNumber ? String(lines.lineNumber) : "null"
      emit(
        `{"type":"${type}","data":{"path":${path},"lines":${data(buffer.subarray(lines.start, lines.end))},"line_number":${lineNumber},"absolute_offset":${lines.start},"submatches":[${submatches}]}}`
      )
    }
    const sink: Sink = {
      matched: (buffer, lines, matches) => record("match", buffer, lines, matches),
      context: (buffer, lines) => record("context", buffer, lines, []),
      contextBreak: () => {}
    }
    return {
      sink,
      end: (result: SearchResult, bytesSearched: number, nanos: number): FileEnd => {
        const matched = result.matchedLines > 0
        // The summary counts what was printed before each `end` message.
        const shown = printed
        if (begun) {
          const stats = `{"elapsed":${duration(nanos, false)},"searches":1,"searches_with_match":${matched ? 1 : 0},"bytes_searched":${bytesSearched},"bytes_printed":${printed},"matched_lines":${result.matchedLines},"matches":${result.matches}}`
          emit(
            `{"type":"end","data":{"path":${path},"binary_offset":${result.binaryOffset ?? "null"},"stats":${stats}}}`
          )
        }
        return { matched, printed: shown, began: begun ? "separate" : "no" }
      }
    }
  }
  return {
    allMatches: true,
    lineNumbers: o.lineNumber,
    file,
    finish: (t: Totals) => {
      if (o.quiet) return
      const total = Number(process.hrtime.bigint() - t.startNanos)
      const stats = `{"bytes_printed":${t.printed},"bytes_searched":${t.bytesSearched},"elapsed":${duration(t.searchNanos, true)},"matched_lines":${t.matchedLines},"matches":${t.matches},"searches":${t.filesSearched},"searches_with_match":${t.filesWithMatches}}`
      out.text(`{"data":{"elapsed_total":${duration(total, true)},"stats":${stats}},"type":"summary"}\n`)
    }
  }
}
