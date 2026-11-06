/**
 * Reading what to search: files, stdin, `--pre` preprocessors, compressed
 * files (`-z`) and text encodings (`-E`), producing the UTF-8 bytes the
 * matcher runs over.
 *
 * @since 0.0.0
 */
import { Buffer } from "node:buffer"
import * as Fs from "node:fs"
import * as Result from "effect/Result"

// Loaded on first use: these built-ins take milliseconds to load, and most
// runs never need them.
const zlib = () => process.getBuiltinModule("node:zlib")
const childProcess = () => process.getBuiltinModule("node:child_process")

/**
 * The decompressors ripgrep runs for `-z`, by file extension.
 *
 * @since 0.0.0
 */
const decompressors: ReadonlyArray<readonly [RegExp, string, ReadonlyArray<string>]> = [
  [/\.(gz|tgz)$/i, "gzip", ["-d", "-c"]],
  [/\.(bz2|tbz2)$/i, "bzip2", ["-d", "-c"]],
  [/\.(xz|txz)$/i, "xz", ["-d", "-c"]],
  [/\.lz4$/i, "lz4", ["-d", "-c"]],
  [/\.lzma$/i, "xz", ["--format=lzma", "-d", "-c"]],
  [/\.br$/i, "brotli", ["-d", "-c"]],
  [/\.(zst|zstd)$/i, "zstd", ["-q", "-d", "-c"]],
  [/\.Z$/, "uncompress", ["-c"]]
]

/**
 * Decompresses `bytes` if `path` has a compressed file's extension; gzip
 * and brotli in-process, the rest with the command ripgrep uses.
 *
 * @since 0.0.0
 */
export const decompress = (path: string, bytes: Uint8Array): Result.Result<Uint8Array, string> => {
  if (/\.(gz|tgz)$/i.test(path)) return Result.succeed(new Uint8Array(zlib().gunzipSync(bytes)))
  if (/\.br$/i.test(path)) return Result.succeed(new Uint8Array(zlib().brotliDecompressSync(bytes)))
  const found = decompressors.find(([re]) => re.test(path))
  if (found === undefined) return Result.succeed(bytes)
  return run(found[1], found[2], bytes)
}

const run = (
  command: string,
  args: ReadonlyArray<string>,
  input: Uint8Array,
  cwd?: string
): Result.Result<Uint8Array, string> => {
  const result = childProcess().spawnSync(command, args, { input, maxBuffer: 1 << 30, cwd })
  if (result.error !== undefined) return Result.fail(`${command}: ${result.error.message}`)
  if (result.status !== 0) {
    return Result.fail(`preprocessor command failed: '${command}': ${new TextDecoder().decode(result.stderr).trim()}`)
  }
  return Result.succeed(new Uint8Array(result.stdout))
}

/**
 * Runs a `--pre` command on a file: the path is its argument and the file
 * its standard input, as in ripgrep.
 *
 * @since 0.0.0
 */
export const preprocess = (command: string, path: string, cwd: string): Result.Result<Uint8Array, string> =>
  run(command, [path], Fs.readFileSync(path), cwd)

// A Buffer, whose `indexOf` is a native memchr: the searcher scans with it.
let scratch = Buffer.allocUnsafe(1 << 20)

/**
 * Reads a file into a buffer reused from call to call (no allocation, page
 * faults or garbage per file, which a fresh buffer each time costs). The
 * view returned is overwritten by the next call.
 *
 * @since 0.0.0
 */
export const readFile = (path: string): Uint8Array => {
  const fd = Fs.openSync(path, "r")
  try {
    const size = Fs.fstatSync(fd).size
    if (size + 1 > scratch.length) scratch = Buffer.allocUnsafe(Math.max(size + 1, 2 * scratch.length))
    let n = 0
    for (
      let r = Fs.readSync(fd, scratch, 0, scratch.length, null);
      r > 0;
      r = Fs.readSync(fd, scratch, n, scratch.length - n, null)
    ) {
      n += r
      // The file grew while it was read: make room and carry on.
      if (n === scratch.length) {
        const bigger = Buffer.allocUnsafe(2 * scratch.length)
        bigger.set(scratch)
        scratch = bigger
      }
    }
    return scratch.subarray(0, n)
  } finally {
    Fs.closeSync(fd)
  }
}

/**
 * Reads standard input to the end.
 *
 * @since 0.0.0
 */
export const readStdin = (): Uint8Array => new Uint8Array(Fs.readFileSync(0))

/**
 * Whether standard input is something to search (a file or a pipe, not a
 * terminal), which is when ripgrep searches it given no paths.
 *
 * @since 0.0.0
 */
export const stdinIsReadable = (): boolean => {
  try {
    const s = Fs.fstatSync(0)
    return s.isFile() || s.isFIFO() || s.isSocket()
  } catch {
    return false
  }
}

const encoder = new TextEncoder()

/**
 * Checks an `-E` label, returning an error message for an unknown one.
 *
 * @since 0.0.0
 */
export const checkEncoding = (label: string | undefined): string | undefined => {
  if (label === undefined || label === "auto" || label === "none") return undefined
  try {
    new TextDecoder(label)
    return undefined
  } catch {
    return `unknown encoding: ${label}`
  }
}

/**
 * Transcodes a file to UTF-8 as ripgrep does: with no `-E` (or `auto`), a
 * UTF-8 byte order mark is removed and a UTF-16 one selects UTF-16; `none`
 * searches the raw bytes; any other label transcodes from that encoding.
 *
 * @since 0.0.0
 */
export const decode = (bytes: Uint8Array, label: string | undefined): Uint8Array => {
  if (label === "none") return bytes
  const auto = label === undefined || label === "auto"
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && (auto || /^utf-?8$/i.test(label ?? ""))) {
    return bytes.subarray(3)
  }
  if (auto) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return encoder.encode(new TextDecoder("utf-16le").decode(bytes.subarray(2)))
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return encoder.encode(new TextDecoder("utf-16be").decode(bytes.subarray(2)))
    return bytes
  }
  if (/^utf-?8$/i.test(label ?? "")) return bytes
  return encoder.encode(new TextDecoder(label).decode(bytes))
}
