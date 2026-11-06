/**
 * Buffered output to a file descriptor, counting the bytes written (for
 * `--stats` and the JSON summary).
 *
 * @since 0.0.0
 */
import { Buffer } from "node:buffer"
import * as Fs from "node:fs"
import * as Predicate from "effect/Predicate"

const encoder = new TextEncoder()

/**
 * A growable byte buffer flushed to a file descriptor, or kept in memory
 * when the descriptor is -1 (for a worker, which hands its output back).
 *
 * @since 0.0.0
 */
export class Output {
  private buffer = new Uint8Array(1 << 16)
  /** Bytes buffered, not yet written. */
  private used = 0
  /** Bytes written so far, flushed or not. */
  written = 0
  /** Set once the reader went away (`EPIPE`): further output is dropped. */
  closed = false

  private readonly fd: number
  private readonly lineBuffered: boolean

  constructor(fd: number, lineBuffered: boolean) {
    this.fd = fd
    this.lineBuffered = lineBuffered
  }

  /** Appends bytes. */
  bytes(b: Uint8Array): void {
    if (this.closed) return
    this.written += b.length
    if (this.used + b.length > this.buffer.length) {
      this.flush()
      if (b.length > this.buffer.length) {
        this.writeAll(b)
        return
      }
    }
    this.buffer.set(b, this.used)
    this.used += b.length
  }

  /** Appends one byte. */
  byte(b: number): void {
    if (this.closed) return
    if (this.used >= this.buffer.length) this.flush()
    this.buffer[this.used++] = b
    this.written++
  }

  /** Appends a non-negative integer in decimal, without making a string. */
  decimal(n: number): void {
    if (n >= 10) this.decimal(Math.floor(n / 10))
    this.byte(48 + (n % 10))
  }

  /** Appends `src[start, end)`, copying straight from a Buffer (no view per call). */
  range(src: Uint8Array, start: number, end: number): void {
    const n = end - start
    if (this.closed || n <= 0) return
    if (!Buffer.isBuffer(src) || this.used + n > this.buffer.length) {
      this.bytes(src.subarray(start, end))
      return
    }
    src.copy(this.buffer, this.used, start, end)
    this.used += n
    this.written += n
  }

  /** Appends a string as UTF-8, writing ASCII directly into the buffer. */
  text(s: string): void {
    if (this.closed) return
    const n = s.length
    if (this.used + 3 * n > this.buffer.length) {
      this.bytes(encoder.encode(s))
      return
    }
    const b = this.buffer
    let at = this.used
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i)
      if (c >= 0x80) {
        at += encoder.encodeInto(s.slice(i), b.subarray(at)).written
        break
      }
      b[at++] = c
    }
    this.written += at - this.used
    this.used = at
  }

  /** Ends a line of output: flushes when line buffered. */
  endLine(): void {
    if (this.lineBuffered) this.flush()
  }

  /** Writes everything buffered. */
  flush(): void {
    if (this.used === 0) return
    const pending = this.buffer.subarray(0, this.used)
    this.used = 0
    this.writeAll(pending)
  }

  /** In memory (`fd` -1): what has been flushed, not yet taken. */
  private readonly chunks: Array<Uint8Array> = []

  /** In memory: everything written since the last call. */
  take(): Uint8Array<ArrayBuffer> {
    this.flush()
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const c of this.chunks) {
      out.set(c, at)
      at += c.length
    }
    this.chunks.length = 0
    return out
  }

  private writeAll(b: Uint8Array): void {
    if (this.fd < 0) {
      this.chunks.push(b.slice())
      return
    }
    let offset = 0
    while (offset < b.length && !this.closed) {
      try {
        offset += Fs.writeSync(this.fd, b, offset, b.length - offset)
      } catch (error) {
        const code = Predicate.hasProperty(error, "code") ? error.code : undefined
        if (code === "EAGAIN") continue
        if (code === "EPIPE") {
          this.closed = true
          return
        }
        throw error
      }
    }
  }
}
