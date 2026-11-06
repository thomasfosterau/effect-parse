/**
 * Searching in parallel: worker threads search files into memory, and the
 * main thread writes their output in walk order, with the separators a
 * single printer would have written between files.
 *
 * @since 0.0.0
 */
import { Worker } from "node:worker_threads"
import * as Arr from "effect/Array"
import type { FileOutcome, FileSearch } from "./main.ts"
import type * as Printers from "./print/printer.ts"
import type * as Walk from "./walk/walk.ts"

/**
 * What a worker needs to rebuild the main thread's search.
 *
 * @since 0.0.0
 */
export interface WorkerData {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  readonly stdoutIsTty: boolean
  /** The patterns, as the main thread read them (`-f -` reads standard input only once). */
  readonly sources: ReadonlyArray<string>
  readonly roots: ReadonlyArray<string>
}

/**
 * One file to search.
 *
 * @since 0.0.0
 */
export interface Job {
  readonly index: number
  readonly entry: Walk.Entry
}

/**
 * A worker's answer: the file's output, its outcome and its messages.
 *
 * @since 0.0.0
 */
export interface Reply {
  readonly index: number
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly outcome: FileOutcome | undefined
  readonly stderr: string
  readonly hadError: boolean
}

/**
 * How to run the workers.
 *
 * @since 0.0.0
 */
export interface ParallelOptions {
  readonly workers: number
  readonly url: URL
  readonly data: WorkerData
  readonly stderr: (message: string) => void
  readonly count: (totals: Printers.Totals, outcome: FileOutcome) => void
  readonly status: (matchedAny: boolean) => number
}

/** Files sent to a worker at once: fewer, larger messages. */
const BATCH = 8

/** How long the main thread searches between looking at its messages, in milliseconds. */
const SLICE_MS = 4

/**
 * A worker's message: ready for work (after it has built its search), or
 * the replies to a batch.
 *
 * @since 0.0.0
 */
export type FromWorker =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Replies"; readonly replies: ReadonlyArray<Reply> }

/** Writes replies in walk order. */
class Assembler {
  readonly totals: Printers.Totals
  matchedAny = false
  private next = 0
  private filesPrinted = 0
  private readonly pending = new Map<number, Reply>()
  private readonly search: FileSearch
  private readonly options: ParallelOptions

  constructor(search: FileSearch, options: ParallelOptions, totals: Printers.Totals) {
    this.search = search
    this.options = options
    this.totals = totals
  }

  /** Takes a reply; returns how many files have been written so far. */
  add(reply: Reply): number {
    this.pending.set(reply.index, reply)
    for (let r = this.pending.get(this.next); r !== undefined; r = this.pending.get(this.next)) {
      this.pending.delete(this.next)
      this.write(r)
      this.next++
    }
    return this.next
  }

  /** Whether no more files need searching: `-q` found a match, or the reader went away. */
  done(): boolean {
    const { args, plan } = this.search
    return (args.quiet && this.matchedAny && !args.stats) || plan.out.closed
  }

  private write(reply: Reply): void {
    if (reply.stderr !== "") this.options.stderr(reply.stderr)
    if (reply.hadError) this.search.reporter.hadError = true
    const outcome = reply.outcome
    if (outcome === undefined || this.done()) return
    this.options.count(this.totals, outcome)
    if (outcome.end.matched) this.matchedAny = true
    const out = this.search.plan.out
    if (reply.bytes.byteLength > 0) {
      const begins = outcome.end.began !== "no"
      if (begins && this.filesPrinted > 0) out.text(this.search.plan.separator(outcome.end.began === "separate"))
      out.bytes(reply.bytes)
      if (begins) this.filesPrinted++
    }
  }
}

/**
 * Searches one file the way a worker does: into the memory output of a
 * search built without file separators.
 *
 * @since 0.0.0
 */
export const searchInto = (search: FileSearch, job: Job, stderr: () => string): Reply => {
  const outcome = search.file(job.entry)
  const bytes = search.plan.out.take()
  const hadError = search.reporter.hadError
  search.reporter.hadError = false
  return { index: job.index, bytes, outcome, stderr: stderr(), hadError }
}

/**
 * Searches `entries` on this thread and `options.workers` worker threads;
 * resolves to the exit status once everything is written. `search` prints
 * to standard output; `local` is this thread's search, printing into
 * memory like a worker's; `local` and the workers take files from the
 * front of the list, so this thread never waits for the workers to start.
 *
 * @since 0.0.0
 */
export const run = (
  search: FileSearch,
  local: FileSearch,
  entries: ReadonlyArray<Walk.Entry>,
  options: ParallelOptions,
  totals: Printers.Totals
): Promise<number> =>
  new Promise((resolve, reject) => {
    const assembler = new Assembler(search, options, totals)
    const workers = Array.from({ length: options.workers }, () => new Worker(options.url, { workerData: options.data }))
    let taken = 0
    let written = 0
    let finished = false
    const exhausted = () => taken >= entries.length || assembler.done()
    const finish = () => {
      if (finished || written < taken || !exhausted()) return
      finished = true
      for (const w of workers) void w.terminate()
      search.plan.printer.finish(assembler.totals)
      search.plan.out.flush()
      resolve(options.status(assembler.matchedAny))
    }
    const take = (): Job | undefined => {
      if (exhausted()) return undefined
      const entry = entries[taken]
      if (entry === undefined) return undefined
      return { index: taken++, entry }
    }
    const feed = (worker: Worker) => {
      const jobs: Array<Job> = []
      for (let job = take(); job !== undefined; job = jobs.length < BATCH ? take() : undefined) jobs.push(job)
      if (Arr.isReadonlyArrayNonEmpty(jobs)) worker.postMessage(jobs)
    }
    for (const worker of workers) {
      worker.on("message", (message: FromWorker) => {
        if (message._tag === "Replies") for (const reply of message.replies) written = assembler.add(reply)
        feed(worker)
        finish()
      })
      worker.on("error", reject)
    }
    // This thread searches too, a slice at a time, between its messages.
    const slice = () => {
      const deadline = performance.now() + SLICE_MS
      for (let job = take(); job !== undefined; job = performance.now() < deadline ? take() : undefined) {
        written = assembler.add(searchInto(local, job, () => ""))
      }
      if (exhausted()) finish()
      else setImmediate(slice)
    }
    slice()
  })
