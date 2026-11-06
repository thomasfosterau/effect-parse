# erg: ripgrep's command line on effect-parse

`erg` is a private example package: a recursive line searcher with [ripgrep](https://github.com/BurntSushi/ripgrep) 14.1's command line, whose regex engine is built from effect-parse combinators, and a harness that benchmarks it against ripgrep, GNU grep and the other search tools it finds installed. It exists to measure effect-parse on a real, well-specified workload, and to see how close a TypeScript implementation can get to ripgrep.

```sh
pnpm install
node examples/ripgrep/scripts/bundle.mjs     # dist/erg.mjs: one module, compile cache on
node examples/ripgrep/dist/erg.mjs -n 'fn \w+' src
node examples/ripgrep/bin/erg.ts --help      # or run the sources directly (slower to start)
```

Every flag of ripgrep 14.1 parses, with its short form, its `--no-…` negation and its aliases, in ripgrep's order of precedence (later flags win, `-A`/`-B` beat `-C`, short flags cluster, `RIPGREP_CONFIG_PATH` is read unless `--no-config`). The test suite runs about 130 command lines through both tools and requires byte-identical standard output and the same exit status (see [Tests](#tests)).

## How it uses effect-parse

| Part | Module | effect-parse |
| --- | --- | --- |
| Regex syntax | [`src/regex/syntax.ts`](src/regex/syntax.ts) | A parser for Rust's `regex` syntax (classes with `&&` / `--` / `~~`, Unicode properties, flags including `(?x)`, named groups, counted repetition), over `string` input. The grammar is a function of the active flags, built once per flag set. |
| Matcher | [`src/regex/compile.ts`](src/regex/compile.ts) | The syntax tree compiled to a `Parser<void, never, never, Uint8Array>` in continuation-passing style: each node is compiled with the parser for the rest of the pattern, so `Parser.alt` backtracking gives Rust's leftmost-first semantics. Literals are `Token.literal`s of UTF-8 bytes; classes, repetitions and assertions are `Parser.combinator`s (a class is a byte table plus a range search, and a repetition only hands control on where the rest of the pattern can start), so the whole matcher compiles. It decides every match `erg` prints: where it starts and ends, and its capture groups. |
| Compilers | `ERG_COMPILER` | The matcher runs under `Compiler.jit` (the default), `Compiler.closure`, `Compiler.wasm`, or interpreted (`none`). For this matcher, made of `Parser.combinator`s, the four are within a few percent of each other. |
| Globs | [`src/walk/glob.ts`](src/walk/glob.ts) | `-g`, `--iglob`, `--type-add` and ignore-file globs are parsed with effect-parse into the same syntax tree and matched by the same compiler, except the literal, extension and basename globs, which are compared directly. |
| Driver | [`src/regex/compile.ts`](src/regex/compile.ts) | `Compiler.runner` on one reused `Input.State` per file, with `{ diagnostics: false }`, at the candidate positions the prefilters and the DFA leave. |

Everything else (the flag table, the directory walker with gitignore semantics, the standard, summary and `--json` printers, colours, context, binary detection, encodings, `--pre` and `-z`) is plain TypeScript that follows ripgrep's behaviour.

## How it gets its speed

The matcher is a backtracker, and running it at every byte of the input made `erg` 40 to 130 times slower than ripgrep. It now runs only where a match is possible, found the way ripgrep finds it:

- **Literal prefilters** ([`src/regex/prefilter.ts`](src/regex/prefilter.ts)): from the syntax tree, the literals every match starts with or contains, and, under `-i`, the sequence of small byte sets (`[sS][hH]…`). A literal is found by `Buffer#indexOf` on its rarest byte (a vectorised `memchr`, many times faster than its substring search) and checked around it; several are found once each and merged ([`src/regex/finder.ts`](src/regex/finder.ts)). A set of plain literals needs no matcher at all.
- **A lazy DFA** ([`src/regex/dfa.ts`](src/regex/dfa.ts)): a Thompson NFA over UTF-8 bytes (Unicode classes as tries of byte ranges), determinised as the input reaches its states, with byte classes and line anchors resolved as RE2 does. One table lookup per byte finds the lines that hold a match; the matcher then finds the match in them. Patterns with word boundaries, and multiline search, are left to the matcher.
- **Follow sets**: a repetition such as `\w+` gives characters back only where the rest of the pattern can start, and an attempt that fails at the start of a run of the leading class skips the rest of the run.
- **Parallel search** ([`src/parallel.ts`](src/parallel.ts)): when a search would take more than about 150 ms on one thread, worker threads search files into memory while the main thread searches too, and the output is written in walk order. The workers start during the walk, as soon as it has found that much input, so they load while it finishes.
- **Less work per file and per run**: files read into one reused `Buffer` (whose `indexOf` is the native one); binary detection skipped for files without a match where it changes nothing; line numbers counted only when printed; output written straight from the input buffer; ignore files read only when a directory has them; Unicode tables precomputed ([`scripts/unicode-tables.mjs`](scripts/unicode-tables.mjs)); one bundled module with Node's compile cache, and the heavier Node built-ins loaded on first use.

## Benchmarks

```sh
node examples/ripgrep/bench/compare.ts                    # bundles erg; a generated 32 MB corpus
node examples/ripgrep/bench/compare.ts --files 800 --lines 4000 --runs 10
node examples/ripgrep/bench/compare.ts --corpus ~/src/linux --cases literal,word
node examples/ripgrep/bench/compare.ts --backends jit,closure,wasm,none --json results.json
```

The harness ([`bench/compare.ts`](bench/compare.ts)) generates a deterministic corpus of source-like text ([`bench/corpus.ts`](bench/corpus.ts)), or searches a directory you name. It times twelve searches (literals, case-insensitive, words, alternation, class repetition, Unicode classes, inverted and summary modes, context) with ripgrep, each `erg` backend you list, GNU grep, and `ugrep`, `ag` and `git grep` when they are installed. Each `erg` result is checked against ripgrep's output before it is timed, so a time is only reported for a correct answer. Times are median wall times per process, start-up included.

Results on a 4-core cloud VM (Intel Xeon at 2.1 GHz, Node 22.23, ripgrep 14.1.0, GNU grep), median wall time with process start-up, (n×) relative to ripgrep. Every `erg` output was identical to ripgrep's. grep searches files ripgrep's ignore rules skip, so its numbers are only indicative.

The generated corpus (32.5 MB, 7 runs per case):

| case               |      rg |        erg (jit) |            grep |
| ------------------ | ------: | ---------------: | --------------: |
| literal            | 27.5 ms |  144.6 ms (5.3×) |  61.6 ms (2.2×) |
| literal-count      | 11.4 ms |  104.2 ms (9.2×) |  40.7 ms (3.6×) |
| ignore-case        | 11.7 ms | 164.9 ms (14.1×) |  30.1 ms (2.6×) |
| word               | 30.5 ms |  177.8 ms (5.8×) |  79.4 ms (2.6×) |
| alternation        | 15.4 ms |  136.9 ms (8.9×) |  36.3 ms (2.4×) |
| class-repeat       | 19.4 ms | 206.6 ms (10.6×) | 114.9 ms (5.9×) |
| unicode-class      | 25.4 ms |  245.8 ms (9.7×) |  95.2 ms (3.7×) |
| word-chars         | 19.5 ms | 280.0 ms (14.3×) |  72.6 ms (3.7×) |
| no-match           | 11.3 ms |   80.1 ms (7.1×) |  11.9 ms (1.1×) |
| invert-count       | 16.2 ms |  145.1 ms (9.0×) |  25.1 ms (1.6×) |
| files-with-matches | 10.5 ms |   84.8 ms (8.1×) |  12.9 ms (1.2×) |
| context            | 80.8 ms |  239.1 ms (3.0×) | 182.1 ms (2.3×) |

A larger corpus (180 MB, 5 runs per case):

| case               |       rg |        erg (jit) |            grep |
| ------------------ | -------: | ---------------: | --------------: |
| literal            | 124.2 ms |  391.4 ms (3.2×) | 331.3 ms (2.7×) |
| literal-count      |  29.9 ms |  202.1 ms (6.8×) | 215.3 ms (7.2×) |
| ignore-case        |  30.3 ms | 366.7 ms (12.1×) | 155.1 ms (5.1×) |
| word               | 120.1 ms |  428.1 ms (3.6×) | 344.7 ms (2.9×) |
| alternation        |  37.2 ms |  331.2 ms (8.9×) | 176.6 ms (4.7×) |
| class-repeat       |  88.0 ms |  614.7 ms (7.0×) | 676.3 ms (7.7×) |
| unicode-class      |  98.6 ms |  585.2 ms (5.9×) | 483.5 ms (4.9×) |
| word-chars         |  46.7 ms | 630.7 ms (13.5×) | 352.9 ms (7.6×) |
| no-match           |  18.3 ms |  111.7 ms (6.1×) |  42.3 ms (2.3×) |
| invert-count       |  43.5 ms |  360.8 ms (8.3×) | 111.8 ms (2.6×) |
| files-with-matches |  20.8 ms |  115.5 ms (5.5×) |  50.4 ms (2.4×) |
| context            | 440.3 ms |  891.2 ms (2.0×) | 951.6 ms (2.2×) |

`erg` is 2 to 14 times slower than ripgrep, where the first unoptimised version was 40 to 130 times slower. About 45 ms of every run is starting Node and loading `erg`, against a couple of milliseconds for ripgrep. Beyond that the remaining gap is ripgrep's SIMD literal search (Teddy) and its compiled DFA, which a JavaScript loop over bytes does not match, and its threads, which start in microseconds where a worker thread takes tens of milliseconds.

## Where erg differs from ripgrep

- **Matching is backtracking.** The results are ripgrep's (leftmost-first, as in Rust's `regex` crate), and the DFA finds the lines that match in linear time, but the matcher that then finds the match in a line backtracks: pathological patterns such as `(a*)*b` on long runs of `a` take exponential time in the lines that hold a match, where ripgrep guarantees linear time. A repetition of a multi-character group over a very long line can exhaust the JavaScript stack; `erg` then reports `the pattern nested too deeply` for that file and carries on. Repetitions of a single character class (`.*`, `\w+`, `[^"]*`) never recurse.
- **No PCRE2.** `-P`, `--pcre2` and `--engine pcre2` fail as they do in a ripgrep built without PCRE2; `--pcre2-version` says so.
- **Threads.** `-j1` searches on one thread; otherwise `erg` uses one worker per core, but only for a search it expects to take longer than about 150 ms, since a worker takes tens of milliseconds to start. Output always comes out in directory order (ripgrep's parallel walk has no fixed order), and `--sort` searches on one thread, as in ripgrep.
- **Accepted, with no effect:** `--mmap`, `--dfa-size-limit`, `--regex-size-limit`, `--auto-hybrid-regex`, `--no-pcre2-unicode`.
- **`--no-unicode`** makes `\w`, `\d`, `\s` and `\b` ASCII-only; `.` still matches one UTF-8 character rather than any byte.
- **Binary detection** follows ripgrep's rules (implicit files stop at the 64 KiB buffer holding the first NUL, explicit files print `binary file matches` when the NUL is in the first buffer), with the buffer boundaries approximated.
- **Encodings** (`-E`) are WHATWG labels, decoded with `TextDecoder`, as ripgrep's are with `encoding_rs`.
- **`--generate`** writes erg's own man page and completion scripts, derived from the flag table.
- **Messages** on standard error start with `erg:` instead of `rg:`.

## Tests

[`test/cli.test.ts`](test/cli.test.ts) builds a corpus in a temporary directory (ignore files, hidden files, a binary file, UTF-16, CRLF, long lines, a file without a final newline) and, when `rg` is on the `PATH`, runs every command line in its table through ripgrep and through `erg` in-process, requiring the same standard output and exit status. The remaining tests run without ripgrep: regex semantics checked case by case on every backend, with the interpreter and the three compilers required to agree, plus globs, ignore files, file types, the flag parser and the CLI's own behaviour. They run with the library's suite (`vp run test:unit`).
