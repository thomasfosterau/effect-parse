/**
 * The WebAssembly SIMD search kernel (`kernels/teddy.c`), loaded on first
 * use: candidate starts for a few short literals (Teddy, as in ripgrep) or
 * for a sequence of byte sets, sixteen input bytes at a time. A haystack is
 * copied into the kernel's memory once, the first time it is searched.
 *
 * @since 0.0.0
 */
import { Buffer } from "node:buffer"
import { kernelWasm } from "./kernelWasm.ts"

const PAGE = 65_536

/** Finders' tables live below this offset, the haystack above it. */
const BASE = PAGE

/** Each finder's tables: three positions of two 16-byte nibble tables. */
const TABLES = 96

/** The most positions the kernel checks at once. */
export const MAX_POSITIONS = 3

/** The most buckets: one bit each in a table byte. */
export const MAX_BUCKETS = 8

type KernelFind = (input: number, from: number, end: number, tables: number, m: number, buckets: number) => number

/**
 * The loaded kernel: its memory, the haystack it holds, and the tables handed out.
 *
 * @since 0.0.0
 */
export class Kernel {
  private readonly memory: WebAssembly.Memory
  private readonly run: KernelFind
  private bytes: Uint8Array
  private tablesUsed = 0
  private placed: Uint8Array | undefined = undefined

  constructor() {
    this.memory = new WebAssembly.Memory({ initial: 32 })
    const module = new WebAssembly.Module(Buffer.from(kernelWasm, "base64"))
    const instance = new WebAssembly.Instance(module, { env: { memory: this.memory } })
    // SAFETY: kernels/teddy.c exports `find` with this signature.
    this.run = instance.exports["find"] as KernelFind
    this.bytes = new Uint8Array(this.memory.buffer)
  }

  /** Room for one finder's tables, written from `tables`; -1 once the space is used up. */
  tables(tables: Uint8Array): number {
    if (this.tablesUsed + TABLES > BASE) return -1
    const at = this.tablesUsed
    this.tablesUsed += TABLES
    this.bytes.set(tables, at)
    return at
  }

  /** Copies `haystack` into memory, unless it is there already; false if it does not fit. */
  place(haystack: Uint8Array): boolean {
    if (this.placed === haystack) return true
    const need = BASE + haystack.length + 16
    if (need > this.memory.buffer.byteLength) {
      try {
        this.memory.grow(Math.ceil((need - this.memory.buffer.byteLength) / PAGE))
      } catch {
        return false
      }
      this.bytes = new Uint8Array(this.memory.buffer)
    }
    this.bytes.set(haystack, BASE)
    this.placed = haystack
    return true
  }

  /** The first candidate start in `[from, end)` of the placed haystack, or -1. */
  find(from: number, end: number, tables: number, m: number, buckets: boolean): number {
    const at = this.run(BASE, from, end, tables, m, buckets ? 1 : 0)
    return at
  }
}

let state: Kernel | "unloaded" | "unavailable" = "unloaded"

/**
 * The kernel, loaded on first use, or `undefined` where WebAssembly SIMD
 * is not available.
 *
 * @since 0.0.0
 */
export const kernel = (): Kernel | undefined => {
  if (state === "unloaded") {
    try {
      state = new Kernel()
    } catch {
      state = "unavailable"
    }
  }
  return state === "unavailable" ? undefined : state
}

/**
 * Nibble tables for up to {@link MAX_POSITIONS} positions: `buckets[j]`
 * lists, for position j, each bucket's bytes.
 *
 * @since 0.0.0
 */
export const nibbleTables = (positions: ReadonlyArray<ReadonlyArray<ArrayLike<number>>>): Uint8Array => {
  const t = new Uint8Array(TABLES)
  positions.forEach((buckets, j) => {
    buckets.forEach((bytes, k) => {
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i] ?? 0
        t[32 * j + (b & 15)] |= 1 << k
        t[32 * j + 16 + (b >> 4)] |= 1 << k
      }
    })
  })
  return t
}
