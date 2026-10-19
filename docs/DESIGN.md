# effect-parse design

This document records the research behind effect-parse and the plan used to
build it. effect-parse is a port of two Rust parser-combinator libraries,
[nom](https://github.com/rust-bakery/nom) (8.x) and
[winnow](https://github.com/winnow-rs/winnow) (0.7.x), to TypeScript, written
in the style of [Effect](https://effect.website) 4.

## 1. What the source libraries look like

### nom 8

- A parser is anything implementing `Parser<I>`, with
  `process(input) -> IResult<I, O, E>`. Input goes in by value and comes back
  as the remaining input, so `IResult<I, O, E> = Result<(I, O), Err<E>>`.
- `Err<E>` has three modes: `Error` (recoverable, so `alt` tries the next
  branch), `Failure` (unrecoverable, produced by `cut`), and
  `Incomplete(Needed)` (streaming input ran out).
- Modules come in pairs, `bytes::{complete, streaming}` and
  `character::{complete, streaming}`. The streaming variants return
  `Incomplete` at end of input.
- Error types are pluggable through the `ParseError<I>` trait (`error::Error`
  holds `(input, ErrorKind)`, and `VerboseError` holds a context stack).
- Naming: `tag`, `char`, `many0`/`many1`, `separated_list0`, `map_res`,
  `recognize`, `consumed`, `value`, `pair`, `tuple`, `count`, and so on.

### winnow 0.7

winnow forked from nom and changed a few things that matter here:

- `Parser<I, O, E>::parse_next(&mut I) -> Result<O, E>`. The input is a
  **mutable cursor** that parsers advance, and alternatives rewind it with
  `checkpoint`/`reset`. Plain functions/closures are parsers.
- `ErrMode<E>` = `Backtrack | Cut | Incomplete(Needed)`.
- Instead of separate streaming modules, the *input type* says whether it is
  streaming: `Partial<I>`. One set of parsers handles both cases.
- Stream wrappers add features: `LocatingSlice` (spans), `Stateful<I, S>`
  (user state), `Recoverable` (error recovery), `Bytes`, `BStr`, and
  `TokenSlice` (parsing a lexer's tokens).
- `ContextError` collects `StrContext::{Label, Expected}` context and an
  optional external `cause`. `ParseError` renders the input with a caret.
- Parser methods: `map`, `try_map`, `verify_map`, `verify`, `value`,
  `default_value`, `void`, `take` (recognize), `with_taken`, `span`,
  `with_span`, `flat_map`, `and_then`, `parse_to`, `context`,
  `complete_err`, `retry_after`, `resume_after`.
- Combinators: `alt`, `dispatch!`, `permutation`, `seq!`, `preceded`,
  `terminated`, `delimited`, `separated_pair`, `repeat(range, p)`,
  `repeat_till`, `separated`, `separated_foldl1/foldr1`, `fold`, `opt`,
  `cond`, `peek`, `not`, `eof`, `cut_err`, `backtrack_err`, `empty`, `fail`,
  `trace`.
- Modules: `token` (`any`, `literal`, `one_of`, `none_of`, `take`,
  `take_while(range, set)`, `take_till`, `take_until`, `rest`), `ascii`
  (character classes, `dec_int`, `dec_uint`, `hex_uint`, `float`, escaping,
  `Caseless`), and `binary` (endian numbers, `length_*`, `bits`).
- `repeat` and `separated` treat a parser that succeeds without consuming
  input as a bug, and fail with an assertion error instead of looping
  forever.

### What Effect 4 brings

- Pipeable data types with **dual** APIs: `Parser.map(p, f)` and
  `p.pipe(Parser.map(f))` both work.
- Generator syntax (`Effect.gen`), where `yield*` unwraps values.
- Typed error channels, `Data.TaggedError` (errors that can be yielded
  inside `Effect.gen`), `Option`, and `Result`.
- `Context` services and requirements (`R`).
- `Stream` for incremental input, and `Schema` for decoding.

## 2. Synthesis: decisions

| Topic | nom | winnow | effect-parse |
|---|---|---|---|
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

`Input = string | Uint8Array | ReadonlyArray<unknown>`. These map to winnow's
`&str`, `&[u8]`, and `TokenSlice<T>`:

| Input | Token | Slice |
|---|---|---|
| `string` | `string` (one Unicode code point) | `string` |
| `Uint8Array` | `number` (byte) | `Uint8Array` (a `subarray` view, no copy) |
| `ReadonlyArray<T>` | `T` | `ReadonlyArray<T>` |

Offsets are UTF-16 code-unit indices for strings, byte indices for
`Uint8Array`, and element indices for arrays.

**Binary data** (`ArrayBuffer`, `SharedArrayBuffer`, `DataView`, other
typed arrays) is a *source*, not another input kind. The runners,
`ParserStream` and the `State` constructor accept it wherever the parser
reads a `Uint8Array` (`Input.Source<I>`), and view it as a `Uint8Array` of
the same memory. A separate `ArrayBuffer` input kind would add nothing:
indexing an `ArrayBuffer` needs a view anyway, and slicing one copies. With
a view, slices stay zero-copy `subarray`s and every byte parser works
unchanged. A view of a resizable buffer is given a fixed length, so the
input can't change size during a parse. Typed arrays with wider elements are
viewed in platform byte order: a `Uint16Array` of UTF-16 code units is
UTF-16LE on all common platforms. `TextDecoder` is never given a view of a
`SharedArrayBuffer` directly (some browsers reject it); such slices are
copied first.

When a token parser could work on several input kinds, it takes a type
parameter that defaults to `string`, much like Rust's turbofish:
`Token.take<Uint8Array>(4)`. When the input kind can be inferred from an
argument (`Token.literal(new Uint8Array([1]))`), it is. The `Binary` module
is typed for bytes only.

### Text and encodings

nom and winnow parse `&str` and `&[u8]`, and their character parsers are
ASCII. effect-parse adds a `Text` module for Unicode text in any encoding.

**One implementation, many encodings.** An `Encoding` is a small record:
`decode(input, offset, end)` returns a code point, *malformed* (-1) or
*truncated* (-2), and there are also `width`, `encode` and `text` (slice to
string). `Text.make(encoding)` builds every text parser from one generic
implementation, and returns a `TextParsers<I>` record. Grammars written
against that record parse JavaScript strings, UTF-8, UTF-16LE/BE and
Latin-1 unchanged, and users can add encodings. The parsers are a record of
values rather than functions with an encoding argument, so they are built
once per encoding and the encoding never appears in a hot loop's call
signature.

**Why not parse bytes everywhere?** An obvious design would be to encode
strings to UTF-8 with `TextEncoder` and parse only bytes. We measured it on
V8 with a 0.5 MB document:

| Operation | Time |
|---|---|
| `TextEncoder.encode` of the whole document | 0.9 ms |
| scanning digits, string (`charCodeAt`) | 1.25 ms |
| scanning digits, bytes | 0.53 ms |
| 37k slices with `String.prototype.slice` | 0.7 ms |
| 37k slices with `TextDecoder.decode(subarray)` | 5.0 ms |
| 37k slices built with `String.fromCharCode` | 2.9 ms |

Scanning bytes is faster, but text parsers mostly *produce strings*, and
building a string from bytes costs 4–7 times more than slicing a string. It
would also turn string offsets into byte offsets, which would break spans,
error columns and `Parser.location`. So strings are parsed natively, as
UTF-16 code units, and only byte inputs are decoded. Short slices of bytes
are built by hand (that beats `TextDecoder`'s fixed cost below about 24
bytes), and longer ones use `TextDecoder`. With the JSON grammar (best of
interleaved runs), `Text.string` was 5–15% slower than the hand-written
`Token`/`Ascii` parser, and `Text.utf8` on bytes was within about 10% of
`TextDecoder` followed by `Text.string`. The generic scan loop, which calls
through the encoding and predicate, accounts for most of the difference.

**Fast paths.** The scan loop skips `decode` for units that are known to be
single-unit code points: below 0xD800 for strings, below 0x80 for UTF-8 and
0x100 for Latin-1. Unicode predicates (`Text.isLetter`, built on regular
expression property escapes) cache their answers for the BMP in a lazily
allocated table. They are marked as *code-point predicates*, so `Token` and
`Text` call them with numbers instead of allocating a string per character.
This also applies to the `Ascii` predicates.

**Strictness.** Text parsers never match malformed input: invalid UTF-8,
overlong forms, surrogates encoded in UTF-8, and unpaired UTF-16
surrogates. On partial input, a sequence cut off at the end reports
`Incomplete`, so byte streams can be parsed as text chunk by chunk. `Token`
keeps its lenient handling of lone surrogates in strings.

**Errors.** `Text` parsers on byte input record their encoding on the
`State`, and the runners copy it to `ParseError.encoding`. The error message
then decodes the line (replacing malformed bytes with U+FFFD) and reports
the line and column in code points, plus the byte offset.

### Error model

Internally a failure stores a small error record on the parse state, then
returns a unique `Fail` sentinel. Successful steps allocate nothing for
errors.

```
mode:     Backtrack | Cut | Incomplete
offset:   where it failed
kind:     ErrorKind (nom-style: "Literal", "Digit", "Verify", "Eof", ...)
expected: ReadonlyArray<string>   (rendered alternatives: `"abc"`, `digit`, ...)
context:  ReadonlyArray<string>   (labels from Parser.context, innermost first)
cause:    E | undefined           (user error)
needed:   number | undefined      (Incomplete)
```

`alt` merges branch errors with the *furthest failure wins* rule. When
branches fail at the same offset, their `expected` sets are combined. That
gives messages like `expected one of "true", "false", "null"` without any
annotation, which is better than both nom and winnow out of the box (each
keeps only one branch's error).

`Parser.expected(desc)` replaces the expected set when a parser fails without
consuming input (Parsec's `<?>`). `Parser.context(label)` adds a context
label (winnow `StrContext::Label`, nom `context`).

The public `ParseError<E>` extends `Data.TaggedError("ParseError")`. It can
be yielded in `Effect.gen`, and its `message` renders like this:

```
Parse error at line 1, column 3:
1 | [1,,2]
  |    ^
expected value
```

## 3. Module plan

| Module | Contents |
|---|---|
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
| `ParserStream` | Run a parser repeatedly over an Effect `Stream` of chunks (partial parsing) |
| `ParserSchema` | Build an Effect `Schema` that decodes a string with a parser |
| `Syntax` | Concrete syntax trees and incremental reparsing, after Tree-sitter (section 8) |
| `Nom` | nom-named aliases: `tag`, `tagNoCase`, `char`, `many0`, `many1`, `manyMN`, `manyTill`, `count`, `separatedList0/1`, `foldMany0/1`, `mapRes`, `mapOpt`, `recognize`, `consumed`, `value`, `pair`, `tuple`, `isA`, `isNot`, `takeWhile1`, `takeWhileMN`, `takeTill1`, ... |

## 4. Implementation phases

1. Tooling (pnpm, TypeScript, vitest), the core runtime (state, error
   record, `Parser` prototype with pipe and iterator), and runners.
2. General combinators (Parser module) and their tests, ported from winnow
   and nom test suites.
3. `Token` and `Ascii`, including partial (streaming) semantics.
4. `Binary` and `Bits`.
5. `ParseError` rendering, `Expression`, recovery, and trace.
6. Effect integrations: `parseEffect`, services, `ParserStream`,
   `ParserSchema`.
7. `Nom` aliases. Worked examples ported from winnow's topics (JSON,
   arithmetic, INI, HTTP, s-expressions) as tests. README.

## 5. Deliberate differences from nom and winnow

- **`eof` on partial input** returns `Incomplete`. More data might still
  arrive, so end of input can't be confirmed yet. `ParserStream` makes a
  final pass in complete mode, which settles it.
- **Error reporting** uses three heuristics that nom and winnow don't have:
  merging expectations in `alt`, *hints* from parsers that stopped without
  failing, and *furthest failure*. The furthest heuristic may report a
  deeper failure from an abandoned branch instead of a shallower final one.
  It never overrides a failure that carries a user `cause` or message.
- **`resumeAfter` / `retryAfter`** run the recovery parser from the position
  where the failing parser *started*, not from where it failed.
- **`ParserStream.parseMany` error offsets** are relative to the buffer of
  input not yet consumed. That buffer is also the `input` of the
  `ParseError`.
- **The progress check** (a parser that succeeds without consuming input is
  rejected) applies only to unbounded repetitions. Bounded ones simply end.
- **Strings are parsed by code point.** A surrogate pair split across two
  partial chunks is reported as `Incomplete`. The same goes for a UTF-8 or
  UTF-16 sequence split across chunks of bytes parsed with `Text`.
- **Unicode text in any encoding** (`Text`, `Encoding`) has no equivalent
  in nom or winnow, whose character parsers are ASCII.

## 6. Compiled parsers

### Why

A `Parser` is a closure over the mutable `State`. A grammar runs as a tree
of megamorphic closure calls that allocate intermediate values (tuples from
`seq`, `Option`s from `opt`, `Failure` records on every backtrack). On the
JSON example the combinators take ~37 ms for a 0.5 MB document, while the
same grammar fused by hand into straight-line code takes ~4.7 ms. Turning
off error bookkeeping only saves 0–7%, so the cost is the structure, not the
diagnostics. Rust gets winnow the fused version through monomorphization and
inlining; effect-parse has to do it itself.

The approach follows Effect 4's Schema compiler (`SchemaCompiler`,
`internal/schema/compilerRegistry.ts`, `internal/schema/codegen.ts`,
`SchemaJITCompiler`): parsers *describe* themselves, a compiler turns
descriptions into fast code with no diagnostics, the normal runners use it
transparently, and the interpreter stays the reference implementation that
produces every error.

### Descriptions

Every parser carries an internal description node next to its `step`
(`src/internal/node.ts`; the field is not part of the public `Parser`
interface). Nodes refer to their child *parsers*, so a child's own `step`
is always available for fallback and recursion is just a reference.

| Node | Built by |
|---|---|
| `Succeed`, `Sync`, `Fail(mode)`, `Eof`, `Location` | `succeed`, `empty`, `Do`, `sync`, `fail`, `reject`, `failMessage`, `todo`, `eof`, `location` |
| `Any`, `Literal(caseless)`, `OneOf(set, negate)`, `Take`, `TakeWhile(set, negate, range)`, `TakeUntil(literal, range)`, `Rest`, `RestLen` | `Token`, `Ascii` classes, `Ascii.caseless`, and the same `Text` parsers |
| `Escaped(normal, control, escape, raw)` | `Ascii.escaped`/`takeEscaped`, `Text` `escaped`/`takeEscaped` |
| `TillLineEnding`, `Identifier`, `Bom` | `Ascii.tillLineEnding`, the `Text` parsers of the same names |
| `Map`, `As`, `Tap`, `TryMap`, `FilterMap`, `Filter`, `FlatMap` | mapping and filtering combinators (`filterOrFail` is a `Filter`) |
| `Taken`, `WithTaken`, `Span`, `WithSpan` | consumed input |
| `Mode(from, to)` | `cut`, `backtrack`, `complete` |
| `Context`, `Expected`, `MapError`, `OrFail` | error management (they only touch diagnostics) |
| `Opt`, `OrElseSucceed`, `Peek`, `Not` | control |
| `Seq(parsers, output)`, `Struct`, `ZipWith` | `seq`, `preceded`, `terminated`, `delimited`, `separatedPair` (`output` picks the kept elements), `struct`, `zipWith` |
| `Alt`, `Dispatch(selector, cases \| choose, otherwise)` | choice |
| `Repeat(range)`, `Fold(range)`, `RepeatTill`, `Separated`, `SeparatedFold(left \| right)` | repetition |
| `Suspend` | `suspend` (and `orElse`) |
| `Service`, `Provide`, `ResumeAfter`, `RetryAfter`, `Trace` | services, recovery, debugging |
| `Opaque(step)` | `Parser.make`, `gen`, `mapParser`, `permutation`, `Binary`, `Bits`, `Expression`, anything else |

Token nodes have an `encoding` field: `undefined` for `Token`/`Ascii`
(code points of a string with lenient surrogates, bytes, or array
elements), or the `Encoding` of a `Text` parser. Token sets are stored as
the user wrote them; the built-in `Ascii` predicates are annotated with
their code point ranges so they compile to comparisons.

Describing a grammar costs one small object per combinator call and nothing
while parsing, so phase 1 changes no behaviour and no timings.

### Opt-in compilation: `Parser.compile`

```ts
export const json = Parser.compile(Parser.preceded(ws, value))
Parser.parse(json, text) // compiled on first use, same Result as before
```

`Parser.compile(p, options?)` registers `p` in a `WeakMap` and returns `p`
itself, so there is no new parser type and no new runner. The compiled code
is built lazily on the first run, once per input kind (string, bytes,
array), and cached. `parse`, `parseSync`, `parsePeek` and `parseEffect` look
the parser up and use the compiled code when they can.

Compilation is opt-in, not automatic, because:

- **Callbacks may run twice.** When compiled code fails, the interpreter
  re-runs from the start to build the error (below), so user callbacks
  (`map`, `filter`, `tryMap`, `tap`, ...) on the path to the failure run
  again, and callbacks whose results are discarded may be skipped. Schema
  makes the same trade for its fast path. Pure callbacks can't tell, but a
  grammar whose callbacks have effects (a `tap` that logs, a `service`
  holding a symbol table) would change behaviour silently if compilation
  switched on by itself after N runs. Opting in at the grammar's
  definition makes it a visible, local decision.
- **Predictable cost.** Compiling costs time proportional to the grammar.
  A heuristic ("compile after N runs") makes timings depend on history and
  hides the cost in a random call; an explicit `compile` is easy to
  benchmark and reason about, and still free until the first run.
- **Content Security Policy.** The JIT probes for `new Function`, which a
  CSP reports as a violation even when the probe is caught. It should only
  happen when the user asked for compilation.
- **Ergonomics.** Grammars are module-level constants, so one
  `Parser.compile(...)` around the root is all it takes. Sub-parsers need
  nothing.

`options.backend` is `"auto"` (the default: the JIT when `new Function`
works, otherwise the closure compiler) or `"closure"` (never generates code,
not even the probe, for CSP environments). A separate `"jit"` choice would
add nothing: it too has to fall back when `new Function` is blocked.

### When the compiled code runs

The runners use compiled code only for complete input without a tracer:
`parse`, `parseSync`, `parsePeek`, `parseEffect`. `parsePartial`,
`ParserStream`, `parseRecoverable` and any run with the `trace` option stay
interpreted. Within those runners `Trace` is an identity, `ResumeAfter` is
`map(Option.some)` and `RetryAfter` is an identity (recovery is inactive),
so they compile for free. `Service` and `Provide` read and write
`state.context` and fall back to their steps.

### Identical results and errors

Compiled code follows the step protocol without diagnostics: it returns a
value, or `Fail` with only `state.mode` set (`Backtrack`, `Cut` or
`Incomplete`, because `alt`, `opt`, `cut`, `complete`, ... branch on the
mode). It allocates no `Failure`, hints, merged expectations or furthest
failure.

On success (and, for `parse`, with the whole input consumed) the value is
returned directly. On any failure the runner throws the attempt away and
re-runs the interpreter on a fresh `State`. The `ParseError` (offset,
expected, context, cause, message) is therefore the interpreter's, byte for
byte. The interpreter is also the safety net: if compiled code wrongly
failed, the re-run returns the right result. The real risk is compiled code
succeeding where the interpreter fails, or with a different value; the
differential test suite checks for it.

Documented consequence: user callbacks should be pure. On failing inputs
they may run twice, callbacks whose result is unused (a `map` inside
`taken` or `preceded`, a `fold` whose output is discarded) may be skipped,
and token-set predicates may be cached per character.

### Pipeline

1. **Analysis** (`internal/compiler/analysis.ts`), like Schema's "facts":
   for a root and an input kind, walk the graph of nodes once (shared nodes
   and `Suspend` cycles are visited once). For each node record whether the
   backend supports it natively, a fallback reason when not, whether its
   output is used, how many parents reference it (shared and recursive nodes
   become functions), and its *first set*. A node budget (2048) stops the
   walk; nodes past it fall back to their steps.
2. **First sets.** For each node: the input units that can start a match,
   and a mode, `strict` (on any other unit, or at the end, the node fails
   with `Backtrack`), `optional` (it fails with `Backtrack` or succeeds
   without consuming) or `unknown`. `cut` makes a strict node unknown, `opt`
   makes it optional, `Seq` combines its prefix. An `Alt` whose branches are
   strict becomes a switch on the next unit that only tries the branches
   that can match it, in order. A `Dispatch` with a record of cases on
   `Token.any` or `peek(any)` becomes a switch on the unit, without building
   the key string.
3. **Token sets** compile to comparisons for a few ranges and to a 256-entry
   table plus a fallback test otherwise. Predicates without known ranges are
   called, with a per-character cache for ASCII (string predicates receive a
   cached one-character string). The comparisons test the accepted runs or
   the rejected ones, whichever takes fewer comparisons (runs at either end
   of the table take one): the JSON string body is `c>31&&c!==34&&c!==92`,
   not three two-sided ranges. `Text` sets whose ranges stay below the table
   (or below the encoding's single-unit limit) don't call their test for the
   code points above it.
4. **Specialization** per input kind and encoding: strings use
   `charCodeAt`, bytes index the `Uint8Array`, `Text` parsers inline their
   encoding's single-unit fast path (below 0xD800 for strings, 0x80 for
   UTF-8, 0x100 for Latin-1) and call `decode` only for longer sequences.
   Array inputs keep the combinator structure but run token parsers through
   their steps.
5. **Numbers.** `Ascii.float` and `Text.float` are recognized (the parsers
   they map with `toFloat` are registered in `internal/numbers.ts`). When
   the text starts like a decimal number, one pass matches it and computes
   its value from the input, without a slice: up to 15 significant digits
   and a decimal exponent up to 22, with Clinger's fast path (exact digits
   times or divided by an exact power of ten); up to 19 digits, in
   double-double arithmetic, keeping the result only when both ends of its
   error bound (2^-96, relative) round to it; anything else with `Number`
   on the text. The value is always `Number`'s. `nan`, `inf` and failures
   before a digit run the compiled parser.
6. **Objects.** `map(p, Object.fromEntries)` (which `Parser.fromEntries`
   is) builds its object directly when `p` is a `repeat` or `separated` of
   a pair (`separatedPair`, a two-element `seq`), possibly inside `cut`,
   diagnostics and the kept element of `preceded`, `terminated` or
   `delimited`: each entry is assigned as it is parsed, with no pairs and
   no array. `o[key] = value` creates the same property as
   `Object.fromEntries` when the key is a string that `Object.prototype`
   has no property for (no `__proto__` setter, no read-only property under
   a frozen prototype); other keys are defined with
   `Object.defineProperty`, and from the first object key on (whose
   conversion may run code) entries are deferred to the end, in order, as
   `Object.fromEntries` converts them after the whole list is parsed
   (`internal/entries.ts`). Streaming (resumable) builds keep the array,
   which their checkpoints hold.
7. **Unused outputs** are skipped: `Taken`, `Peek`, `Not`, the dropped
   elements of `preceded`/`terminated`/`delimited`/`separatedPair`, `as`,
   `asVoid` and `opt` in void position compile without building their
   values. `Seq` and `Struct` build their results directly.

### Backends

**(a) Closure compiler** (`internal/compiler/closure.ts`). Builds one
specialized closure per node, with the step signature, so `Opaque` nodes
are simply their own steps and the cursor is `state.pos` throughout. It
never generates code, so it works under a CSP.

**(b) JIT** (`internal/compiler/jit.ts`). Emits one JavaScript function per
rule (the root, every `Suspend` target, and shared nodes) and inlines
everything else as straight-line code with labelled blocks for failure.
The cursor is a local `p`; a rule returns its value and leaves the new
position in a register. The input and end are hoisted into locals.
Callbacks, sets and steps are passed in a constants array. `Opaque` nodes
store `p` in `state.pos`, call the step and reload it. Generation is
guarded: `new Function` is probed once, and if it or the generated code
fails to build, the parser uses the closure compiler. The entry point saves
and restores its registers, so a callback that runs another compiled parse
is safe.

Byte encodings whose code units are wider than a byte (UTF-16LE/BE) get a
*unit reader*: generated code reads `I[p] | I[p+1] << 8` inline and only
calls `decode` for surrogates. Small parsers used in several places
(`comma`, `sign`) are inlined rather than called.

**(c) AOT** (later, optional): the JIT's emitter can write the same source
into a static module that registers the compiled function for a parser,
as `SchemaAOTCompiler` does.

### Fallbacks

Anything the analysis can't compile runs its interpreted `step` on the same
`State`, with `state.pos` kept in sync: `Opaque`, `FlatMap` continuations
(the first parser is compiled; the parser returned by the function runs
interpreted), `Dispatch` with a function of cases, `Service`, `Provide`,
`Text` `caseless`, `identifier`, `bom` and `tillLineEnding` (leaf steps,
so the fallback costs a call), and nodes past the budget. Partial input,
recovery and tracing are handled by the runner as described above.

### Testing

A differential suite runs every example grammar, compiled with each
backend and interpreted, on generated inputs (valid documents, random
mutations, truncations, invalid bytes) and requires the same `Result`:
equal values, or `ParseError`s with equal offset, mode, expected, context,
cause and message.

### Results

JSON benchmark (`pnpm build && pnpm bench`, 0.58 M-character document, best
of 40 interleaved runs; timings on this machine vary by 5–10% between
runs):

| Grammar and input | interpreted | closure | JIT |
|---|---|---|---|
| `json.ts` (Token/Ascii), string | 39.7 ms | 14.9 ms (2.7×) | 7.7 ms (5.1×) |
| `json-text.ts`, `Text.string` | 42.0 ms | 18.6 ms (2.3×) | 7.4 ms (5.7×) |
| `json-text.ts`, `Text.utf8` | 46.8 ms | 19.2 ms (2.4×) | 7.7 ms (6.1×) |
| `json-text.ts`, `Text.utf16le` | 54.9 ms | 40.2 ms (1.4×) | 9.7 ms (5.6×) |
| `json-fast.ts`, `Text.string` | 43.3 ms | 14.6 ms (3.0×) | 4.9 ms (8.8×) |
| `json-fast.ts`, `Text.utf8` | 47.4 ms | 16.4 ms (2.9×) | 5.3 ms (8.9×) |
| hand-fused (`bench/json-fused.ts`) | | | 4.6 ms |
| `JSON.parse` | | | 1.9 ms |

Against `JSON.parse` on documents of different shapes (`pnpm bench:native`;
bytes are compared with `TextDecoder` then `JSON.parse`), the compiled
parsers take:

| Document | `json.ts`, string | `Text.string` | `Text.utf8`, bytes | `json-fast.ts`, string | `json-fast.ts`, bytes |
|---|---|---|---|---|---|
| records, 1 KB | 4.0× | 3.7× | 2.9× | 2.4× | 1.9× |
| records, 600 KB, pretty-printed | 4.1× | 4.0× | 2.2× | 2.7× | 1.5× |
| records, 4 MB | 3.9× | 3.9× | 3.3× | 2.7× | 1.8× |
| numbers, 1 MB | 1.2× | 1.2× | 1.0× | 1.2× | 1.0× |
| ASCII strings, 1 MB | 2.9× | 3.1× | 3.1× | 3.0× | 3.1× |
| escaped strings, 1 MB | 4.8× | 5.7× | 4.1× | 4.2× | 4.1× |
| deep nesting, 100 KB | 2.1× | 2.2× | 1.8× | 1.4× | 1.2× |

Numbers come within 1.2× of `JSON.parse` because floats are converted
without slicing (above); for numbers with more than 15 significant digits,
`Number` is about as costly as the whole of `JSON.parse`'s work, so the
double-double path matters there. Strings are scanned one character at a
time, about 1.5 ns per character, where V8's scanner and `indexOf` run
several times faster: replacing the string loop of the generated code by
an `indexOf` for the closing quote (an upper bound, not a correct parser)
runs the ASCII strings document at 1.1×. A correct version also has to
find backslashes, control characters and, for predicates, non-Latin-1
characters; with cached searches it ran that document 1.8× faster, but
documents of short strings 5–7% slower, so the compilers don't do it. On
bytes, every string longer than 24 bytes costs a `TextDecoder` call, which
has a fixed cost of about 100 ns. Records and nesting are dominated by the grammar's
`Object.fromEntries` (below).

The JIT's remaining gap to the hand-fused parser was mostly the grammar
itself: `object` collects `[key, value]` tuples and calls
`Object.fromEntries` in a lambda, about 90 ns per entry (three times a
loop of assignments) and a third of the profile on records.
`json-fast.ts` builds objects with `Parser.fromEntries`, which compiles to
assignments (pipeline step 6), and parses records at the speed of the
hand-fused parser.

What runs interpreted in the JSON grammars: only the parser returned by the
`flatMap` in `\uXXXX` escapes (its first parser, `hex4`, is compiled);
`json-fast.ts` writes those escapes with `alt` and `cut` instead. The
closure compiler leaves UTF-16 at 1.4× because it decodes every code
point through `Encoding.decode`; the JIT's unit reader removes that.

## 7. Streaming a document as it arrives

`ParserStream.parseAll` (and `parseReadable` / `parseResponse` for web
streams) parse one document from a stream of chunks without waiting for the
end of the stream.

**Why it is possible.** In partial mode a parser only succeeds on what it has
seen: any parser that would look past the end of the input reports
`Incomplete` instead. So a value parsed from a prefix of the input is the
value that a parse of the whole input would produce, and so is the state of
a repetition after its first `n` elements.

**Checkpoints.** When a streaming attempt runs out of input, the failure
unwinds the stack, but each repetition on the way (`repeat`, `fold`,
`separated`, `separatedFoldl1`, `escaped`, `takeEscaped`) first records a
checkpoint: its accumulator and where its next element starts, keyed by the
repetition and the offset it was entered at (`internal/resume.ts`). The next
attempt, with more input, parses from the root again, but each repetition it
re-enters at the same offset resumes from its checkpoint. Re-parsing costs
the path from the root to where the input ran out, not the whole prefix. A
resumed repetition that completes leaves a `Done` checkpoint with its
result, since the input may still run out after it, in trailing whitespace
for example.

Taking a progress checkpoint removes it, so its accumulator has a single
owner. A repetition entered at the same offset twice in one attempt (after
backtracking) simply parses again.

**Scheduling.** An attempt re-reads the input from where the last one ran
out; waiting until half as much input again has arrived keeps the total work
linear. Byte buffers grow geometrically, so appending is linear too.

**Errors.** On failure, the whole input is buffered anyway; once the stream
ends it is parsed again by the plain interpreter, so the `ParseError` is the
one a one-shot parse gives.

**Compiled streaming.** Compiled parsers have a second, *resumable* build:

- **Leaves.** A token parser that read within 4 units (the longest code
  point) of the end of a partial input re-runs interpreted. Elsewhere,
  partial and complete mode cannot disagree. Compiled token parsers leave the
  cursor where they stopped reading, even on failure, so the check is cheap.
  The one-pass float conversion records how far it read, and runs the
  float parser instead when that is within 4 units of the end.
- **End of input.** `eof`, escapes, and the first-unit switches of `alt` and
  `dispatch` check `state.partial` themselves, and skip no branch near the
  end of the input.
- **Loops.** Repetitions keep the same checkpoints as the interpreter.

The differential suite checks resumable builds against the interpreter, in
partial and complete mode, on every input, and streams every example in
chunks of many sizes, interpreted and compiled.

## 8. Syntax trees

The `Syntax` module gives grammars a mode like
[Tree-sitter](https://tree-sitter.github.io)'s: parse into a concrete syntax
tree that can be searched by position and walked, and parse again after an
edit, reusing what the edit didn't touch. nom and winnow have nothing like
it; Tree-sitter is the model for the API (named and anonymous nodes, fields,
`ERROR` nodes, `{ start, oldEnd, newEnd }` edits, cursors, S-expressions).

### Annotations, not a second grammar

`Syntax.node(p, kind)`, `Syntax.token(p, kind?)` and `Syntax.field(p, name)`
mark a grammar's rules. Their description node is `Syntax`, which every
compiler backend treats as an identity (like `Trace`), and their step only
calls the inner step unless the state carries a tree builder
(`state.syntax`). So one grammar serves `Parser.parse` (compiled or not)
and `Syntax.parse`, and the marks cost one field check when interpreted.
Tree-sitter's tokens, the leaves, are just nodes without children: the
lexer is the grammar's token parsers.

### Green and red nodes

The tree is stored as *green* nodes, as in Roslyn and rust-analyzer: kind,
width, children with their offsets *relative* to the parent, the value,
and what incremental parsing needs (below). They know neither their
absolute position nor their parent, so an unchanged subtree can be shared
by the trees before and after an edit, at a different offset, without being
copied or shifted. `SyntaxNode` is the *red* view built while navigating:
a green node, its absolute start, its parent and its index. Tree-sitter has
the same split between subtrees and `TSNode`s.

### Building the tree while backtracking

Completed nodes wait on a stack until their parent completes and adopts
them. The difficulty is that a PEG parser abandons attempts all the time
(`alt`, `opt`, the last iteration of `repeat`, `peek`, `not`), and the
nodes built by an abandoned attempt must not reach the tree. Every such
combinator, and any well-behaved `Parser.make` parser, moves the cursor
back to where the attempt started, or before. Nodes are never empty (as in
Tree-sitter, where rules can't match the empty string; an empty match just
adds no node), so the nodes of an abandoned attempt are exactly those that
end after the position the cursor moves back to. The syntax state makes
`pos` an accessor whose setter pops them. No combinator had to change, and
lookahead is handled too: `peek` moves the cursor back after succeeding,
which drops what it built.

`State.pos` became a declared field so that the subclass's accessor isn't
shadowed by an own property; for ordinary states nothing changes (the
benchmarks are unchanged within their noise).

### Errors

Like Tree-sitter, a syntax parse always returns a tree. Recovery is always
on: `resumeAfter` and `retryAfter` call `state.syntax.skipped`, which wraps
the skipped input (and any nodes the recovery parser built) in an `ERROR`
node holding the failure. A fatal failure, or input left at the end,
becomes an `ERROR` node up to the end of the input. `tree.errors` is
collected from the `ERROR` nodes, so the errors of abandoned attempts are
dropped with their nodes, and reused nodes keep theirs.

### Incremental reparsing

`Syntax.reparse(tree, input, edits)` maps the new input to the old one as
*segments*: stretches copied unchanged, built by applying the edits in
order. When `Syntax.node` is entered at a position, the builder looks for
a node of the old tree built by the same `Syntax.node` (a per-call key,
not the kind) at the corresponding old position: a binary search down the
old tree, starting from the parent of the previous match, since reused
nodes are mostly consecutive siblings. The node is reused, its value and
all, when the input its parse looked at lies in one segment, or it looked
up to the end and the segment is a common suffix of both inputs.

This is incremental packrat parsing (Dubroy and Warth, *Incremental
Packrat Parsing*, 2017) restricted to the annotated rules: PEG parsing is a
function of the position, so a rule entered at a position whose input is
unchanged gives the same result. It requires the rule's result to depend
only on the input from where it starts, which is why values should not
depend on services, closure state or absolute offsets.

**What a parse looked at.** For every node the builder records a
*lookahead*: the furthest position looked at while the node was parsed,
including failed alternatives inside it. Three things raise it: moves of
the cursor (the `pos` setter), failures (`failWith`) and hints
(`setHint`). Most token parsers read only at positions they reach or fail
at, plus one token where they stop (a code point: two units of a string at
a high surrogate, up to four bytes, one array element); the reuse check
adds that token. The few that read further report how far they read
through `state.syntax.read`: a literal that fails part way
(`matchLiteral`, `Text` `caseless`), `takeUntil`, which reads its
delimiter without consuming it, and `tillLineEnding`, which reads the
`\n` after a `\r`. The calls are on failure paths or behind an optional
field check, so ordinary parses don't pay for them. Custom parsers that
read further than one token past where they stop can widen the margin
with the `lookahead` option.

An earlier version used a fixed margin instead: the grammar's longest
literal, found by walking its descriptions, with a floor of 32 units for
grammars containing parts the walk can't see (`gen`, `make`, `flatMap`).
It was not reliable, since `gen` grammars hide their literals, and it made
nodes up to 32 units before an edit unusable. Recording reads made reuse
both exact and cheaper.

**Equal to a fresh parse.** A reparse returns the tree, values and errors
that `Syntax.parse` of the new input returns. Values are shared, not
recomputed. For errors to match too, each node stores what its parse left
for error reporting (its furthest failure and its last hint, see "Error
model"), and a reused node replays it. Otherwise a fatal error after a
reused node could be reported at a different offset, or with fewer
expected alternatives. The differential tests check that equality on
random edits of random JSON documents, of expression grammars (including
`Expression.make`), and of a grammar built on lookahead (keyword
boundaries, comments, literals sharing a prefix); a targeted test covers
each parser that reports a read, and fails if its report is removed.

**Cost.** A reparse runs the parsers on the path from the root to the
edit, and every repetition on that path steps over each reused child (a
lookup and a stack push, about 1 µs). On a 0.58 M-character JSON document
whose top-level array has 2000 records, building the tree takes about
twice as long as an interpreted parse of the value (80 ms against 40 ms),
and a one-character edit reparses in about 2 ms. Tree-sitter goes further
by storing repetitions as balanced trees, so it can reuse runs of siblings
in one step. The same could be done here by having `repeat` and
`separated` look up a run of consecutive old children, which is left for
later.

