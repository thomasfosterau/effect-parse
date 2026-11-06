#!/usr/bin/env node
/**
 * The `erg` command: ripgrep's command line, searching with effect-parse.
 *
 * @since 0.0.0
 */
import { main } from "../src/main.ts"
import * as Input from "../src/search/input.ts"

process.exitCode = await main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdoutIsTty: process.stdout.isTTY === true,
  stdout: 1,
  stderr: (message) => process.stderr.write(message),
  // Next to this module: the source in a checkout, the bundle's worker in dist/.
  workerUrl: new URL(import.meta.url.endsWith(".ts") ? "../src/worker.ts" : "./erg-worker.mjs", import.meta.url),
  stdin: { readable: Input.stdinIsReadable(), read: Input.readStdin }
})
