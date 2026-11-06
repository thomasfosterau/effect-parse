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
| Searches | [`src/regex/finder.ts`](src/regex/finder.ts), [`src/regex/compile.ts`](src/regex/compile.ts) | The prefilters for several literals or a byte-set sequence, and the line counts of `-c`, `-l` and `-v -c` for a set of literals, are effect-parse parsers compiled by `Compiler.wasm`, whose output runs them with WebAssembly SIMD: `Token.takeUntilAny` (Teddy, from ripgrep: nibble-table swizzles, or `i8x16.eq` for a few distinct bytes) and `Token.takeTill` (thirty-two bytes a step). One parse per file lists every occurrence, or counts the lines and the matching ones. |

Everything else (the flag table, the directory walker with gitignore semantics, the standard, summary and `--json` printers, colours, context, binary detection, encodings, `--pre` and `-z`) is plain TypeScript that follows ripgrep's behaviour.

## How it gets its speed

The matcher is a backtracker, and running it at every byte of the input made `erg` 40 to 130 times slower than ripgrep. It now runs only where a match is possible, found the way ripgrep finds it:

- **Literal prefilters** ([`src/regex/prefilter.ts`](src/regex/prefilter.ts)): from the syntax tree, the literals every match starts with or contains, and, under `-i`, the sequence of small byte sets (`[sS][hH]…`). A literal is found by `Buffer#indexOf` on its rarest byte (a vectorised `memchr`, many times faster than its substring search) and checked around it; several are found once each and merged ([`src/regex/finder.ts`](src/regex/finder.ts)). A set of plain literals needs no matcher at all. Several literals, a literal with no rare byte, and a sequence of common bytes are found instead by an effect-parse parser, `Token.takeUntilAny` repeated and compiled by `Compiler.wasm`, which searches with WebAssembly SIMD: Teddy, from ripgrep, testing the first three bytes of every literal at sixteen positions at once with nibble-table lookups. One parse per file lists every occurrence.
- **A lazy DFA** ([`src/regex/dfa.ts`](src/regex/dfa.ts)): a Thompson NFA over UTF-8 bytes (Unicode classes as tries of byte ranges), determinised as the input reaches its states, with byte classes and line anchors resolved as RE2 does. One table lookup per byte finds the lines that hold a match; the matcher then finds the match in them. A single scan waits on each lookup in turn, so the input is searched in batches split into eight stretches of whole lines, stepped together in one loop so their lookups overlap (about twice the speed of one scan); a stretch that finishes early takes over half of the longest one left. Where only the lines matter (`-c`, `-l`, uncoloured output) a line the DFA confirms needs nothing more; where the match does, a DFA of the regex read backwards finds, in one pass over the line, every offset a match starts at, and the matcher runs only there. Patterns with word boundaries, and multiline search, are left to the matcher.
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

| case               |      rg |       erg (jit) |            grep |
| ------------------ | ------: | --------------: | --------------: |
| literal            | 32.4 ms | 160.7 ms (5.0×) |  59.1 ms (1.8×) |
| literal-count      | 16.0 ms | 115.1 ms (7.2×) |  49.1 ms (3.1×) |
| ignore-case        | 15.8 ms | 151.9 ms (9.6×) |  33.7 ms (2.1×) |
| word               | 32.7 ms | 210.5 ms (6.4×) |  81.1 ms (2.5×) |
| alternation        | 15.7 ms | 118.4 ms (7.6×) |  40.6 ms (2.6×) |
| class-repeat       | 25.3 ms | 223.8 ms (8.9×) | 125.8 ms (5.0×) |
| unicode-class      | 27.2 ms | 208.8 ms (7.7×) | 106.9 ms (3.9×) |
| word-chars         | 23.1 ms | 194.2 ms (8.4×) |  73.6 ms (3.2×) |
| no-match           | 11.2 ms | 100.2 ms (9.0×) |  12.5 ms (1.1×) |
| invert-count       | 19.2 ms | 103.2 ms (5.4×) |  30.5 ms (1.6×) |
| files-with-matches | 12.5 ms | 100.2 ms (8.0×) |  14.3 ms (1.1×) |
| context            | 88.1 ms | 269.9 ms (3.1×) | 164.8 ms (1.9×) |

A larger corpus (180 MB, 5 runs per case):

