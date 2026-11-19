# Architecture

effect-parse is a port of two Rust parser-combinator libraries, [nom](https://github.com/rust-bakery/nom) (8.x) and [winnow](https://github.com/winnow-rs/winnow) (0.7.x), to TypeScript in the style of [Effect](https://effect.website) 4. This document is the broad view: how a parser runs, how it is compiled, streamed and turned into a syntax tree, and why. What each export does, and its edge cases, is in its doc comment; the details of each subsystem are in the header comment of its internal module.

## The core

A `Parser<A, E = never, R = never, I = string>` is a _step_ over a mutable cursor, as in winnow: `(state) => A | Fail`. The `State` (`Input.ts`) holds the input, the position, the mode of the last failure and the diagnostics. Alternatives backtrack by resetting the position, which is cheap. A failure records a small error record on the state and returns the `Fail` sentinel, so a successful step allocates nothing for errors.

Parsers are Effect values: pipeable with dual APIs (`Parser.map(p, f)` and `p.pipe(Parser.map(f))`), usable in generators (`Parser.gen`), with a typed error channel `E` for user failures and a requirements channel `R` for services, which replace winnow's `Stateful` input.

**Inputs.** `Input = string | Uint8Array | ReadonlyArray<unknown>`, winnow's `&str`, `&[u8]` and `TokenSlice`. Offsets are UTF-16 code units, bytes or elements, and always absolute. Strings are parsed natively rather than encoded to bytes: scanning bytes is faster, but text parsers mostly produce strings, and building a string from bytes costs several times more than slicing one. Binary sources (`ArrayBuffer`, `DataView`, other typed arrays) are viewed as a `Uint8Array` of the same memory, so slices stay zero-copy `subarray`s.

**Text.** nom's and winnow's character parsers are ASCII. `Text.make(encoding)` builds every text parser from one generic implementation for an `Encoding` (a record with `decode`, `width`, `encode` and `text`), so one grammar parses JavaScript strings, UTF-8, UTF-16 and Latin-1, and users can add encodings. Text parsers never match malformed input, and report a sequence cut off at the end of partial input as `Incomplete`.

**Errors.** Modes are winnow's: `Backtrack`, `Cut` and `Incomplete`. The public `ParseError<E>` is one `Data.TaggedError` with the offset, kind, expected set, context labels and a typed `cause`. Three heuristics make messages better than nom's or winnow's without annotations: `alt` merges the expected sets of branches that fail at the same offset, parsers that stop without failing leave _hints_ of what else they would have accepted, and the runner reports the _furthest_ recoverable failure when it lies past the final one. `cut` and successful lookaheads bound the furthest rule, and a failure with a user `cause` is never outranked.

## Modules

| Module | Role |
| --- | --- |
| `Parser` | The type, combinators and runners |
| `Input`, `ParseError` | The cursor and the `Fail` protocol; the error and its rendering |
| `Token`, `Ascii`, `Binary`, `Bits` | Token, ASCII, binary and bit-level parsers (winnow's `token`, `ascii`, `binary`) |
| `Text`, `Encoding` | Unicode text in any encoding |
| `Expression` | Pratt / precedence-climbing parsing (nom-language's `precedence`) |
| `Compiler` | Opt-in compilation: `jit`, `closure` and `wasm` |
| `ParserStream` | Parsing Effect `Stream`s and web streams as they arrive |
| `ParserSchema` | Parsers and printers derived from annotated `Schema`s |
| `Syntax` | Concrete syntax trees and incremental reparsing |
| `Nom` | nom's names for the same combinators |

The main API uses winnow's names in camelCase; `Nom` aliases nom's. Where behaviour departs from either library (`eof` on partial input, the progress check on every repetition, recovery from where the failing parser started), the export's doc comment says so.

## Compiled parsers

A grammar of combinators runs as a tree of megamorphic closure calls that allocate intermediate values. On the JSON example the hand-fused equivalent was about eight times faster, and turning off error bookkeeping saved under 7%: the cost is the structure, not the diagnostics. Rust gets winnow the fused version through monomorphization and inlining; effect-parse compiles it, following Effect 4's Schema compiler: parsers _describe_ themselves, a compiler turns descriptions into fast code with no diagnostics, the runners use it transparently, and the interpreter stays the reference implementation that produces every error.

**Descriptions.** Every parser carries an internal description node next to its step (`internal/node.ts`). Nodes refer to their child parsers, so a child's step is always at hand for fallback and recursion is a reference. Describing costs one small object per combinator call and nothing while parsing. What can't be described (`Parser.make`, `gen`, `flatMap`'s continuation) is `Opaque`, and runs its interpreted step inside compiled code; `Parser.combinator` lets an algorithm the compilers don't know (the Pratt loop, `permutation`) build its step from its children's compiled steps.

**Opt-in.** `Compiler.jit(p)` registers `p` with a backend and returns `p` itself: no new parser type and no new runner. Code is built lazily on the first run, per input kind, and cached. Compilation is a visible decision at the grammar's definition rather than automatic, because callbacks may then run twice or not at all, because its cost should be predictable, and because probing for `new Function` is reported under a Content Security Policy. Each backend is its own function and the runners reach them through a registry (`internal/compiler/registry.ts`), so a bundle contains only the backends it uses.

**Identical results.** Compiled code returns a value, or `Fail` with only the mode set. On any failure the runner discards the attempt and re-runs the interpreter, so every `ParseError` is the interpreter's, byte for byte. Compiled code may report `Incomplete` itself, but only where the interpreter does, with the same `needed`. Differential suites (`test/Compiler.test.ts`, `test/Streaming.test.ts`, `test/Syntax.test.ts`) run every example grammar with every backend and interpreted, on generated, mutated and truncated inputs, and require the same `Result`.

**Pipeline.** The compilers walk the graph of descriptions once per root and input kind: which nodes compile, whose outputs are used, which are shared or recursive (those become functions; `internal/compiler/graph.ts`), and each node's first set (`internal/compiler/first.ts`), which turns an `alt` or `dispatch` into a switch on the next unit. Code is then specialized per input kind and encoding: token sets become comparisons or tables, unused values are never built, floats are converted without slicing, and `Object.fromEntries` over a repetition of pairs becomes assignments.

**Backends.**

- The closure compiler (`internal/compiler/closure.ts`) builds one specialized closure per node and never generates code, so it works under a CSP.
- The JIT (`internal/compiler/jit.ts`) emits one JavaScript function per rule and inlines the rest as straight-line code with the cursor in a local, falling back to the closure compiler where `new Function` is unavailable.
- The WebAssembly compiler (`internal/compiler/wasm.ts`) exists because recognising the input, not building values, dominates the JIT. It copies the input into linear memory and scans it with generated WebAssembly (SIMD where available), recording only decisions and data in a trace; a generated JavaScript builder then reads the trace and builds the value with the same callbacks. Parts with no WebAssembly form run as _islands_, calls back into JIT code.

## Streaming

In partial mode a parser only succeeds on what it has seen: anything that would look past the end reports `Incomplete`. So a value parsed from a prefix is the value a parse of the whole input would produce, which is what lets `ParserStream.parseAll` parse a document as it arrives. When an attempt runs out of input, each repetition on the way out records a checkpoint (`internal/resume.ts`); the next attempt, with more input, re-enters from the root but resumes each repetition from its checkpoint, so it re-parses only the path to where the input ran out. Attempts wait until half as much input again has arrived, which keeps the total work linear. Compiled parsers have a resumable build that keeps the same checkpoints. On failure the buffered input is parsed again by the interpreter, so the error is the one a one-shot parse gives. Every stream runner bounds its buffer (`maxBufferSize`), since a stream is the one input whose size the caller doesn't choose.

## Syntax trees

`Syntax` gives grammars a mode like [Tree-sitter](https://tree-sitter.github.io)'s. `Syntax.node`, `token` and `field` annotate an existing grammar; every compiler treats them as identities, so one grammar serves `Parser.parse` and `Syntax.parse`. Trees are stored as _green_ nodes (relative offsets, no parent), as in Roslyn and rust-analyzer, so unchanged subtrees are shared between versions; `SyntaxNode` is the _red_ view built while navigating. Nodes built by an abandoned attempt are dropped when the cursor rewinds past them (`internal/syntax.ts`). `Syntax.reparse` is incremental packrat parsing (Dubroy and Warth, 2017) on the annotated rules: a node is reused when the input its parse looked at, which the builder records, is unchanged. A reparse returns the same tree, values and errors as a fresh parse.

## Parsers from schemas

`ParserSchema.toParser` and `toPrinter` derive a parser and its printer from an Effect `Schema`, as `Schema.toEquivalence` derives an equivalence: a walk over the AST that reads a node's annotation first, then falls back on its tag. The parser returns the schema's type with its checks and transformations applied, decoding each transformation once on its own node. Derived parsers are built from public combinators, so they compile.

## Performance

`vp run bench` measures the JSON example (0.58 M characters). Compiled with the JIT, the grammars run 4.6–8.7 times as fast as interpreted, and the WebAssembly compiler is a further 1.2–1.6 times as fast; `json-fast.ts`, which builds objects with `Parser.fromEntries`, matches a hand-fused parser. Against `JSON.parse` (`vp run bench:native`), compiled parsers take 1–6 times as long depending on the document.

### Against other JavaScript parser libraries

The same JSON documents (pretty-printed records), each library's grammar written in its own idiom, Node 22, the median over three processes of the best of 15–25 interleaved runs:

| Parser                              | 1 KB            | 60 KB          | 600 KB         |
| ----------------------------------- | --------------- | -------------- | -------------- |
| `JSON.parse`                        | 3.5 µs          | 0.17 ms        | 1.70 ms        |
| effect-parse `json-fast.ts`, JIT    | 8.6 µs (2.5×)   | 0.43 ms (2.5×) | 4.38 ms (2.6×) |
| effect-parse `json.ts`, JIT         | 13.3 µs (3.8×)  | 0.70 ms (4.1×) | 7.17 ms (4.2×) |
| Chevrotain 11                       | 30.6 µs (8.7×)  | 1.71 ms (10×)  | 22.2 ms (13×)  |
| effect-parse `json.ts`, interpreted | 55.4 µs (16×)   | 2.93 ms (17×)  | 31.2 ms (18×)  |
| Peggy 4                             | 66.5 µs (19×)   | 3.40 ms (20×)  | 37.3 ms (22×)  |
| Parsimmon 1.18                      | 163 µs (46×)    | 8.54 ms (50×)  | 88.6 ms (52×)  |
| Parjs 1.3                           | 182 µs (52×)    | 8.78 ms (51×)  | 109 ms (64×)   |
| Ohm 17                              | 1.84 ms (526×)  | 138 ms (801×)  | 1.59 s (938×)  |
| Arcsecond 5                         | 7.12 ms (2034×) | —              | —              |

Arcsecond is quadratic in the input, so it is timed on the small document only.
