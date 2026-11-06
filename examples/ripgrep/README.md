# erg: ripgrep's command line on effect-parse

`erg` is a private example package: a recursive line searcher with [ripgrep](https://github.com/BurntSushi/ripgrep) 14.1's command line, whose regex engine is built from effect-parse combinators, and a harness that benchmarks it against ripgrep, GNU grep and the other search tools it finds installed. It exists to measure effect-parse on a real, well-specified workload. It has not been optimised yet.

```sh
pnpm install && vp run build          # erg imports the built package, as a dependent would
node examples/ripgrep/bin/erg.ts -n 'fn \w+' src
node examples/ripgrep/bin/erg.ts --help
```

Every flag of ripgrep 14.1 parses, with its short form, its `--no-…` negation and its aliases, in ripgrep's order of precedence (later flags win, `-A`/`-B` beat `-C`, short flags cluster, `RIPGREP_CONFIG_PATH` is read unless `--no-config`). The test suite runs about 130 command lines through both tools and requires byte-identical standard output and the same exit status (see [Tests](#tests)).

## How it uses effect-parse

| Part | Module | effect-parse |
| --- | --- | --- |
| Regex syntax | [`src/regex/syntax.ts`](src/regex/syntax.ts) | A parser for Rust's `regex` syntax (classes with `&&` / `--` / `~~`, Unicode properties, flags including `(?x)`, named groups, counted repetition), over `string` input. The grammar is a function of the active flags, built once per flag set. |
| Matcher | [`src/regex/compile.ts`](src/regex/compile.ts) | The syntax tree compiled to a `Parser<void, never, never, Uint8Array>` in continuation-passing style: each node is compiled with the parser for the rest of the pattern, so `Parser.alt` backtracking gives Rust's leftmost-first semantics. Literals are `Token.literal`s of UTF-8 bytes, ASCII classes are `Token.oneOf` byte sets, other classes are `Text.utf8.oneOf` over `Token.codePoints` ranges; repetition and assertions are `Parser.combinator`s, so the whole matcher compiles. |
| Compilers | `ERG_COMPILER` | The matcher runs under `Compiler.jit` (the default), `Compiler.closure`, `Compiler.wasm`, or interpreted (`none`). |
| Globs | [`src/walk/glob.ts`](src/walk/glob.ts) | `-g`, `--iglob`, `--type-add` and ignore-file globs are parsed with effect-parse into the same syntax tree and matched by the same compiler. |
| Driver | [`src/search/searcher.ts`](src/search/searcher.ts) | `Parser.run` on one reused `Input.State` per file, with `{ diagnostics: false }`, from each candidate start offset. |

Everything else (the flag table, the directory walker with gitignore semantics, the standard, summary and `--json` printers, colours, context, binary detection, encodings, `--pre` and `-z`) is plain TypeScript that follows ripgrep's behaviour.

## Benchmarks

```sh
vp run build
node examples/ripgrep/bench/compare.ts                    # a generated 12 MB corpus
node examples/ripgrep/bench/compare.ts --files 800 --lines 4000 --runs 10
node examples/ripgrep/bench/compare.ts --corpus ~/src/linux --cases literal,word
node examples/ripgrep/bench/compare.ts --backends jit,closure,wasm,none --json results.json
```

The harness ([`bench/compare.ts`](bench/compare.ts)) generates a deterministic corpus of source-like text ([`bench/corpus.ts`](bench/corpus.ts)), or searches a directory you name. It times twelve searches (literals, case-insensitive, words, alternation, class repetition, Unicode classes, inverted and summary modes, context) with ripgrep, each `erg` backend you list, GNU grep, and `ugrep`, `ag` and `git grep` when they are installed. Each `erg` result is checked against ripgrep's output before it is timed, so a time is only reported for a correct answer. Times are median wall times per process, start-up included.

<!-- results -->

## Where erg differs from ripgrep

- **Matching is backtracking.** The results are ripgrep's (leftmost-first, as in Rust's `regex` crate), but there is no automaton: pathological patterns such as `(a*)*b` on long runs of `a` take exponential time, where ripgrep guarantees linear time. A repetition of a multi-character group over a very long line can exhaust the JavaScript stack; `erg` then reports `the pattern nested too deeply` for that file and carries on. Repetitions of a single character class (`.*`, `\w+`, `[^"]*`) never recurse.
- **No PCRE2.** `-P`, `--pcre2` and `--engine pcre2` fail as they do in a ripgrep built without PCRE2; `--pcre2-version` says so.
- **One thread.** `-j` is accepted, but files are searched in order. Without `--sort`, files come out in directory order, where ripgrep's parallel walk has no fixed order.
- **Accepted, with no effect:** `--mmap`, `--dfa-size-limit`, `--regex-size-limit`, `--auto-hybrid-regex`, `--no-pcre2-unicode`.
- **`--no-unicode`** makes `\w`, `\d`, `\s` and `\b` ASCII-only; `.` still matches one UTF-8 character rather than any byte.
- **Binary detection** follows ripgrep's rules (implicit files stop at the 64 KiB buffer holding the first NUL, explicit files print `binary file matches` when the NUL is in the first buffer), with the buffer boundaries approximated.
- **Encodings** (`-E`) are WHATWG labels, decoded with `TextDecoder`, as ripgrep's are with `encoding_rs`.
- **`--generate`** writes erg's own man page and completion scripts, derived from the flag table.
- **Messages** on standard error start with `erg:` instead of `rg:`.

## Tests

[`test/cli.test.ts`](test/cli.test.ts) builds a corpus in a temporary directory (ignore files, hidden files, a binary file, UTF-16, CRLF, long lines, a file without a final newline) and, when `rg` is on the `PATH`, runs every command line in its table through ripgrep and through `erg` in-process, requiring the same standard output and exit status. The remaining tests run without ripgrep: regex semantics checked case by case on every backend, with the interpreter and the three compilers required to agree, plus globs, ignore files, file types, the flag parser and the CLI's own behaviour. They run with the library's suite (`vp run test:unit`).
