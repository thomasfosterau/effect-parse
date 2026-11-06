/**
 * The `jq.ts` example as a command-line tool, built with `effect/cli`:
 *
 * ```sh
 * node --experimental-strip-types examples/jq-cli.ts -c '.[] | select(.active) | .name' data.json
 * cat data.json | node --experimental-strip-types examples/jq-cli.ts length
 * ```
 *
 * It reads every input file (or standard input) whole, runs the filter over
 * each JSON value in it, and prints the outputs as jq does. `--timings`
 * prints how long reading, running and writing took, on standard error;
 * `bench/jq.bench.ts` uses it to separate the parser's time from the CLI's.
 */
// effect/cli is an unstable Effect module; this example is its intended use.
// @effect-diagnostics unstableApiUsage:off
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime"
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio"
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { Argument, CliError, Command, Flag } from "effect/cli"
import * as Jq from "./jq.ts"

/** The input files, or standard input's chunks, as one buffer. */
const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  chunks.reduce((offset, c) => {
    out.set(c, offset)
    return offset + c.length
  }, 0)
  return out
}

const decoder = new TextDecoder()

const jq = Command.make(
  "jq",
  {
    filter: Argument.String("filter").pipe(Argument.withDescription("The jq program to run")),
    files: Argument.String("file").pipe(
      Argument.withDescription("JSON files to read (standard input if none)"),
      Argument.variadic()
    ),
    compact: Flag.Boolean("compact-output").pipe(
      Flag.withDefault(false),
      Flag.withAlias("c"),
      Flag.withDescription("One output per line, without whitespace")
    ),
    raw: Flag.Boolean("raw-output").pipe(
      Flag.withDefault(false),
      Flag.withAlias("r"),
      Flag.withDescription("Print strings without quotes")
    ),
    nullInput: Flag.Boolean("null-input").pipe(
      Flag.withDefault(false),
      Flag.withAlias("n"),
      Flag.withDescription("Run the filter once on `null`, reading no input")
    ),
    slurp: Flag.Boolean("slurp").pipe(
      Flag.withDefault(false),
      Flag.withAlias("s"),
      Flag.withDescription("Run the filter once on an array of every input")
    ),
    tab: Flag.Boolean("tab").pipe(Flag.withDefault(false), Flag.withDescription("Indent with tabs")),
    indent: Flag.Int("indent").pipe(Flag.withDescription("Spaces to indent with"), Flag.withDefault(2)),
    backend: Flag.Literals("backend", ["interpreted", "closure", "jit", "wasm"]).pipe(
      Flag.withDescription("How effect-parse runs the JSON parser"),
      Flag.withDefault("jit")
    ),
    timings: Flag.Boolean("timings").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print phase timings on standard error")
    )
  },
  Effect.fn(function* (config) {
    const fs = yield* FileSystem.FileSystem
    const stdio = yield* Stdio.Stdio
    const t0 = performance.now()
    // A syntax error in the program, or malformed input, fails with its `ParseError`
    const program = yield* Effect.try({
      try: () => Jq.compile(config.filter),
      catch: (cause) => new CliError.UserError({ cause })
    })
    const chunks = config.nullInput
      ? []
      : Arr.isReadonlyArrayEmpty(config.files)
        ? Array.from(yield* Stream.runCollect(stdio.stdin))
        : yield* Effect.forEach(config.files, (file) => fs.readFile(file), { concurrency: 1 })
    const bytes = concat(chunks)
    const t1 = performance.now()
    const result = yield* Effect.try({
      try: () => Jq.run(program, decoder.decode(bytes), config),
      catch: (cause) => new CliError.UserError({ cause })
    })
    const t2 = performance.now()
    if (result.output !== "") yield* Stream.make(result.output).pipe(Stream.run(stdio.stdout()))
    if (Arr.isReadonlyArrayNonEmpty(result.errors)) {
      yield* Stream.make(`${result.errors.join("\n")}\n`).pipe(Stream.run(stdio.stderr()))
      yield* Effect.sync(() => {
        process.exitCode = 5
      })
    }
    const t3 = performance.now()
    if (config.timings) {
      const ms = (n: number) => n.toFixed(1)
      yield* Stream.make(`read ${ms(t1 - t0)} ms, run ${ms(t2 - t1)} ms, write ${ms(t3 - t2)} ms\n`).pipe(
        Stream.run(stdio.stderr())
      )
    }
  })
).pipe(Command.withDescription("A subset of jq, built with effect-parse"))

const NodeServices = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  NodeStdio.layer,
  NodeTerminal.layer,
  NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
)

jq.pipe(Command.run({ version: "0.1.0" }), Effect.provide(NodeServices), NodeRuntime.runMain)
