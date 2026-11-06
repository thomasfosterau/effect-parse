/**
 * A search worker: rebuilds the main thread's search from its command line
 * and searches the files it is sent into memory, replying with the output.
 *
 * @since 0.0.0
 */
import { parentPort, workerData } from "node:worker_threads"
import * as Result from "effect/Result"
import { workerSearch } from "./main.ts"
import type { FromWorker, Job, WorkerData } from "./parallel.ts"
import { searchInto } from "./parallel.ts"

// SAFETY: the main thread starts this worker with a `WorkerData` (parallel.ts)
const data = workerData as WorkerData
let stderr = ""
const search = workerSearch(
  {
    argv: data.argv,
    env: data.env,
    cwd: data.cwd,
    stdoutIsTty: data.stdoutIsTty,
    stdout: -1,
    stderr: (message) => {
      stderr += message
    },
    workerUrl: undefined,
    stdin: { readable: false, read: () => new Uint8Array() }
  },
  { sources: data.sources, roots: data.roots }
)

const take = () => {
  const text = stderr
  stderr = ""
  return text
}

if (Result.isFailure(search)) {
  // The main thread checked the command line already; this cannot happen.
  parentPort?.postMessage({ _tag: "Replies", replies: [] } satisfies FromWorker)
} else {
  const s = search.success
  parentPort?.on("message", (jobs: ReadonlyArray<Job>) => {
    const replies = jobs.map((job) => searchInto(s, job, take))
    const message: FromWorker = { _tag: "Replies", replies }
    parentPort?.postMessage(
      message,
      replies.map((r) => r.bytes.buffer)
    )
  })
  parentPort?.postMessage({ _tag: "Ready" } satisfies FromWorker)
}
