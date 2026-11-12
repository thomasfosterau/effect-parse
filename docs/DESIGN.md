# effect-parse design

This document records the research behind effect-parse and the plan used to build it. effect-parse is a port of two Rust parser-combinator libraries, [nom](https://github.com/rust-bakery/nom) (8.x) and [winnow](https://github.com/winnow-rs/winnow) (0.7.x), to TypeScript, written in the style of [Effect](https://effect.website) 4.

## 1. What the source libraries look like

### nom 8

- A parser is anything implementing `Parser<I>`, with `process(input) -> IResult<I, O, E>`. Input goes in by value and comes back as the remaining input, so `IResult<I, O, E> = Result<(I, O), Err<E>>`.
- `Err<E>` has three modes: `Error` (recoverable, so `alt` tries the next branch), `Failure` (unrecoverable, produced by `cut`), and `Incomplete(Needed)` (streaming input ran out).
- Modules come in pairs, `bytes::{complete, streaming}` and `character::{complete, streaming}`. The streaming variants return `Incomplete` at end of input.
- Error types are pluggable through the `ParseError<I>` trait (`error::Error` holds `(input, ErrorKind)`, and `VerboseError` holds a context stack).
- Naming: `tag`, `char`, `many0`/`many1`, `separated_list0`, `map_res`, `recognize`, `consumed`, `value`, `pair`, `tuple`, `count`, and so on.

### winnow 0.7

winnow forked from nom and changed a few things that matter here:

- `Parser<I, O, E>::parse_next(&mut I) -> Result<O, E>`. The input is a **mutable cursor** that parsers advance, and alternatives rewind it with `checkpoint`/`reset`. Plain functions/closures are parsers.
- `ErrMode<E>` = `Backtrack | Cut | Incomplete(Needed)`.
- Instead of separate streaming modules, the _input type_ says whether it is streaming: `Partial<I>`. One set of parsers handles both cases.
- Stream wrappers add features: `LocatingSlice` (spans), `Stateful<I, S>` (user state), `Recoverable` (error recovery), `Bytes`, `BStr`, and `TokenSlice` (parsing a lexer's tokens).
- `ContextError` collects `StrContext::{Label, Expected}` context and an optional external `cause`. `ParseError` renders the input with a caret.
- Parser methods: `map`, `try_map`, `verify_map`, `verify`, `value`, `default_value`, `void`, `take` (recognize), `with_taken`, `span`, `with_span`, `flat_map`, `and_then`, `parse_to`, `context`, `complete_err`, `retry_after`, `resume_after`.
- Combinators: `alt`, `dispatch!`, `permutation`, `seq!`, `preceded`, `terminated`, `delimited`, `separated_pair`, `repeat(range, p)`, `repeat_till`, `separated`, `separated_foldl1/foldr1`, `fold`, `opt`, `cond`, `peek`, `not`, `eof`, `cut_err`, `backtrack_err`, `empty`, `fail`, `trace`.
- Modules: `token` (`any`, `literal`, `one_of`, `none_of`, `take`, `take_while(range, set)`, `take_till`, `take_until`, `rest`), `ascii` (character classes, `dec_int`, `dec_uint`, `hex_uint`, `float`, escaping, `Caseless`), and `binary` (endian numbers, `length_*`, `bits`).
- `repeat` and `separated` treat a parser that succeeds without consuming input as a bug, and fail with an assertion error instead of looping forever.

### What Effect 4 brings

- Pipeable data types with **dual** APIs: `Parser.map(p, f)` and `p.pipe(Parser.map(f))` both work.
- Generator syntax (`Effect.gen`), where `yield*` unwraps values.
- Typed error channels, `Data.TaggedError` (errors that can be yielded inside `Effect.gen`), `Option`, and `Result`.
- `Context` services and requirements (`R`).
- `Stream` for incremental input, and `Schema` for decoding.

## 2. Synthesis: decisions

| Topic | nom | winnow | effect-parse |
| --- | --- | --- | --- |
| Parser signature | `I -> Result<(I, O), Err<E>>` | `&mut I -> Result<O, ErrMode<E>>` | Mutable cursor like winnow (`(state) => A \| Fail`), for speed and cheap backtracking |
| Type | `impl Parser<I>` | `impl Parser<I, O, E>` | `Parser<A, E = never, R = never, I = string>`, ordered like Effect's `Effect<A, E, R>` with the input type last |
| Error modes | Error / Failure / Incomplete | Backtrack / Cut / Incomplete | Backtrack / Cut / Incomplete (winnow names) |
| Streaming | separate `streaming` modules | `Partial<I>` input | `partial` flag on the parse state; `Parser.parsePartial` and the `ParserStream` module, which works over Effect `Stream`s |
| Error type | pluggable trait | pluggable trait (`ContextError` by default) | One rich `ParseError<E>` (`Data.TaggedError`) with offset, kind, expected set, context labels, and a typed `cause: E` for user errors |
| Custom errors | `FromExternalError` | `FromExternalError`, `cause` | Typed through the `E` channel: `Parser.fail(e)`, `Parser.tryMap(f)` |
| User state | none | `Stateful<I, S>` | Effect `Context` services in `R`: `Parser.service(Tag)` and `Parser.provideService`; `parseEffect` takes them from the running Effect |
| Spans | `nom_locate` crate | `LocatingSlice` | Offsets are always absolute: `Parser.span`, `Parser.withSpan`, `Parser.location` |
| Recovery | none | `Recoverable` + `resume_after` / `retry_after` | `Parser.resumeAfter` / `Parser.retryAfter` + `Parser.parseRecoverable` |
| Sequencing | tuples, `pair` | tuples, `seq!` | `Parser.seq(...)` (tuple), `Parser.struct({...})`, `Parser.gen(function*(){})`, and Do notation |
| Repetition | `many0`, `many1`, `many_m_n`, `count`... | `repeat(range, p)` | `Parser.repeat(p, range)` with `range = number \| { min?, max? }`. The result is typed `NonEmptyArray` when `min` is a positive literal |
| Names | snake_case nom names | snake_case winnow names | camelCase winnow names in the main API; nom names in the `Nom` module |
| Expressions | `nom-language::precedence` | `separated_foldl1` | Both: `Parser.separatedFoldl1/r1` and an `Expression.precedence` Pratt parser |
| Debugging | `dbg_dmp` | `trace` | `Parser.trace(name, p)` plus a `trace` option on `parse` |

### Inputs and tokens

`Input = string | Uint8Array | ReadonlyArray<unknown>`. These map to winnow's `&str`, `&[u8]`, and `TokenSlice<T>`:

| Input              | Token                             | Slice                                     |
| ------------------ | --------------------------------- | ----------------------------------------- |
| `string`           | `string` (one Unicode code point) | `string`                                  |
| `Uint8Array`       | `number` (byte)                   | `Uint8Array` (a `subarray` view, no copy) |
| `ReadonlyArray<T>` | `T`                               | `ReadonlyArray<T>`                        |

Offsets are UTF-16 code-unit indices for strings, byte indices for `Uint8Array`, and element indices for arrays.

**Binary data** (`ArrayBuffer`, `SharedArrayBuffer`, `DataView`, other typed arrays) is a _source_, not another input kind. The runners, `ParserStream` and the `State` constructor accept it wherever the parser reads a `Uint8Array` (`Input.Source<I>`), and view it as a `Uint8Array` of the same memory. A separate `ArrayBuffer` input kind would add nothing: indexing an `ArrayBuffer` needs a view anyway, and slicing one copies. With a view, slices stay zero-copy `subarray`s and every byte parser works unchanged. A view of a resizable buffer is given a fixed length, so the input can't change size during a parse. Typed arrays with wider elements are viewed in platform byte order: a `Uint16Array` of UTF-16 code units is UTF-16LE on all common platforms. `TextDecoder` is never given a view of a `SharedArrayBuffer` directly (some browsers reject it); such slices are copied first.

When a token parser could work on several input kinds, it takes a type parameter that defaults to `string`, much like Rust's turbofish: `Token.take<Uint8Array>(4)`. When the input kind can be inferred from an argument (`Token.literal(new Uint8Array([1]))`), it is. The `Binary` module is typed for bytes only.

### Text and encodings

nom and winnow parse `&str` and `&[u8]`, and their character parsers are ASCII. effect-parse adds a `Text` module for Unicode text in any encoding.

**One implementation, many encodings.** An `Encoding` is a small record: `decode(input, offset, end)` returns a code point, _malformed_ (-1) or _truncated_ (-2), and there are also `width`, `encode` and `text` (slice to string). `Text.make(encoding)` builds every text parser from one generic implementation, and returns a `TextParsers<I>` record. Grammars written against that record parse JavaScript strings, UTF-8, UTF-16LE/BE and Latin-1 unchanged, and users can add encodings. The parsers are a record of values rather than functions with an encoding argument, so they are built once per encoding and the encoding never appears in a hot loop's call signature.

**Why not parse bytes everywhere?** An obvious design would be to encode strings to UTF-8 with `TextEncoder` and parse only bytes. We measured it on V8 with a 0.5 MB document:

| Operation                                      | Time    |
| ---------------------------------------------- | ------- |
| `TextEncoder.encode` of the whole document     | 0.9 ms  |
| scanning digits, string (`charCodeAt`)         | 1.25 ms |
| scanning digits, bytes                         | 0.53 ms |
| 37k slices with `String.prototype.slice`       | 0.7 ms  |
| 37k slices with `TextDecoder.decode(subarray)` | 5.0 ms  |
| 37k slices built with `String.fromCharCode`    | 2.9 ms  |

Scanning bytes is faster, but text parsers mostly _produce strings_, and building a string from bytes costs 4–7 times more than slicing a string. It would also turn string offsets into byte offsets, which would break spans, error columns and `Parser.location`. So strings are parsed natively, as UTF-16 code units, and only byte inputs are decoded. Short slices of bytes are built by hand, eight ASCII bytes per `String.fromCharCode` call (that beats `TextDecoder`'s fixed cost up to about 40 bytes; a character at a time, the limit was 24), and longer ones use `TextDecoder`. With the JSON grammar (best of interleaved runs), `Text.string` was 5–15% slower than the hand-written `Token`/`Ascii` parser, and `Text.utf8` on bytes was within about 10% of `TextDecoder` followed by `Text.string`. The generic scan loop, which calls through the encoding and predicate, accounts for most of the difference.

**Fast paths.** The scan loop skips `decode` for units that are known to be single-unit code points: below 0xD800 for strings, below 0x80 for UTF-8 and 0x100 for Latin-1. Unicode predicates (`Text.isLetter`, built on regular expression property escapes) cache their answers for the BMP in a lazily allocated table. They are marked as _code-point predicates_, so `Token` and `Text` call them with numbers instead of allocating a string per character. This also applies to the `Ascii` predicates, and to predicates declared with `Token.codePoints`. Other predicates receive strings, made with `String.fromCharCode` below U+10000 (several times cheaper than `String.fromCodePoint`, which only astral characters need).

**Strictness.** Text parsers never match malformed input: invalid UTF-8, overlong forms, surrogates encoded in UTF-8, and unpaired UTF-16 surrogates. On partial input, a sequence cut off at the end reports `Incomplete`, so byte streams can be parsed as text chunk by chunk. `Token` keeps its lenient handling of lone surrogates in strings.

**Errors.** `Text` parsers on byte input record their encoding on the `State`, and the runners copy it to `ParseError.encoding`. The error message then decodes the line (replacing malformed bytes with U+FFFD) and reports the line and column in code points, plus the byte offset.

### Error model

Internally a failure stores a small error record on the parse state, then returns a unique `Fail` sentinel. Successful steps allocate nothing for errors.

```
mode:     Backtrack | Cut | Incomplete
offset:   where it failed
kind:     ErrorKind (nom-style: "Literal", "Digit", "Verify", "Eof", ...)
expected: ReadonlyArray<string>   (rendered alternatives: `"abc"`, `digit`, ...)
context:  ReadonlyArray<string>   (labels from Parser.context, innermost first)
cause:    E | undefined           (user error)
needed:   number | undefined      (Incomplete)
```

`alt` merges branch errors with the _furthest failure wins_ rule. When branches fail at the same offset, their `expected` sets are combined. That gives messages like `expected one of "true", "false", "null"` without any annotation, which is better than both nom and winnow out of the box (each keeps only one branch's error).

When the final failure is a plain syntax error, the runner reports the _furthest_ recoverable failure instead if it lies further into the input, including one swallowed by backtracking (a trailing separator followed by an invalid element). Two rules keep it honest: `cut` keeps only the failures recorded after the commit, and a lookahead that succeeds forgets the failures recorded inside it (see section 5).

`Parser.expected(desc)` replaces the expected set when a parser fails without consuming input (Parsec's `<?>`). `Parser.context(label)` adds a context label (winnow `StrContext::Label`, nom `context`).

The public `ParseError<E>` extends `Data.TaggedError("ParseError")`. It can be yielded in `Effect.gen`, and its `message` renders like this:

```
Parse error at line 1, column 3:
1 | [1,,2]
  |    ^
expected value
```

## 3. Module plan

| Module | Contents |
| --- | --- |
| `Parser` | Core type, constructors (`make`, `succeed`, `sync`, `fail`, `reject`, `empty`, `suspend`, `todo`), mapping (`map`, `as`, `asVoid`, `tap`, `flatMap`, `mapParser`, `tryMap`, `filterMap`, `filter`), consumption (`taken`, `withTaken`, `span`, `withSpan`, `location`), errors (`cut`, `backtrack`, `complete`, `context`, `expected`, `mapError`, `catch`-style `orElse`), control (`opt`, `cond`, `peek`, `not`, `eof`, `allConsuming`), sequencing (`seq`, `struct`, `zip`, `zipWith`, `preceded`, `terminated`, `delimited`, `separatedPair`, `gen`, `Do`/`bind`/`bindTo`/`let`), choice (`alt`, `dispatch`, `permutation`), repetition (`repeat`, `repeatTill`, `separated`, `separatedFoldl1`, `separatedFoldr1`, `fold`), services (`service`, `serviceWith`, `provide`, `provideService`), recovery (`resumeAfter`, `retryAfter`), debugging (`trace`), and runners (`parse`, `parseSync`, `parsePeek`, `parsePartial`, `parseEffect`, `parseRecoverable`) |
| `ParseError` | `ParseError` class, `ErrorKind`, `Needed`, `lineColumn` |
| `Input` | Input/token/slice types, the `State` cursor used by `Parser.make` |
| `Token` | `any`, `literal`, `oneOf`, `noneOf`, `take`, `takeWhile`, `takeTill`, `takeUntil`, `rest`, `restLen`, and `TokenSet` (`string`, predicate, array, ranges) |
| `Ascii` | `digit0/1`, `alpha0/1`, `alphanumeric0/1`, `hexDigit0/1`, `octDigit0/1`, `space0/1`, `multispace0/1`, `crlf`, `lineEnding`, `newline`, `tab`, `tillLineEnding`, `decUint`, `decInt`, `hexUint`, `float`, `takeEscaped`, `escapedTransform`, `caseless`, character predicates, and an `Ascii.bytes` view for `Uint8Array` input |
| `Text` | `TextParsers<I>` built by `make(encoding)`, with `string`, `utf8`, `utf16le`, `utf16be` and `latin1` instances: tokens, slices, Unicode character classes, `identifier`, line endings, numbers and escapes; Unicode predicates and `property` |
| `Encoding` | The `Encoding` interface, the built-in encodings, and `sniff` (BOM detection) |
| `Binary` | `u8`, `i8`, `be*/le*` numbers (16/24/32 as `number`, 64/128 as `bigint`), floats, `lengthTake`, `lengthRepeat`, `lengthAndThen`, `bits` |
| `Bits` | Bit-level parsers inside `Binary.bits`: `take`, `pattern`, `bool`, `bytes` |
| `Expression` | Pratt / precedence-climbing expression parser (from `nom-language::precedence`) |
| `Compiler` | Compile a parser with the JIT (`jit`) or the closure compiler (`closure`) (section 6) |
| `ParserStream` | Run a parser repeatedly over an Effect `Stream` of chunks (partial parsing) |
| `ParserSchema` | Build an Effect `Schema` that decodes a string with a parser, and derive a parser from an annotated `Schema` (section 9) |
| `Syntax` | Concrete syntax trees and incremental reparsing, after Tree-sitter (section 8) |
| `Nom` | nom-named aliases: `tag`, `tagNoCase`, `char`, `many0`, `many1`, `manyMN`, `manyTill`, `count`, `separatedList0/1`, `foldMany0/1`, `mapRes`, `mapOpt`, `recognize`, `consumed`, `value`, `pair`, `tuple`, `isA`, `isNot`, `takeWhile1`, `takeWhileMN`, `takeTill1`, ... |

## 4. Implementation phases

1. Tooling (pnpm, TypeScript, vitest), the core runtime (state, error record, `Parser` prototype with pipe and iterator), and runners.
2. General combinators (Parser module) and their tests, ported from winnow and nom test suites.
3. `Token` and `Ascii`, including partial (streaming) semantics.
4. `Binary` and `Bits`.
5. `ParseError` rendering, `Expression`, recovery, and trace.
6. Effect integrations: `parseEffect`, services, `ParserStream`, `ParserSchema`.
7. `Nom` aliases. Worked examples ported from winnow's topics (JSON, arithmetic, INI, HTTP, s-expressions) as tests. README.

## 5. Deliberate differences from nom and winnow

- **`eof` on partial input** returns `Incomplete`. More data might still arrive, so end of input can't be confirmed yet. `ParserStream` makes a final pass in complete mode, which settles it.
- **Error reporting** uses three heuristics that nom and winnow don't have: merging expectations in `alt`, _hints_ from parsers that stopped without failing, and _furthest failure_. The furthest heuristic may report a deeper failure from an abandoned branch instead of a shallower final one. It never overrides a failure that carries a user `cause` or message. A committed (`cut`) failure is reported where it happened, as winnow does for `cut_err`: only failures recorded inside the `cut` parser can outrank it, not ones from branches or lookaheads tried before the commit. Failures inside a lookahead that succeeded (`peek`, and `not` either way) never count, because they are about input the parser did not consume. Failures inside a successful `opt` or a repetition's last attempt do count; they are what makes the heuristic useful.
- **`resumeAfter` / `retryAfter`** run the recovery parser from the position where the failing parser _started_, not from where it failed.
- **`ParserStream.parseMany` error offsets** are relative to the buffer of input not yet consumed. That buffer is also the `input` of the `ParseError`.
- **The progress check** (a parser that succeeds without consuming input is rejected) applies only to unbounded repetitions. Bounded ones simply end.
- **Strings are parsed by code point.** A surrogate pair split across two partial chunks is reported as `Incomplete`. The same goes for a UTF-8 or UTF-16 sequence split across chunks of bytes parsed with `Text`.
- **Unicode text in any encoding** (`Text`, `Encoding`) has no equivalent in nom or winnow, whose character parsers are ASCII.

## 6. Compiled parsers

### Why

A `Parser` is a closure over the mutable `State`. A grammar runs as a tree of megamorphic closure calls that allocate intermediate values (tuples from `seq`, `Option`s from `opt`, `Failure` records on every backtrack). On the JSON example the combinators take ~37 ms for a 0.5 MB document, while the same grammar fused by hand into straight-line code takes ~4.7 ms. Turning off error bookkeeping only saves 0–7%, so the cost is the structure, not the diagnostics. Rust gets winnow the fused version through monomorphization and inlining; effect-parse has to do it itself.

The approach follows Effect 4's Schema compiler (`SchemaCompiler`, `internal/schema/compilerRegistry.ts`, `internal/schema/codegen.ts`, `SchemaJITCompiler`): parsers _describe_ themselves, a compiler turns descriptions into fast code with no diagnostics, the normal runners use it transparently, and the interpreter stays the reference implementation that produces every error.

### Descriptions

Every parser carries an internal description node next to its `step` (`src/internal/node.ts`; the field is not part of the public `Parser` interface). Nodes refer to their child _parsers_, so a child's own `step` is always available for fallback and recursion is just a reference.

| Node | Built by |
| --- | --- |
| `Succeed`, `Sync`, `Fail(mode)`, `Eof`, `Location` | `succeed`, `empty`, `Do`, `sync`, `fail`, `failAt`, `reject`, `failMessage`, `todo`, `eof`, `location` |
| `Any`, `Literal(caseless)`, `OneOf(set, negate)`, `Take`, `TakeWhile(set, negate, range)`, `TakeUntil(literal, range)`, `Rest`, `RestLen` | `Token`, `Ascii` classes, `Ascii.caseless`, and the same `Text` parsers |
| `Escaped(normal, control, escape, raw)` | `Ascii.escaped`/`takeEscaped`, `Text` `escaped`/`takeEscaped` |
| `TillLineEnding`, `Identifier`, `Bom` | `Ascii.tillLineEnding`, the `Text` parsers of the same names |
| `Map`, `As`, `Tap`, `TryMap`, `FilterMap`, `MapOrFail`, `Filter`, `FlatMap` | mapping and filtering combinators (`filterOrFail` is a `Filter`) |
| `Taken`, `WithTaken`, `Span`, `WithSpan`, `MapSpan` | consumed input (`mapSpan`) |
| `Mode(from, to)` | `cut`, `backtrack`, `complete` |
| `Context`, `Expected`, `Quiet`, `MapError`, `OrFail` | error management (they only touch diagnostics) |
| `Opt`, `OrElseSucceed`, `Peek`, `Not` | control |
| `Seq(parsers, output)`, `Struct`, `ZipWith`, `SeqWith` | `seq`, `preceded`, `terminated`, `delimited`, `separatedPair` (`output` picks the kept elements), `struct`, `zipWith`, `seqWith` |
| `Alt`, `Dispatch(selector, cases \| choose, otherwise)` | choice |
| `Repeat(range)`, `Fold(range)`, `RepeatTill`, `Separated`, `SeparatedFold(left \| right)` | repetition |
| `Suspend` | `suspend` (and `orElse`) |
| `Service`, `Provide`, `ResumeAfter`, `RetryAfter`, `Trace` | services, recovery, debugging |
| `FastPath(self, fast)` | `withFastPath`: compiled code calls `fast` and runs `self` when it returns `Defer`; the interpreter, the reference that builds every error, runs `self` alone |
| `Fixed(size, read)` | `Binary`'s fixed-size numbers: the JIT reads them inline on bytes |
| `Combinator(parsers, build)` | `Expression.make`, `permutation`, `Binary.lengthTake`: an algorithm the compilers don't know, whose step `build` makes from the steps of `parsers`, so compiled code passes it their compiled steps |
| `Opaque(step)` | `Parser.make`, `gen`, `mapParser` (its inner parser reads another input), `Bits` (bit offsets), the rest of `Binary`, anything else |

Token nodes have an `encoding` field: `undefined` for `Token`/`Ascii` (code points of a string with lenient surrogates, bytes, or array elements), or the `Encoding` of a `Text` parser. Token sets are stored as the user wrote them; the built-in `Ascii` predicates are annotated with their code point ranges so they compile to comparisons, as are `Token.codePoints` predicates given ranges.

Describing a grammar costs one small object per combinator call and nothing while parsing, so phase 1 changes no behaviour and no timings.

### Opt-in compilation: the `Compiler` module

```ts
export const json = Compiler.jit(Parser.preceded(ws, value))
Parser.parse(json, text) // compiled on first use, same Result as before
```

`Compiler.jit(p)` and `Compiler.closure(p)` register `p` in a `WeakMap`, with the backend that compiles it, and return `p` itself, so there is no new parser type and no new runner. The compiled code is built lazily on the first run, once per input kind (string, bytes, array), and cached. `parse`, `parseSync`, `parsePeek` and `parseEffect` look the parser up and use the compiled code when they can.

Compilation is opt-in, not automatic, because:

- **Callbacks may run twice.** When compiled code fails, the interpreter re-runs from the start to build the error (below), so user callbacks (`map`, `filter`, `tryMap`, `tap`, ...) on the path to the failure run again, and callbacks whose results are discarded may be skipped. Schema makes the same trade for its fast path. Pure callbacks can't tell, but a grammar whose callbacks have effects (a `tap` that logs, a `service` holding a symbol table) would change behaviour silently if compilation switched on by itself after N runs. Opting in at the grammar's definition makes it a visible, local decision.
- **Predictable cost.** Compiling costs time proportional to the grammar. A heuristic ("compile after N runs") makes timings depend on history and hides the cost in a random call; an explicit `compile` is easy to benchmark and reason about, and still free until the first run.
- **Content Security Policy.** The JIT probes for `new Function`, which a CSP reports as a violation even when the probe is caught. It should only happen when the user asked for compilation.
- **Ergonomics.** Grammars are module-level constants, so one `Compiler.jit(...)` around the root is all it takes. Sub-parsers need nothing.

`Compiler.jit` uses the JIT when `new Function` works, and otherwise the closure compiler. `Compiler.closure` never generates code, not even the probe, for CSP environments.

The two backends are separate functions, not an option of one function, so that bundles contain only the backends a program uses. `Parser` and the runners don't import any compiler: they look a parser up in the registry (`internal/compiler/registry.ts`), and the registry entry holds the backend that was passed in. A program that never compiles bundles neither backend. A program that uses only `Compiler.closure` bundles no `new Function`, which CSP and supply-chain scanners flag even when it never runs. The JIT imports the closure compiler, for its fallbacks.

### When the compiled code runs

The runners use compiled code whenever there is no tracer and recovery is off: `parse`, `parseSync`, `parsePeek` and `parseEffect` run the plain build, and `parsePartial`, `ParserStream.parseMany` and `ParserStream.parseAll` the resumable build (below), which handles partial input. `Parser.run` runs a parser on a `State` the caller owns, with the plain or resumable build depending on `state.partial`, and re-runs the step on failure; `parseMany` uses it with one state per buffer. `parseRecoverable`, `Syntax` parses and any run with the `trace` option stay interpreted. Every runner takes an `offset` and starts the `State` there, so a driver that reads one token at a time from a buffer (a lexer) runs compiled code without slicing the input: there is still no separate runner or parser type, and an option keeps the result types the ones callers already handle (`Done` reports where `parsePartial` stopped; `parsePeek`'s remaining input, where it did). Within those runners `Trace` is an identity, `ResumeAfter` is `map(Option.some)` and `RetryAfter` is an identity (recovery is inactive), so they compile for free. `Service` and `Provide` read and write `state.context` and fall back to their steps.

### Identical results and errors

Compiled code follows the step protocol without diagnostics: it returns a value, or `Fail` with only `state.mode` set (`Backtrack`, `Cut` or `Incomplete`, because `alt`, `opt`, `cut`, `complete`, ... branch on the mode). It allocates no `Failure`, hints, merged expectations or furthest failure.

On success (and, for `parse`, with the whole input consumed) the value is returned directly. On any failure the runner throws the attempt away and re-runs the interpreter on a fresh `State`. The `ParseError` (offset, expected, context, cause, message) is therefore the interpreter's, byte for byte. The interpreter is also the safety net: if compiled code wrongly failed, the re-run returns the right result. The real risk is compiled code succeeding where the interpreter fails, or with a different value; the differential test suite checks for it.

`Incomplete` is the exception. The compiled code reports it only where the interpreter does, and the failure it leaves is the interpreter's own: near the end of a partial input a token runs its interpreted step, and the few places where generated code reports `Incomplete` itself (`eof`, an `escaped` text that runs out) record the failure the interpreter would (`needed` 1 and 0). So `parsePartial` returns a compiled run's `Incomplete`, with its `needed`, without re-running anything. Before, a document that was complete but parsed as partial (ending in whitespace, which may continue) ran a second time interpreted: `parsePartial` on a 2.4 MB JSON document took 250 ms, and now takes 50 ms. The differential suite checks that every compiled `Incomplete` matches the interpreter's, `needed` included.

Documented consequence: user callbacks should be pure. On failing inputs they may run twice, callbacks whose result is unused (a `map` inside `taken` or `preceded`, a `fold` whose output is discarded) may be skipped, and token-set predicates may be cached per character.

### Pipeline

1. **Analysis** (`internal/compiler/analysis.ts`), like Schema's "facts": for a root and an input kind, walk the graph of nodes once (shared nodes and `Suspend` cycles are visited once). For each node record whether the backend supports it natively, a fallback reason when not, whether its output is used, how many parents reference it (shared and recursive nodes become functions), and its _first set_. A node budget (2048) stops the walk; nodes past it fall back to their steps.
2. **First sets.** For each node: the input units that can start a match, and a mode, `strict` (on any other unit, or at the end, the node fails with `Backtrack`), `optional` (it fails with `Backtrack` or succeeds without consuming) or `unknown`. `cut` makes a strict node unknown, `opt` makes it optional, `Seq` combines its prefix. An `Alt` whose branches are strict becomes a switch on the next unit that only tries the branches that can match it, in order. A `Dispatch` with a record of cases on `Token.any` or `peek(any)` becomes a switch on the unit, without building the key string. With any other selector, the JIT looks the chosen case up in a table of the record's parsers and switches on its index, so every case runs inline.
3. **Token sets** compile to comparisons for a few ranges and to a 256-entry table plus a fallback test otherwise. Predicates without known ranges are called, with a per-character cache for ASCII (string predicates receive a cached one-character string). The comparisons test the accepted runs or the rejected ones, whichever takes fewer comparisons (runs at either end of the table take one): the JSON string body is `c>31&&c!==34&&c!==92`, not three two-sided ranges. `Text` sets whose ranges stay below the table (or below the encoding's single-unit limit) don't call their test for the code points above it.
4. **Specialization** per input kind and encoding: strings use `charCodeAt`, bytes index the `Uint8Array`, `Text` parsers inline their encoding's single-unit fast path (below 0xD800 for strings, 0x80 for UTF-8, 0x100 for Latin-1) and call `decode` only for longer sequences. On array inputs the JIT calls a token set's predicate (or membership test) on `I[p]` inline for `any`, `oneOf`, `noneOf`, `takeWhile` and `takeTill`, with no failure record when it doesn't match; literals run their steps.
5. **Numbers.** `Ascii.float` and `Text.float` are recognized (the parsers they map with `toFloat` are registered in `internal/numbers.ts`). When the text starts like a decimal number, one pass matches it and computes its value from the input, without a slice: up to 15 significant digits and a decimal exponent up to 22, with Clinger's fast path (exact digits times or divided by an exact power of ten); up to 19 digits, in double-double arithmetic, keeping the result only when both ends of its error bound (2^-96, relative) round to it; anything else with `Number` on the text. The value is always `Number`'s. `nan`, `inf` and failures before a digit run the compiled parser.
6. **Objects.** `map(p, Object.fromEntries)` (which `Parser.fromEntries` is) builds its object directly when `p` is a `repeat` or `separated` of a pair (`separatedPair`, a two-element `seq`), possibly inside `cut`, diagnostics and the kept element of `preceded`, `terminated` or `delimited`: each entry is assigned as it is parsed, with no pairs and no array. `o[key] = value` creates the same property as `Object.fromEntries` when the key is a string that `Object.prototype` has no property for (no `__proto__` setter, no read-only property under a frozen prototype); other keys are defined with `Object.defineProperty`, and from the first object key on (whose conversion may run code) entries are deferred to the end, in order, as `Object.fromEntries` converts them after the whole list is parsed (`internal/entries.ts`). Streaming (resumable) builds do it too: where their checkpoints would hold the array, they hold the half-built object with its deferred entries, which is as sound, since a checkpoint that isn't `Done` is taken only once. That made a resumable parse of the JSON example built with `fromEntries` (`examples/json-fast.ts`, 2 MB of UTF-8) about 1.5× faster with the JIT (47 ms to 31 ms, against 27 ms for the ordinary build) and about 1.2× with the closure compiler (95 ms to 76–86 ms).
7. **Unused outputs** are skipped: `Taken`, `Peek`, `Not`, the dropped elements of `preceded`/`terminated`/`delimited`/`separatedPair`, `as`, `asVoid` and `opt` in void position compile without building their values. `Seq` and `Struct` build their results directly. A repetition of a character set whose values are unused scans its run in one loop (#79): `repeat(oneOf(S), range)` compiles as `takeWhile(S, range)`, which matches, stops and fails the same way, and `repeat(alt(oneOf(S), ...rest))` with `min` at most 1 and no `max` as `repeat(alt(takeWhile(S, { min: 1 }), ...rest))`, so that a name written as a repetition of a shared `alt(nameChar, escape)` no longer calls that alternative once per character (4.66 ms to 3.72 ms on the drivers benchmark's names, against 3.03 ms for the hand-written `takeWhile` form). The closure compiler makes the first rewrite too, where it saves a closure call per character: 2.2× on runs of 30–70 characters.

### Backends

**(a) Closure compiler** (`internal/compiler/closure.ts`). Builds one specialized closure per node, with the step signature, so `Opaque` nodes are simply their own steps and the cursor is `state.pos` throughout. It never generates code, so it works under a CSP. Closures made from one function literal share V8's type feedback, so a call inside a closure that sees different functions across the closures of its literal is not inlined; a test with six closures of one literal calling six different functions ran eight times slower than with one. The compiler therefore writes the hottest loop, `Text` `takeWhile`, once per kind of unit read (string, single bytes, UTF-16 bytes) rather than as one loop calling a reader: in a program that parses more than one input kind or encoding, the shared loop stopped inlining its reader, and the JSON benchmark (whose grammars share a process) ran about 17% slower. Per-grammar feedback is what the JIT adds: in the same mixed process its timings don't change, while the interpreter's and the closure compiler's rise with the number of grammars that share their literals.

**(b) JIT** (`internal/compiler/jit.ts`). Emits one JavaScript function per rule (the root, every `Suspend` target, and shared nodes) and inlines everything else as straight-line code with labelled blocks for failure. The cursor is a local `p`; a rule returns its value and leaves the new position in a register. The input and end are hoisted into locals. Callbacks, sets and steps are passed in a constants array. `Opaque` nodes store `p` in `state.pos`, call the step and reload it. The generated entry also sends a state whose end is not its input's length to the closure compiler, and catches a call-stack overflow and reports it as the `TooDeep` failure the runners' guard (`internal/stack.ts`) would, so the runners call it directly, without the guard; `Compiler.runner` also looks the compiled form up once rather than on every run. Generation is guarded: `new Function` is probed once, and if it or the generated code fails to build, the parser uses the closure compiler. The entry point saves and restores its registers, so a callback that runs another compiled parse is safe.

Byte encodings whose code units are wider than a byte (UTF-16LE/BE) get a _unit reader_: generated code reads `I[p] | I[p+1] << 8` inline and only calls `decode` for surrogates. Small parsers used in several places (`comma`, `sign`) are inlined rather than called.

**(c) AOT** (later, optional): the JIT's emitter can write the same source into a static module that registers the compiled function for a parser, as `SchemaAOTCompiler` does.

### Fallbacks

Anything the analysis can't compile runs its interpreted `step` on the same `State`, with `state.pos` kept in sync: `Opaque`, `FlatMap` continuations (the first parser is compiled; the parser returned by the function runs interpreted), `Dispatch` with a function of cases, `Service`, `Provide`, `Text` `caseless`, `identifier`, `bom` and `tillLineEnding` (leaf steps, so the fallback costs a call), and nodes past the budget. Partial input, recovery and tracing are handled by the runner as described above.

### Testing

A differential suite runs every example grammar, compiled with each backend and interpreted, on generated inputs (valid documents, random mutations, truncations, invalid bytes) and requires the same `Result`: equal values, or `ParseError`s with equal offset, mode, expected, context, cause and message.

### Results

JSON benchmark (`vp run bench`, 0.58 M-character document, best of 40 interleaved runs; timings on this machine vary by 5–10% between runs):

| Grammar and input                  | interpreted | closure        | JIT            |
| ---------------------------------- | ----------- | -------------- | -------------- |
| `json.ts` (Token/Ascii), string    | 40.9 ms     | 16.2 ms (2.5×) | 8.9 ms (4.6×)  |
| `json-text.ts`, `Text.string`      | 45.3 ms     | 16.9 ms (2.7×) | 8.2 ms (5.5×)  |
| `json-text.ts`, `Text.utf8`        | 51.8 ms     | 18.2 ms (2.8×) | 9.1 ms (5.7×)  |
| `json-text.ts`, `Text.utf16le`     | 60.2 ms     | 24.9 ms (2.4×) | 11.7 ms (5.2×) |
| `json-fast.ts`, `Text.string`      | 44.9 ms     | 13.0 ms (3.5×) | 5.3 ms (8.5×)  |
| `json-fast.ts`, `Text.utf8`        | 51.0 ms     | 14.7 ms (3.5×) | 5.9 ms (8.7×)  |
| hand-fused (`bench/json-fused.ts`) |             |                | 5.2 ms         |
| `JSON.parse`                       |             |                | 2.1 ms         |

Against `JSON.parse` on documents of different shapes (`vp run bench:native`; bytes are compared with `TextDecoder` then `JSON.parse`), the compiled parsers take:

| Document | `json.ts`, string | `Text.string` | `Text.utf8`, bytes | `json-fast.ts`, string | `json-fast.ts`, bytes |
| --- | --- | --- | --- | --- | --- |
| records, 1 KB | 3.9× | 3.7× | 2.6× | 2.3× | 1.6× |
| records, 600 KB, pretty-printed | 4.1× | 3.8× | 2.1× | 2.5× | 1.3× |
| records, 4 MB | 3.6× | 3.4× | 2.9× | 2.2× | 1.9× |
| numbers, 1 MB | 1.2× | 1.2× | 1.0× | 1.2× | 1.0× |
| ASCII strings, 1 MB | 2.8× | 2.9× | 2.4× | 2.9× | 2.4× |
| escaped strings, 1 MB | 6.3× | 6.2× | 3.0× | 4.6× | 2.6× |
| deep nesting, 100 KB | 2.4× | 2.3× | 2.0× | 1.3× | 1.3× |

Numbers come within 1.2× of `JSON.parse` because floats are converted without slicing (above); for numbers with more than 15 significant digits, `Number` is about as costly as the whole of `JSON.parse`'s work, so the double-double path matters there. Strings are scanned one character at a time, about 1.5 ns per character, where V8's scanner and `indexOf` run several times faster: replacing the string loop of the generated code by an `indexOf` for the closing quote (an upper bound, not a correct parser) runs the ASCII strings document at 1.1×. A correct version also has to find backslashes, control characters and, for predicates, non-Latin-1 characters; with cached searches it ran that document 1.8× faster, but documents of short strings 5–7% slower, so the compilers don't do it. On bytes, a `TextDecoder` call has a fixed cost of about 120 ns whatever the length (building strings by hand, eight bytes at a time, beats it up to about 40 bytes), which on that document was most of the difference from strings (5.0 ms against 3.1 ms). So `Text.utf8` decodes a long string that lies in a run of ASCII bytes by decoding the whole run once (up to 16 KiB past the string, and only when the run is at least four times the string), keeping its text on the `State`, and slicing the strings that follow from it: a byte offset in an ASCII run is a character offset. That made the document 26–28% faster (3.7 ms), and left documents whose long strings aren't ASCII unchanged within noise; a run that turns out not to be ASCII costs only the scan up to its first non-ASCII byte. The run lives on the state, not in a module-level cache, so it never outlives the parse or sees a buffer changed between parses; its strings are slices of the run's text, which they keep alive as slices of a string input keep the input. Records and nesting are dominated by the grammar's `Object.fromEntries` (below).

The JIT's remaining gap to the hand-fused parser was mostly the grammar itself: `object` collects `[key, value]` tuples and calls `Object.fromEntries` in a lambda, about 90 ns per entry (three times a loop of assignments) and a third of the profile on records. `json-fast.ts` builds objects with `Parser.fromEntries`, which compiles to assignments (pipeline step 6), and parses records at the speed of the hand-fused parser.

What runs interpreted in the JSON grammars: only the parser returned by the `flatMap` in `\uXXXX` escapes (its first parser, `hex4`, is compiled); `json-fast.ts` writes those escapes with `alt` and `cut` instead. Both compilers read UTF-16 bytes through a unit reader (a unit below 0xD800 is a whole code point, read inline; `decode` runs only for surrogates and a unit cut off by the end): before the closure compiler had one, it decoded every code point through `Encoding.decode` and ran UTF-16 at 1.4× over the interpreter (44 ms where it now takes 25 ms).

### The WebAssembly compiler

`Compiler.wasm` (`internal/compiler/wasm.ts`, with the assembler in `wasmAsm.ts`) is a third backend behind the same registry. It exists because recognition, not building values, dominates the JIT: on the JSON benchmark document the JIT takes about 2.5 ms to recognize the input (`asVoid`) and about 3.4 ms to parse it, while code generated as WebAssembly recognizes it in about 1 ms.

**Two passes.** A parse copies the input into linear memory, with standard `ArrayBuffer` views only, so the same code runs on every platform (a memory backed by a `SharedArrayBuffer` would take it as well), and runs the generated scan. Bytes are copied with `Uint8Array#set`. Strings are written as UTF-8 by `TextEncoder#encodeInto` to a staging area, then widened to their UTF-16 units in place by generated code, sixteen ASCII bytes at a time with SIMD where it validates (eight with 64-bit arithmetic otherwise): 0.37 ms for the 0.58 M-character benchmark document, almost all of it `encodeInto`, against 0.8 ms for a loop of `charCodeAt`. `encodeInto` writes a lone surrogate as U+FFFD, also one unit, so the widener lists the units that are U+FFFD and they are copied from the string itself: every unit is exact. (Node's `Buffer#write` copies UTF-16 units in 0.06 ms, but only in Node, and its type is `any` where other platforms' types are loaded.) Strings never change, so the latest string copied stays in memory: parsing it again, or from another offset, as a lexer does one token at a time, copies nothing. Bytes may change between parses, so each parse copies them again, from the cursor to the end, which is all the scan reads; when a parse comes back to the same buffer at a later offset with more than 4 KiB left, the pattern of a driver reading one token at a time, it runs the JIT instead, which copies nothing. The scan has the JIT's shape: a WebAssembly function per rule (`(p) -> p | -1`), everything else inlined as structured blocks, failure as a branch, the mode in a global. Where a value is used, it appends what the value needs to a _trace_ in linear memory: slice bounds, the index of the branch or case that matched, repetition counts (written back into a reserved word), flags of `opt`, doubles. Every point that rewinds the cursor rewinds the trace pointer with it, so the trace describes the successful parse only. A JavaScript function generated with `new Function` for the grammar then reads the trace in order and builds the value: the same callbacks, `Object.fromEntries` assignments (`internal/entries.ts`) and object shapes as the JIT, with no scanning. Builder functions mirror the scan's rules.

A first version replayed a generic event tape with an interpreter loop, and was 1.7 times slower than the JIT: per-node interpretation is what compilers remove. The builder is therefore specialized per grammar, and the trace holds only decisions and data, never the structure, which the builder knows.

**Islands.** Parsers with no WebAssembly form (`Parser.make`, `flatMap`, `dispatch` on a function, services, caseless `Text` literals, custom encodings) are _islands_: the scan calls an import that runs their JIT-compiled step on the shared state, and the trace records the index of their value. A callback that needs a value while scanning (`filter`, `tryMap`, `filterMap`, `tap`) is a _value island_: its parser is scanned natively, then an import builds just that value from its part of the trace, with a builder function of its own, and applies the callback; the trace of the parser is replaced by the index of the result. Calls between WebAssembly and JavaScript cost about 40 ns, so the hot parts of a grammar must not be islands: in the JSON grammars only escapes are.

**Tokens and numbers.** Token sets compile to comparisons (accepted or rejected runs, whichever are fewer) or to tables in linear memory, as in the JIT; a set's test is called only for code points it has no table or ranges for. The built-in encodings decode in WebAssembly (UTF-8 with the same validation as `decodeUtf8`, UTF-16 surrogates, lone surrogates). `Ascii.float` and `Text.float` are scanned and converted in one pass for every built-in encoding, UTF-16 included: up to 15 significant digits with Clinger's fast path, up to 19 with the double-double arithmetic of `numbers.ts` (WebAssembly has no fused multiply-add, so every operation rounds as in JavaScript, and the doubles are the same), the rest with `Number` in JavaScript. `nan` and `inf` run the float's text parser and `toFloat`.

**SIMD.** Where SIMD validates (a probe module, checked once), byte input is scanned sixteen bytes at a time. An unbounded `takeWhile` or `takeTill` on bytes (`Token`, Latin-1 text) tests a block against its rejected bytes with `i8x16.eq` when there are at most three of them (most `takeTill`s), or against nibble tables otherwise: bit `h` of `lo[b & 15]` says whether the byte with high nibble `h` is accepted, so two swizzles (one per half of the byte values) and an AND classify sixteen bytes. The first block that is not all accepted ends the run at its first rejected byte, without a scalar step; a block that is all accepted moves on to thirty-two bytes a step. The vector loop starts at once rather than after a few scalar steps: a counter or an unrolled head costs short runs (tokens) more than the vector step, which ends most of them in one block. UTF-8 and strings stay scalar: a UTF-8 byte from 0x80 up starts a code point that must be decoded and validated, and narrowing UTF-16 units to bytes takes two loads and a narrow per block, which on the JSON benchmark's short runs cost more than they saved (measured: `Text.string` 0.72 → 0.95 of the JIT's time). `Token.takeUntil` and `Token.takeUntilAny` on bytes are Teddy, as in ripgrep: the first three bytes of every literal tested at sixteen starts at once, with nibble tables whose bits are buckets of literals (literal `i` in bucket `i % 8`), or with `i8x16.eq` where each position has at most three distinct bytes; every candidate in a block is checked against the literals with the widest loads each fills. Literals are compared sixteen, eight, four, two and one bytes at a time (`v128`, `i64`, `i32` loads; a caseless letter ORed with 0x20). Where relaxed SIMD validates, the nibble lookups use `i8x16.relaxed_swizzle`, exact for indices below 16. On an 8.5 MB run, `takeTill` of one byte scans at about 6.9 GB/s with the copy into memory (1.6 GB/s scalar); erg, the ripgrep port in `examples/ripgrep`, finds several literals and counts matching lines with these scans.

**Strings.** Short string slices of `takeWhile` (and `escaped` strings of one piece) are hashed by the scan into a cache in linear memory of 1024 slots, each holding the units of the latest slice hashed to it and a version that changes with them. The trace records the slot and version; the builder decodes a string once per version and returns the same string for the same units after that. Repeated keys and short values cost no decoding, and are already internalized when they are used as property keys. Backtracking can't invalidate the cache, and it outlives a parse. On UTF-8 the scan also records whether a slice is ASCII, which the builder decodes without looking for longer sequences.

**Per parse**, the WebAssembly path costs about 0.3 µs, where the JIT costs about 0.1 µs (setting up the scan, the builder and the guard against re-entry): a driver whose every parse reads one short token is a little faster with the JIT.

**Where it runs.** Streaming (resumable) builds, array input, a callback that re-enters the same parser during a parse, and environments without `WebAssembly` or `new Function` use the JIT. A Content Security Policy needs both `'wasm-unsafe-eval'` and `'unsafe-eval'` for it. Modules are compiled synchronously, on the first parse; browsers limit the size of synchronous compiles on the main thread, which the JSON grammars (a few kilobytes) are far below.

**Testing.** The differential suites (`test/Compiler.test.ts`, `test/Streaming.test.ts`, `test/Syntax.test.ts`, `test/Regressions.test.ts`) run every grammar with the WebAssembly backend too, checking the compiled step alone as well as the results, and `test/Compiler.test.ts` adds its own cases: a trace that grows the memory, a callback that throws, the string cache, floats against `Number`, value islands, and the fallback without `WebAssembly`.

**Results.** JSON benchmark (`vp run bench`, which parses two copies of each input in turn, so that no compiler reuses the previous run's input):

| Grammar and input               | JIT     | WebAssembly    |
| ------------------------------- | ------- | -------------- |
| `json.ts` (Token/Ascii), string | 5.06 ms | 3.83 ms (1.3×) |
| `json-text.ts`, `Text.string`   | 4.97 ms | 3.53 ms (1.4×) |
| `json-text.ts`, `Text.utf8`     | 5.06 ms | 4.16 ms (1.2×) |
| `json-text.ts`, `Text.utf16le`  | 6.98 ms | 4.44 ms (1.6×) |
| `json-fast.ts`, `Text.string`   | 3.26 ms | 2.29 ms (1.4×) |
| `json-fast.ts`, `Text.utf8`     | 3.52 ms | 2.92 ms (1.2×) |

`json-fast.ts` on a string parses faster than the hand-fused parser (3.20 ms on the same run). On the documents of `vp run bench:native`, the JIT takes 1.15–1.7 times as long on records and 1.45–1.65 times as long on numbers (where the WebAssembly compiler is faster than `JSON.parse`); on long ASCII or escaped strings, where both spend their time building strings, 1.0–1.26 times; on deep nesting, where they spend it on the call stack, 0.93–1.22 times. Over its 35 cases the JIT takes 1.28 times as long (geometric mean).

**Compiling** costs more than the JIT: about 0.5 ms for a small grammar against 0.04 ms (code generation, encoding, and the engine's module and memory), once per parser and kind of input.

#### Against other JavaScript parser libraries

The same JSON documents (pretty-printed records, all non-ASCII text included), parsed by each library's JSON grammar written in its own idiom (its documented example where it has one), Node 22; each figure is the median over three processes of the best of 15–25 interleaved runs (within a process, libraries alternate order every round). Every output was checked against `JSON.parse`'s:

| Parser                                   | 1 KB            | 60 KB          | 600 KB         |
| ---------------------------------------- | --------------- | -------------- | -------------- |
| `JSON.parse`                             | 3.5 µs          | 0.17 ms        | 1.70 ms        |
| effect-parse `json-fast.ts`, JIT         | 8.6 µs (2.5×)   | 0.43 ms (2.5×) | 4.38 ms (2.6×) |
| effect-parse `json.ts`, JIT              | 13.3 µs (3.8×)  | 0.70 ms (4.1×) | 7.17 ms (4.2×) |
| Chevrotain 11 (lexer + embedded actions) | 30.6 µs (8.7×)  | 1.71 ms (10×)  | 22.2 ms (13×)  |
| effect-parse `json.ts`, interpreted      | 55.4 µs (16×)   | 2.93 ms (17×)  | 31.2 ms (18×)  |
| Peggy 4 (generated PEG parser)           | 66.5 µs (19×)   | 3.40 ms (20×)  | 37.3 ms (22×)  |
| Parsimmon 1.18                           | 163 µs (46×)    | 8.54 ms (50×)  | 88.6 ms (52×)  |
| Parjs 1.3                                | 182 µs (52×)    | 8.78 ms (51×)  | 109 ms (64×)   |
| Ohm 17                                   | 1.84 ms (526×)  | 138 ms (801×)  | 1.59 s (938×)  |
| Arcsecond 5                              | 7.12 ms (2034×) | —              | —              |

Compiled grammars run 3–5× faster than Chevrotain, the fastest of the others, and the interpreter is slightly faster than Peggy's generated code. Arcsecond is quadratic in the input: its `regex` parser slices the rest of the input on every call, and its character combinators did no better (15 s on the 60 KB document), so it is timed on the small document only.

#### Searching for a `takeTill`'s stop characters

`Token.takeTill` of one to three characters that are whole code points (`'"'`, `",\r\n"`), unbounded, on string input, accepts every other unit, so its run ends at the first stop character, and both compilers find it with `indexOf` (`internal/compiler/search.ts`, #75). Short runs are faster scanned: the first 8 units (16 for several stop characters) are tested one at a time, and a run that ends right after them is not searched. One stop character is searched for inline. Several are searched for through a cache on the `State`, by search site, of where each one next occurs: successive runs over one input then compare instead of searching, and a stop character that never occurs (`\r` in a file with `\n` line endings) is searched for once rather than to the end of the input on every run, which would be quadratic. The cache lives as long as the state, whose input never changes, and `reset` clears it. A `WeakRef` to the state, tried first, cost 20–30% on 8–16-character runs in `deref` alone. `Text` sets are not searched: a lone surrogate must stop a `Text` loop, and a search would skip it.

Fields of CSV-shaped input, 400 K characters (`bench/drivers.bench.ts`), JIT, best of three processes:

| run length | `takeTill('"')`, before |   after | `takeTill(",\r\n")`, before |   after |
| ---------: | ----------------------: | ------: | --------------------------: | ------: |
|          4 |                 2.51 ms | 2.36 ms |                     2.69 ms | 2.24 ms |
|         16 |                 1.10 ms | 1.03 ms |                     1.38 ms | 1.13 ms |
|         64 |                 0.88 ms | 0.27 ms |                     1.34 ms | 0.47 ms |
|        256 |                 0.72 ms | 0.08 ms |                     1.11 ms | 0.13 ms |

The closure compiler gains the same, from 2.06 to 0.50 ms on 64-character quoted fields and from 1.76 to 0.13 ms on 256-character ones.

#### Against CSV parsers

An RFC 4180 grammar as a user writes it (a quoted field of `takeTill('"')` runs and `""` escapes, an unquoted field `takeTill(",\n")`), JIT-compiled, against dedicated CSV parsers, each checked against d3-dsv's rows; about 2 MB each; the median over three processes of the best of 40 interleaved runs:

| Parser | short unquoted fields | all quoted, with commas and quotes | long text fields |
| --- | --- | --- | --- |
| uDSV 0.7 | 12.1 ms | 15.0 ms | 0.78 ms |
| effect-parse, quoted body as a `fold` | 18.1 ms | 18.8 ms | 1.59 ms |
| effect-parse, quoted body as `repeat` + `join` | 16.6 ms | 29.8 ms | 1.86 ms |
| d3-dsv 3 | 19.9 ms | 26.5 ms | 10.0 ms |
| Papa Parse 5 | 28.6 ms | 33.6 ms | 2.81 ms |
| csv-parse 5 (sync) | 108 ms | 74.2 ms | 50.1 ms |

The general-purpose grammar comes between uDSV, which is written for CSV alone, and the rest: ahead of d3-dsv on all three (narrowly on short fields), and ahead of Papa Parse and csv-parse throughout. Long fields gained the most from the stop-character search above: the same grammar took 9.5 ms before it. Building a quoted field's text with `fold` and string concatenation, rather than collecting its parts in an array and joining them, saves an array per field: 37% on the all-quoted document. On short unquoted fields the generated code runs as fast as a hand-written loop doing the same work (scan, slice, push, an array per row: 11–14 ms against 11–14 ms, best of 30 in one process), with uDSV at 9–10 ms in the same comparison: the remaining gap there is not in the scanning code the compilers generate.

#### Binary numbers

`Binary`'s fixed-size numbers read through a `DataView` of the input. Each read used to build a new view, which was most of a number's cost. Integers of up to 32 bits are now read from the bytes with shifts, which needs no view; floats and 64- and 128-bit integers read through a view kept on the `State` (`state.view`, created on first use; a state's input never changes). Reading from the bytes also matters where states are short-lived: `lengthAndThen` parses each record in a state of its own, and a view per record cost about a fifth of it. The numbers are also described to the compilers (a `Fixed` node: its size and its read function), so the JIT reads them inline on byte input, `if(E-p>=size){v=read(view,p);p+=size}`, and calls the step only at the end of the input, which reports the failure or `Incomplete` as the interpreter does; a fixed-size read never looks past its bytes, so streaming builds need no margin. The closure compiler uses the step, which is already what a closure would be. The WebAssembly scan checks the size and records the offset, and its builder reads the number with the same function; as an island (a call out of WebAssembly per number) it had been 3–12 times slower than the JIT, and now matches it (`repeat(beU32)`: 27.0 to 7.8 ms, a `fold` of `beU16`: 45.2 to 3.1 ms). On 500 K numbers (2 MB):

| Grammar                             | before, interpreted | before, JIT | after, interpreted | after, JIT |
| ----------------------------------- | ------------------: | ----------: | -----------------: | ---------: |
| `repeat(beU32)`                     |             47.1 ms |     38.8 ms |            15.0 ms |     8.3 ms |
| `repeat(leF64)`                     |             21.9 ms |     18.4 ms |             6.9 ms |     3.3 ms |
| `repeat(seq(u8, beU16, leU32, u8))` |              108 ms |     75.2 ms |            34.5 ms |     8.2 ms |
| `fold` of `beU16`, summed           |             80.5 ms |     61.1 ms |            17.5 ms |     3.6 ms |

A loop of `DataView.getUint32` calls pushing to an array takes 6.5–7.5 ms for the first, so the JIT now runs at about the speed of hand-written code there.

Length-prefixed data (`lengthTake`, `lengthRepeat`) built a parser for each length it read (`Token.take(n)`, `repeat(parser, n)`). They now keep the parsers of the first 256 lengths they see, which is the same parser for the same length, checkpoints included: on 2 MB of records of up to 23 bytes, `repeat(lengthTake(u8))` went from 30 to 18–22 ms and `lengthRepeat` from 64 to 53–55 ms.

`Bits` reads as many bits as the current byte holds at once (a shift and a mask), rather than one at a time: summing 16-bit fields over 1 MB went from 15.9 to 6.6 ms, 3-bit fields from 39 to 34 ms. A `repeat` of `bits(...)` that returns a tuple per byte is dominated by those tuples (more than half its time is garbage collection), not by reading.

#### Combinators the compilers don't know

`Expression.make` (the Pratt loop), `permutation` and `Binary.lengthTake` were opaque, so in a compiled grammar they ran interpreted and so did every parser inside them: the operand and operator parsers of an expression grammar, the whole of a permutation. They are now `Combinator` nodes: the parsers they run, and a `build` function that makes the step from those parsers' steps. The interpreter builds it from their own steps; the closure compiler (and the JIT, which delegates the node to it) from their compiled ones, so the algorithm is the same code in both and the parsers inside compile. `build` runs once per compilation, so state it shares between calls (the Pratt loop's last match and tied failures) is per build. `mapParser` and `Bits.bits` can't be built this way: their inner parsers run on another input (an output of the outer parser, or the bytes in bit units), which the code compiled for the outer input kind can't read. The same node is public as `Parser.combinator` (#83), with each step typed by its parser (`Parser.Steps<Ps>`), so a user's combinator can do what the library's do. On a 0.5 M-character arithmetic expression, compiling now halves the time (52 ms interpreted, 26–29 ms compiled, where compiling gained nothing before).

#### Merging expectations

Interpreted parses record, for errors, what could have been accepted where the parse stopped: a parser that stops without failing (`opt`, `repeat`, a whitespace skipper) sets a hint, and a failure at the hint's offset merges the hint's expectations into its own. On JSON that is one merge per value or so, almost all between the same few constant arrays (the skipper's hint, then the separator's), and each allocated a new array; a single-entry cache of the last merge never hit, because a hint merged at one offset is itself a new array each time. `mergeExpected` keeps its last four merges by the identity of their inputs instead: expectation arrays are never mutated, a merge seen before returns the same array, and the next merge then sees that array too, so on the JSON records document 4 of 40,000 merges were computed. Interpreted parses got 2–13% faster across the JSON benchmarks (34.2 to 31.1 ms with `Token`/`Ascii`); compiled code records no diagnostics and is unaffected.

#### Zero-copy output

Recognition, not building values, dominates a compiled parse, but the values are still a third of it, and all of its garbage. [`examples/json-tape.ts`](../examples/json-tape.ts) is `json-fast.ts` over UTF-8 bytes with every value-building step replaced by a callback that appends a 16-byte record to a _tape_: a block from [effect-ext](https://github.com/thomasfosterau/effect-ext)'s `Allocator`, described by two `Layout.struct`s (a node: `kind`, `next`, and the byte offsets of its text in the input; a number: `kind`, `next` and the `f64`). `next` is the index after the node's subtree, so a reader steps over what it does not want. A string without escapes is read as an effect-ext `Str` over a `subarray` of the input (`Text.utf8` has validated it, so `Str.fromUtf8Unsafe` is sound); only a string with escapes is decoded, on demand, by the grammar's own string parser. A record can be read as a `BufferStruct` view.

The grammar needs no new combinator. `Parser.asVoid` makes compiled code recognise a token without slicing it, `Parser.mapSpan` hands a callback the offsets, and `Parser.tap` makes compiled code call it although nothing uses its result, so the JIT compiles the whole grammar inline. A custom combinator (`Parser.combinator`, or `Parser.make`) is the wrong tool here: the JIT gives those to the closure compiler, with every parser inside them. Records are appended only on committed paths (after `dispatch`, inside `cut`), so nothing has to be undone; the interpreter and the three compilers write the same tape (`test/examples.test.ts`).

`vp run bench:zero-copy`, the 0.60 MB benchmark document as UTF-8 (54,001 values, a 0.86 MB tape), median of three processes of the best of 60 interleaved runs, each parse followed by a use of its result:

| Parse, then | tape, heap | tape, arena | `json-fast.ts`, JIT | `json-fast.ts`, WebAssembly | `TextDecoder` + `JSON.parse` |
| --- | --: | --: | --: | --: | --: |
| nothing | 2.47 ms | 2.44 ms | 4.74 ms | 3.91 ms | 3.44 ms |
| sum one number of each record | 2.58 ms | 2.62 ms | 4.83 ms | 3.98 ms | 3.48 ms |
| one string of each record, as text | 2.80 ms | 2.78 ms | 4.83 ms | 3.95 ms | 3.43 ms |
| one string of each record, as bytes | 2.64 ms | 2.62 ms | 5.79 ms | 4.78 ms | 4.08 ms |
| everything, as JavaScript values | 16.56 ms | 15.17 ms | 6.63 ms | 5.76 ms | 4.79 ms |
| collections in 200 parses | 0 | 0–1 | 34–56 | 34–55 | 14 |

Parsing to a tape takes about half the JIT's time on the same grammar and 0.7 of `JSON.parse`'s on bytes, and reading part of the document keeps that. It is the wrong representation for a consumer that wants every value: building them from the tape (an array of child indices per container, a `TextDecoder` call per string) costs three times what building them while parsing does. The tape's time is about what the JIT takes to recognise the document (about 2.5 ms, above), so the next gain is in the recognizer: the WebAssembly scan takes about 1 ms, but a callback out of WebAssembly costs about 40 ns and the tape makes one per value, so it runs on the JIT. A tape written by the WebAssembly scan itself would need the compiler to know the record layout.

An arena (one block for every parse) does not make a parse faster than the heap allocator does: the tape is one block either way, grown by doubling, and reused by the next parse. What it buys is that the tape is never garbage.

effect-ext's containers were not usable for the tape itself. `Vec.push` and `StructOfArrays.push` return an `Effect` per element: appending the document's 54,001 records takes 32 ms and 28 ms, and `StructOfArrays.extend` of an array of them 6.7 ms, against 0.33 ms through typed arrays over the block. `Vec.typedArray` and `StructOfArrays.column` view the elements already pushed, not the capacity, so they cannot be written ahead of the length either. A synchronous unchecked append (after a `reserve`), or a way to set the length over a reserved column, would let a parser fill them directly.

#### Measured and not adopted

- **Skipping ahead in long strings with a regular expression.** For a `takeWhile` over a string whose set accepts everything from 256 up to the surrogates (the JSON string body), testing 16 units one at a time and then jumping with a global regular expression to the next unit that may stop the loop made the `Text.string` JSON grammars 10–25% slower on records and no faster on 50-character strings: a regular expression call costs about as much as the loop over such a string, and the head loop slows every short string. What did pay is the narrower case of #75, below.
- **Assigning object keys without the `Object.prototype` check.** `isPlainKey` (`internal/entries.ts`) costs about 16 ns per key on fresh key strings, 13% of `json-fast.ts` on records; dropping it would make compiled objects differ from `Object.fromEntries`'s once `Object.prototype` gains a setter or is frozen, and JavaScript has no cheap signal that it changed, so it stays.
- **Slicing `Text.string` runs inline.** The JIT calls `Text.string`'s `text(input, start, end)`, which is `input.slice(start, end)`, through its constants. Emitting `I.slice` instead left the `Text.string` grammars within noise (about −1%) and made the `Text.utf8` grammar sharing the benchmark's process 7–14% slower in three rounds out of three, so it was reverted.
- **Joining an escaped string's pieces.** Escaped strings spend a quarter of their time in garbage collection, collecting the rope that `+=` builds per segment and escape. Collecting the pieces after the first in an array and joining them once made the escaped-strings document 18–37% slower: building the rope costs less than `join`, and flattening it later is the consumer's (a flat string only pays off if it is used).
- **`Match` instead of `switch` in step functions.** On `state.inputKind`, once per input position: 100.6 ms per million positions against 4.84 ms (the lint override for `prefer-match-over-switch` cites this).

## 7. Streaming a document as it arrives

`ParserStream.parseAll` (and `parseReadable` / `parseResponse` for web streams) parse one document from a stream of chunks without waiting for the end of the stream.

**Why it is possible.** In partial mode a parser only succeeds on what it has seen: any parser that would look past the end of the input reports `Incomplete` instead. So a value parsed from a prefix of the input is the value that a parse of the whole input would produce, and so is the state of a repetition after its first `n` elements.

**Checkpoints.** When a streaming attempt runs out of input, the failure unwinds the stack, but each repetition on the way (`repeat`, `fold`, `separated`, `separatedFoldl1`, `escaped`, `takeEscaped`) first records a checkpoint: its accumulator and where its next element starts, keyed by the repetition and the offset it was entered at (`internal/resume.ts`). The next attempt, with more input, parses from the root again, but each repetition it re-enters at the same offset resumes from its checkpoint. Re-parsing costs the path from the root to where the input ran out, not the whole prefix. A resumed repetition that completes leaves a `Done` checkpoint with its result, since the input may still run out after it, in trailing whitespace for example.

Taking a progress checkpoint removes it, so its accumulator has a single owner. A repetition entered at the same offset twice in one attempt (after backtracking) simply parses again.

**Scheduling.** An attempt re-reads the input from where the last one ran out; waiting until half as much input again has arrived keeps the total work linear. Byte buffers grow geometrically, so appending is linear too. The first attempt waits for a second chunk: an input that arrives in one chunk (most small response bodies) is then parsed once, as an ordinary compiled parse, rather than in partial mode and again in complete mode. A repetition that completes without resuming keeps no checkpoint, so a partial attempt whose only shortfall is at the very end (trailing whitespace) would otherwise be repeated in full: 147 ms instead of 60 ms for a 2 MB JSON document.

**Errors.** On failure, the whole input is buffered anyway; once the stream ends it is parsed again by the plain interpreter, so the `ParseError` is the one a one-shot parse gives.

**Compiled streaming.** Compiled parsers have a second, _resumable_ build:

- **Leaves.** A token parser that read within 4 units (the longest code point) of the end of a partial input re-runs interpreted. Elsewhere, partial and complete mode cannot disagree. Compiled token parsers leave the cursor where they stopped reading, even on failure, so the check is cheap. The one-pass float conversion records how far it read, and runs the float parser instead when that is within 4 units of the end.
- **End of input.** `eof`, escapes, and the first-unit switches of `alt` and `dispatch` check `state.partial` themselves, and skip no branch near the end of the input.
- **Loops.** Repetitions keep the same checkpoints as the interpreter, and so do escapes (`escaped`, `takeEscaped`): the JIT generates them in resumable builds too, rather than calling the closure compiler's, which made a resumable JSON parse about 13% faster (72 ms to 62 ms on a 2 MB document, against 60 ms for the ordinary build).

The differential suite checks resumable builds against the interpreter, in partial and complete mode, on every input, and streams every example in chunks of many sizes, interpreted and compiled.

## 8. Syntax trees

The `Syntax` module gives grammars a mode like [Tree-sitter](https://tree-sitter.github.io)'s: parse into a concrete syntax tree that can be searched by position and walked, and parse again after an edit, reusing what the edit didn't touch. nom and winnow have nothing like it; Tree-sitter is the model for the API (named and anonymous nodes, fields, `ERROR` nodes, `{ start, oldEnd, newEnd }` edits, cursors, S-expressions).

### Annotations, not a second grammar

`Syntax.node(p, kind)`, `Syntax.token(p, kind?)` and `Syntax.field(p, name)` mark a grammar's rules. Their description node is `Syntax`, which every compiler backend treats as an identity (like `Trace`), and their step only calls the inner step unless the state carries a tree builder (`state.syntax`). So one grammar serves `Parser.parse` (compiled or not) and `Syntax.parse`, and the marks cost one field check when interpreted. Tree-sitter's tokens, the leaves, are just nodes without children: the lexer is the grammar's token parsers.

### Green and red nodes

The tree is stored as _green_ nodes, as in Roslyn and rust-analyzer: kind, width, children with their offsets _relative_ to the parent, the value, and what incremental parsing needs (below). They know neither their absolute position nor their parent, so an unchanged subtree can be shared by the trees before and after an edit, at a different offset, without being copied or shifted. `SyntaxNode` is the _red_ view built while navigating: a green node, its absolute start, its parent and its index. Tree-sitter has the same split between subtrees and `TSNode`s.

### Building the tree while backtracking

Completed nodes wait on a stack until their parent completes and adopts them. The difficulty is that a PEG parser abandons attempts all the time (`alt`, `opt`, the last iteration of `repeat`, `peek`, `not`), and the nodes built by an abandoned attempt must not reach the tree. Every such combinator, and any well-behaved `Parser.make` parser, moves the cursor back to where the attempt started, or before, with `State.rewind`. Nodes are never empty (as in Tree-sitter, where rules can't match the empty string; an empty match just adds no node), so the nodes of an abandoned attempt are exactly those that end after the position the cursor moves back to, and the builder pops them when told of the rewind. Lookahead is handled too: `peek` rewinds after succeeding, which drops what it built.

The builder is a separate object (`state.syntax`), not a subclass of `State`. An earlier design made the syntax state a subclass whose `pos` was an accessor watching every move, with no combinator changes; but it gave every parser's step two state shapes to handle, one of them with an accessor, and in a program that also built trees, ordinary interpreted parses ran about 20% slower (59 ms against 49 ms on the JSON benchmark) and the syntax parse paid for the accessor on every move. With one state class and plain `pos`, `State` calls the builder on a rewind, a failure and a hint, behind a field check.

### Errors

Like Tree-sitter, a syntax parse always returns a tree. Recovery is always on: `resumeAfter` and `retryAfter` call `state.syntax.skipped`, which wraps the skipped input (and any nodes the recovery parser built) in an `ERROR` node holding the failure. A fatal failure, or input left at the end, becomes an `ERROR` node up to the end of the input. `tree.errors` is collected from the `ERROR` nodes, so the errors of abandoned attempts are dropped with their nodes, and reused nodes keep theirs.

### Incremental reparsing

`Syntax.reparse(tree, input, edits)` maps the new input to the old one as _segments_: stretches copied unchanged, built by applying the edits in order. When `Syntax.node` is entered at a position, the builder looks for a node of the old tree built by the same `Syntax.node` (a per-call key, not the kind) at the corresponding old position: a binary search down the old tree, starting from the parent of the previous match, since reused nodes are mostly consecutive siblings. The node is reused, its value and all, when the input its parse looked at lies in one segment, or it looked up to the end and the segment is a common suffix of both inputs.

This is incremental packrat parsing (Dubroy and Warth, _Incremental Packrat Parsing_, 2017) restricted to the annotated rules: PEG parsing is a function of the position, so a rule entered at a position whose input is unchanged gives the same result. It requires the rule's result to depend only on the input from where it starts, which is why values should not depend on services, closure state or absolute offsets.

**What a parse looked at.** For every node the builder records a _lookahead_: the furthest position looked at while the node was parsed, including failed alternatives inside it. Three things raise it: the cursor (where it is when it rewinds, and where it is when the node ends, since it only moves forward in between), failures (`failWith`) and hints (`setHint`). Most token parsers read only at positions they reach or fail at, plus one token where they stop (a code point: two units of a string at a high surrogate, up to four bytes, one array element); the reuse check adds that token. The few that read further report how far they read through `state.syntax.read`: a literal that fails part way (`matchLiteral`, `Text` `caseless`), `takeUntil`, which reads its delimiter without consuming it, and `tillLineEnding`, which reads the `\n` after a `\r`. The calls are on failure paths or behind an optional field check, so ordinary parses don't pay for them. Custom parsers that read further than one token past where they stop can widen the margin with the `lookahead` option.

An earlier version used a fixed margin instead: the grammar's longest literal, found by walking its descriptions, with a floor of 32 units for grammars containing parts the walk can't see (`gen`, `make`, `flatMap`). It was not reliable, since `gen` grammars hide their literals, and it made nodes up to 32 units before an edit unusable. Recording reads made reuse both exact and cheaper.

**Equal to a fresh parse.** A reparse returns the tree, values and errors that `Syntax.parse` of the new input returns. Values are shared, not recomputed. For errors to match too, each node stores what its parse left for error reporting (its furthest failure and its last hint, see "Error model"), and a reused node replays it. Otherwise a fatal error after a reused node could be reported at a different offset, or with fewer expected alternatives. The differential tests check that equality on random edits of random JSON documents, of expression grammars (including `Expression.make`), and of a grammar built on lookahead (keyword boundaries, comments, literals sharing a prefix); a targeted test covers each parser that reports a read, and fails if its report is removed.

**Cost.** A reparse runs the parsers on the path from the root to the edit, and every repetition on that path steps over each reused child (a lookup and a stack push, about 1 µs). On a 0.58 M-character JSON document whose top-level array has 2000 records, building the tree takes about twice as long as an interpreted parse of the value (80 ms against 40 ms), and a one-character edit reparses in about 2 ms. About a third of that (0.6 ms) is not the reparse: `Syntax.replace` builds the new text by concatenation, and V8 flattens that 0.58 M-character string the first time it is read, which any consumer of the new text pays; the rest is about 0.35 µs per reused node (4016 of them here). Tree-sitter goes further by storing repetitions as balanced trees, so it can reuse runs of siblings in one step. The same could be done here by having `repeat` and `separated` look up a run of consecutive old children, which is left for later.

## 9. Parsers from schemas

`ParserSchema.toParser(schema)` derives a parser from an Effect `Schema`, and `ParserSchema.toPrinter(schema)` the printer of the same text, the way `Schema.toEquivalence` and `Schema.toFormatter` derive their instances: a walk over the schema's AST that checks a node's annotation first, then falls back on the node's tag. A format whose values already have a schema can then be declared once, in the schema, rather than twice (or three times, counting the printer).

### Annotations

The annotation holds a parser for the node, or a `Grammar`: `parser`, `print`, `prefix`, `suffix`, `separator`, `keySeparator` and `whitespace`. Its key, `ParserSchema.annotationKey`, is `"@thomasfosterau/effect-parse/ParserSchema"`: annotations share one namespace across every library that augments them, and a key like `parser` would collide. A symbol would collide less, but two copies of the package in one program would each have their own, and neither would see the other's annotations; a namespaced string has neither problem. The key is typed by augmenting `Schema.Annotations.Annotations`, Effect's documented extension point, so `schema.annotate({ [ParserSchema.annotationKey]: ... })` type-checks; `ParserSchema.annotate` also checks the parser's output type against the schema's type. As with Effect's own annotations, an annotation on a schema with checks lives on its last check (`Schema.Int.annotate(...)` annotates the `isInt` filter), so the lookup searches from the last check back to the node, and a later `.check(...)` doesn't hide an earlier annotation.

A grammar describes only the text the node itself writes. Everything the derivation needs from its surroundings travels down in a context instead: the characters that end an unannotated string (the separators and suffixes around it, and the next literal in a template literal) and whether whitespace is allowed. So a field of type `Schema.String` needs no annotation in `a=1;b=x`.

### Type side, decoded

The derived parser returns the schema's _type_, with its checks and transformations applied, rather than its encoded form decoded afterwards. Decoding afterwards would be simpler, but annotations are written on the type side (`Schema.Int.annotate(...)`, a `Class`), and `SchemaAST.toEncoded` drops them on every node with a transformation. So:

- A node without a transformation is parsed structurally, then its checks run (as `Schema.Unknown.check(...checks)`, so only the node's own filters run, not its children's again).
- A node with a transformation parses its encoded side (the last link's `to`) into that side's type, then decodes with a copy of the node whose last link starts from that type (rebuilt with `SchemaAST.decodeTo`, which is public; `replaceEncoding` is internal). Each transformation therefore runs once, on its own node. A grammar's `separator` and `keySeparator` on a transformation apply to its encoded side, since that is where a `Class`'s fields are.
- A parser from an annotation replaces the derivation, and its output is decoded with the node's type schema, so a hand-written parser can't produce a value of the wrong type.

Schema failures become parse failures whose `cause` is the `SchemaError`, so `E` is `SchemaError` for every derived parser; the causes of annotated parsers are converted to one, keeping their message.

### Text rules

Sequences (structs, tuples, arrays) put the separator between the items _present_: an optional field that is missing takes its separator with it. That is built as one parser per position and "separator needed" flag (`2n` parsers, memoised), where an optional item is `alt(present, skipped)`, which is ordered choice: an optional field is tried before it is skipped. Unions are ordered choice too, except that a union of plain literals is tried longest first, as an `Enum`'s values are, because `Literals(["<", "<="])` should not be order-sensitive in a way its type isn't.

A record, or a struct with a `keySeparator`, is entries in any order. A required field that is missing fails as a _syntax_ error where another entry could have been (`expected "port="`), not as a schema issue at the start: a failure with a cause is never outranked by the furthest-failure rule, so a schema issue would hide the real error when a malformed entry ended the repetition early (`port=x` would be reported as "missing key port"). Committing (`cut`) once a known key is read would also report the malformed entry, but would stop a union of keyed structs trying its next member.

Integers: `Ascii.float` would read `1.2` whole in a `major.minor` struct, so a number schema whose checks restrict it to integers (any filter whose arbitrary constraint is `number: "integer"`, as `isInt` and those built on it have) reads a decimal integer instead.

A check's `expected` annotation (`"an integer"`) describes the check, not the text, so only a node's `identifier` and its own `expected` label it in errors.

### Printing

The printer walks the AST with the same context as the parser (the shared `resolve`, `withStop`, `itemContext` and `linkTarget`), so the two agree on where a string ends and what a transformation's encoded side is. It validates the value against the schema's type once, at the top, then writes: a transformation encodes through the same rebuilt chain of links the parser decodes through, structs leave out a missing optional field with its separator, keyed structs write their fields in declared order and then the record's other keys, and a union writes with the first member the value belongs to that can write it.

A printer is only useful if its text reads back, so it refuses what would not: an unannotated string that is empty, contains one of its stop characters, or (in whitespace mode) has whitespace around it. This found a parser bug while it was written: in whitespace mode, a string's leading whitespace was only skipped when a separator before it allowed whitespace, so a struct's first field kept it; now the string parser skips it itself. A part with an annotated `parser` but no `print` fails when printed rather than when derived, so a schema whose printer is never used still derives a parser.

That leaves ambiguous grammars: `{ a?: Int, b: Int, c?: Int }` with `,` prints `{ b: 2, c: 3 }` as `2,3`, which parses as `{ a: 2, b: 3 }` because an optional field is tried before it is skipped. Detecting ambiguity in general means comparing languages, which isn't decidable for these grammars, so `fromSchema`, whose encode must be the inverse of its decode, checks the case at hand instead: it parses the printed text back and compares it with the value using the schema's equivalence, and fails when they differ. `toPrinter` leaves the check out, as it costs a parse per value.

### Compiled

The derivation builds parsers only from public combinators, whose descriptions the compilers read, so derived parsers compile. The differential suite (`test/Compiler.test.ts`) runs one over mutated inputs. Recursion goes through `Parser.suspend`; deriving a recursive schema again in the same context returns the same `suspend` parser, which ends the derivation.
