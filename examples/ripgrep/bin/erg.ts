#!/usr/bin/env node
/**
 * The `erg` command: ripgrep's command line, searching with effect-parse.
 *
 * @since 0.0.0
 */
import { main } from "../src/main.ts"
import * as Input from "../src/search/input.ts"

process.exitCode = main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdoutIsTty: process.stdout.isTTY === true,
  stdout: 1,
  stderr: (message) => process.stderr.write(message),
  stdin: { readable: Input.stdinIsReadable(), read: Input.readStdin }
})