| case               |       rg |       erg (jit) |            grep |
| ------------------ | -------: | --------------: | --------------: |
| literal            | 148.8 ms | 403.4 ms (2.7×) | 315.6 ms (2.1×) |
| literal-count      |  31.0 ms | 204.2 ms (6.6×) | 223.0 ms (7.2×) |
| ignore-case        |  35.9 ms | 274.3 ms (7.6×) | 162.6 ms (4.5×) |
| word               | 126.2 ms | 461.7 ms (3.7×) | 362.1 ms (2.9×) |
| alternation        |  39.0 ms | 198.4 ms (5.1×) | 183.7 ms (4.7×) |
| class-repeat       |  89.6 ms | 454.0 ms (5.1×) | 683.5 ms (7.6×) |
| unicode-class      |  93.3 ms | 420.9 ms (4.5×) | 514.3 ms (5.5×) |
| word-chars         |  47.9 ms | 396.7 ms (8.3×) | 368.2 ms (7.7×) |
| no-match           |  23.9 ms | 124.8 ms (5.2×) |  50.9 ms (2.1×) |
| invert-count       |  46.5 ms | 219.8 ms (4.7×) | 126.4 ms (2.7×) |
| files-with-matches |  21.3 ms | 173.2 ms (8.2×) |  62.7 ms (2.9×) |
| context            | 480.7 ms | 991.8 ms (2.1×) | 892.4 ms (1.9×) |

`erg` is 2 to 10 times slower than ripgrep, where the first unoptimised version was 40 to 130 times slower. About 45 ms of every run is starting Node and loading `erg`, against a couple of milliseconds for ripgrep, and walking and reading the 180 MB corpus on one Node thread takes about 78 ms before any search. Beyond that the remaining gap is ripgrep's compiled DFA, which a JavaScript loop over bytes does not match even stepping eight lines at once, and its threads, which start in microseconds where a worker thread takes tens of milliseconds and brings its own garbage collector and compiler threads.

## Where erg differs from ripgrep

- **Matching is backtracking.** The results are ripgrep's (leftmost-first, as in Rust's `regex` crate), and the DFA finds the lines that match in linear time, but the matcher that then finds the match in a line backtracks: pathological patterns such as `(a*)*b` on long runs of `a` take exponential time in the lines that hold a match, where ripgrep guarantees linear time. A repetition of a multi-character group over a very long line can exhaust the JavaScript stack; `erg` then reports `the pattern nested too deeply` for that file and carries on. Repetitions of a single character class (`.*`, `\w+`, `[^"]*`) never recurse.
- **No PCRE2.** `-P`, `--pcre2` and `--engine pcre2` fail as they do in a ripgrep built without PCRE2; `--pcre2-version` says so.
- **Threads.** `-j1` searches on one thread; otherwise `erg` searches on this thread and a worker for every two cores (each worker is a V8 isolate with its own garbage collector and compiler threads: more are slower), but only for a search it expects to take longer than about 150 ms, since a worker takes tens of milliseconds to start. Output always comes out in directory order (ripgrep's parallel walk has no fixed order), and `--sort` searches on one thread, as in ripgrep.
- **Accepted, with no effect:** `--mmap`, `--dfa-size-limit`, `--regex-size-limit`, `--auto-hybrid-regex`, `--no-pcre2-unicode`.
- **`--no-unicode`** makes `\w`, `\d`, `\s` and `\b` ASCII-only; `.` still matches one UTF-8 character rather than any byte.
- **Binary detection** follows ripgrep's rules (implicit files stop at the 64 KiB buffer holding the first NUL, explicit files print `binary file matches` when the NUL is in the first buffer), with the buffer boundaries approximated.
- **Encodings** (`-E`) are WHATWG labels, decoded with `TextDecoder`, as ripgrep's are with `encoding_rs`.
- **`--generate`** writes erg's own man page and completion scripts, derived from the flag table.
- **Messages** on standard error start with `erg:` instead of `rg:`.

## Tests

[`test/cli.test.ts`](test/cli.test.ts) builds a corpus in a temporary directory (ignore files, hidden files, a binary file, UTF-16, CRLF, long lines, a file without a final newline) and, when `rg` is on the `PATH`, runs every command line in its table through ripgrep and through `erg` in-process, requiring the same standard output and exit status. The remaining tests run without ripgrep: regex semantics checked case by case on every backend, with the interpreter and the three compilers required to agree, plus globs, ignore files, file types, the flag parser and the CLI's own behaviour. They run with the library's suite (`vp run test:unit`).
