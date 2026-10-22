# effect-parse

Parser combinators for [Effect](https://effect.website), ported from Rust's [nom](https://github.com/rust-bakery/nom) and [winnow](https://github.com/winnow-rs/winnow).

effect-parse keeps the core model of nom and winnow: small parsers composed into larger ones; `Backtrack` / `Cut` / `Incomplete` error modes; one set of parsers for both complete and streaming input; text, bytes, bits and token streams. On top of that it follows Effect's conventions:

- pipeable, dual (data-first or data-last) combinators
- generator syntax with `Parser.gen`
- typed user errors in the `E` channel, and `ParseError` as a `Data.TaggedError`
- dependency injection with `Context` services in the `R` channel
- `Option`, `Result`, `Effect`, `Stream` and `Schema` integration

```ts
import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"

const point = Parser.gen(function* () {
  yield* Token.literal("(")
  const x = yield* Ascii.decInt
  yield* Token.literal(",")
  const y = yield* Ascii.decInt
  yield* Token.literal(")")
  return { x, y }
})

Parser.parse(point, "(1,-2)")
// Result.succeed({ x: 1, y: -2 })

Parser.parse(point, "(1;-2)")
// Result.fail(ParseError):
//   Parse error at line 1, column 3:
//   1 | (1;-2)
//     |   ^
//   expected digit or ",", found ";"
```

## Installation

```sh
pnpm add @thomasfosterau/effect-parse effect
```

effect-parse requires `effect` 4.x (`^4.0.0`) as a peer dependency; the consuming application owns the single copy of `effect`.

Every module is available from the root entry as a namespace, and also on its own subpath (`@thomasfosterau/effect-parse/Parser`, `…/Ascii`, and so on).

The package was developed as `effect-nom`. Releases and the changelog are managed with Changesets; see [PUBLISHING.md](PUBLISHING.md).

## Contents

- [The `Parser` type](#the-parser-type)
- [Writing parsers](#writing-parsers)
- [Running parsers](#running-parsers)
- [Compiled parsers](#compiled-parsers)
- [Errors](#errors)
- [Streaming and partial input](#streaming-and-partial-input)
- [Services](#services)
- [Parsers from schemas](#parsers-from-schemas)
- [Unicode text and encodings](#unicode-text-and-encodings)
- [Syntax trees and incremental parsing](#syntax-trees-and-incremental-parsing)
- [Modules](#modules)
- [Coming from nom or winnow](#coming-from-nom-or-winnow)
- [Examples](#examples)
- [Design](#design)

## The `Parser` type

```ts
interface Parser<A, E = never, R = never, I extends Input = string>
```

| Parameter | Meaning                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `A`       | the value produced                                                       |
| `E`       | the type of user errors (see [Errors](#errors)); `never` for pure syntax |
| `R`       | the services required (see [Services](#services))                        |
| `I`       | the input: `string` (the default), `Uint8Array`, or `ReadonlyArray<T>`   |

Like winnow, a parser is a function over a mutable cursor. Failing is cheap, and backtracking means resetting an offset. String tokens are Unicode code points, `Uint8Array` tokens are bytes, and array tokens are elements, which is useful for parsing the output of a lexer.

## Writing parsers

There are three styles, and they mix freely.

**Combinators**, data-first or piped:

```ts
import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"

const keyValue = Parser.separatedPair(
  Ascii.alpha1,
  Parser.delimited(Ascii.space0, Token.literal("="), Ascii.space0),
  Ascii.decInt
)

const list = Parser.separated(Ascii.decInt, Token.literal(",")).pipe(
  Parser.map((ns) => ns.reduce((a, b) => a + b, 0)),
  Parser.context("list")
)
```

**Generators**, like `Effect.gen`:

```ts
const header = Parser.gen(function* () {
  const name = yield* Token.takeWhile(Ascii.isAlphanumeric, { min: 1 })
  yield* Token.literal(": ")
  const value = yield* Ascii.tillLineEnding
  yield* Ascii.lineEnding
  return { name, value }
})
```

The generator body runs on every parse, so parsers created inside it, like `Token.literal(": ")` above, are rebuilt on every run. That is fine for most grammars, but on a hot path (a tokenizer, or a `gen` inside a `repeat`) build them once, outside the body, and `yield*` those:

```ts
const colon = Token.literal(": ")
const name = Token.takeWhile(Ascii.isAlphanumeric, { min: 1 })

const header = Parser.gen(function* () {
  const n = yield* name
  yield* colon
  const value = yield* Ascii.tillLineEnding
  yield* Ascii.lineEnding
  return { name: n, value }
})
```

**Records, tuples and Do notation**:

```ts
const version = Parser.struct({
  major: Ascii.decUint,
  minor: Parser.preceded(Token.literal("."), Ascii.decUint)
})

const range = Parser.Do.pipe(
  Parser.bind("start", () => Ascii.decUint),
  Parser.zipLeft(Token.literal("..")),
  Parser.bind("end", () => Ascii.decUint)
)
```

Recursive grammars use `Parser.suspend`:

```ts
type Tree = ReadonlyArray<Tree>
const tree: Parser.Parser<Tree> = Parser.delimited(
  Token.literal("["),
  Parser.separated(
    Parser.suspend(() => tree),
    Token.literal(",")
  ),
  Token.literal("]")
)
```

Each level of nesting uses some of the JavaScript call stack, so input nested a few thousand levels deep exhausts it. The runners catch the overflow and fail with a `ParseError` of kind `"TooDeep"` at the offset reached, so untrusted input can't make them throw. Grammars that must accept deeper nesting need a non-recursive formulation.

Low-level parsers can be written directly against the cursor with `Parser.make`, in the same way that any function can be a parser in winnow:

```ts
const upper = Parser.make<string>((state) => {
  const c = state.input.charCodeAt(state.pos)
  if (c >= 65 && c <= 90) {
    state.pos++
    return String.fromCharCode(c)
  }
  return state.atEnd() ? state.eoi("Token", ["uppercase letter"], 1) : state.backtrack("Token", ["uppercase letter"])
})
```

A driver that makes many small runs over one buffer, such as a tokenizer reading one token at a time, can run a parser's `step` on an `Input.State` itself and reuse that state between runs. `state.reset(offset, { partial, context })` resets every per-run field, so afterwards the state behaves exactly like `new Input.State(state.input, { offset, partial, context })`, even after a run that failed or returned `Incomplete`:

```ts
const state = new Input.State(buffer)
const token = (offset: number) => {
  const value = lexeme.step(state.reset(offset, { partial: true }))
  if (value !== Input.Fail) return { value, end: state.pos }
  if (state.mode === "Incomplete") return undefined // wait for more input
  throw ParseError.fromFailure(state.input, state.reportedFailure(), state.mode, state.encoding)
}
```

`step` always runs the interpreter; only the runners use [compiled code](#compiled-parsers).

### Combinator overview

| Category | Combinators |
| --- | --- |
| Constructors | `succeed`, `sync`, `empty`, `fail`, `failMessage`, `reject`, `todo`, `suspend`, `make`, `location`, `eof` |
| Mapping | `map`, `as`, `asVoid`, `asSome`, `tap`, `tryMap`, `tryMapUnknown`, `filterMap`, `filter`, `filterOrFail`, `mapParser`, `fromEntries` |
| Sequencing | `seq`, `struct`, `zip`, `zipWith`, `zipLeft`, `zipRight`, `preceded`, `terminated`, `delimited`, `separatedPair`, `flatMap`, `gen`, `Do`/`bind`/`bindTo`/`let` |
| Choice | `alt`, `orElse`, `orElseSucceed`, `dispatch`, `permutation` |
| Repetition | `repeat`, `repeatTill`, `separated`, `separatedFoldl1`, `separatedFoldr1`, `fold` |
| Control | `opt`, `optional`, `cond`, `peek`, `not`, `allConsuming` |
| Consumed input | `taken`, `withTaken`, `span`, `withSpan` |
| Errors | `cut`, `backtrack`, `complete`, `context`, `expected`, `mapError`, `orFail` |
| Services | `service`, `provideService`, `provide` |
| Recovery | `resumeAfter`, `retryAfter` |
| Debugging | `trace`, `named` |

Repetition ranges follow winnow: `Parser.repeat(p)` matches zero or more times, `Parser.repeat(p, 3)` exactly three times, and `Parser.repeat(p, { min: 1, max: 4 })` between one and four times. When `min` is a positive literal, the result is typed as a non-empty array.

## Running parsers

| Runner | Result |
| --- | --- |
| `Parser.parse(p, input)` | `Result<A, ParseError<E>>`; the whole input must be consumed |
| `Parser.parseSync(p, input)` | `A`; throws `ParseError<E>` |
| `Parser.parsePeek(p, input)` | `Result<[remaining, A], ParseError<E>>`, nom-style; the parser stopped at `input.length - remaining.length` |
| `Parser.parsePartial(p, input)` | `Result<Done \| Incomplete, ParseError<E>>` for streaming input; `Done` has the `offset` it stopped at |
| `Parser.parseEffect(p, input)` | `Effect<A, ParseError<E>, R>`; services come from the Effect context |
| `Parser.parseRecoverable(p, input)` | `{ value: Option<A>, errors }` with error recovery enabled |
| `ParserStream.parseMany(p)` | `Stream<I> => Stream<A>` (see [Streaming](#streaming-and-partial-input)) |
| `ParserSchema.make(p)` | a `Schema` decoding strings with the parser |
| `ParserSchema.fromSchema(s)` | a `Schema` decoding strings with the parser derived from `s` (see [Parsers from schemas](#parsers-from-schemas)) |
| `Syntax.parse(p, input)` | a `Syntax.Tree`: a syntax tree, the value and the errors (see [Syntax trees](#syntax-trees-and-incremental-parsing)) |

Every `Parser` runner takes an `offset` option, to start parsing part-way into the input. The result is that of parsing `input.slice(offset)`, without the copy, and offsets (`Done`'s `offset`, spans, `ParseError` offsets, lines and columns) are positions in the whole input. A lexer can read one token at a time from a buffer, compiled parsers included:

```ts
const lexeme = Compiler.jit(Parser.preceded(Ascii.multispace0, Ascii.alpha1))

const buffer = "let x = 1"
Parser.parsePartial(lexeme, buffer, { offset: 3 })
// Result.succeed({ _tag: "Done", value: "x", offset: 5 })
Parser.parsePeek(lexeme, buffer, { offset: 0 })
// Result.succeed([" x = 1", "let"]): it stopped at 9 - 6 = 3
```

Parsers over bytes (`Uint8Array`) also accept an `ArrayBuffer`, a `SharedArrayBuffer`, a `DataView` or any other typed array, in the runners and as `ParserStream` chunks. The data is viewed as a `Uint8Array` of the same memory, not copied, so offsets are byte offsets and slices are `Uint8Array`s:

```ts
const response = await fetch(url)
Parser.parse(Text.utf8.rest, await response.arrayBuffer())
Parser.parse(Binary.beU32, new DataView(buffer, 4))
```

Wider typed arrays are viewed in the platform's byte order, which is little endian on all common platforms. So a `Uint16Array` of UTF-16 code units can be parsed with `Text.utf16le`. `Input.fromSource` performs the same conversion.

## Compiled parsers

Combinators are flexible but run as a tree of closures. The `Compiler` module turns a grammar into fused, specialized code, without changing how it is written or what it returns:

```ts
import { Compiler } from "@thomasfosterau/effect-parse"

export const json = Compiler.jit(Parser.preceded(ws, value))

Parser.parse(json, text) // same Result as before, about 5 times faster
```

On the JSON example, compiled parsing runs at 5–6 times the speed of the interpreter, for strings, UTF-8 and UTF-16 alike, and at 1–4 times the time of `JSON.parse` depending on the document (see [the design notes](docs/DESIGN.md#results)).

There are two compilers, one function each:

- `Compiler.jit` generates JavaScript where `new Function` is allowed, and falls back to the closure compiler where it isn't.
- `Compiler.closure` never generates code. It is meant for pages with a Content Security Policy.

A bundle contains only the compilers it calls. A program that compiles nothing bundles neither, and one that uses only `Compiler.closure` contains no `new Function`. esbuild keeps every member of a namespace imported from the root entry, so with esbuild import from the subpaths instead (`import * as Compiler from "@thomasfosterau/effect-parse/Compiler"`). Rolldown and Rollup drop unused members either way.

Both return the same parser. The code is built on the first run, for each kind of input, and cached. `parse`, `parseSync`, `parsePeek`, `parsePartial`, `parseEffect`, `ParserStream.parseMany` and `ParserStream.parseAll` use it, from any `offset`; `parseRecoverable` and tracing stay interpreted. A driver that keeps its own `Input.State` (a lexer reading one token at a time, say) runs the compiled code with `Parser.run(p, state)`; calling `p.step(state)` directly always runs interpreted.

Compiled code records no diagnostics. When it fails, the parser runs again interpreted, so errors are exactly the same, byte for byte. Callbacks should therefore be pure: on failing input they may run twice, and those whose results are unused may be skipped. Parsers built with `Parser.make` or `Parser.gen` run interpreted inside compiled code. See the [design notes](docs/DESIGN.md#6-compiled-parsers) for details.

Some ways of writing a grammar compile to faster code than others:

- Build objects with `Parser.fromEntries` (or `Parser.map(Object.fromEntries)`) directly on a `separated` or `repeat` of pairs: compiled code assigns the properties as it parses, without the pairs and their array. A lambda that calls `Object.fromEntries` can't be recognized.
- Prefer token sets (`"abc"`, `Token.range`, the `Ascii` and `Text` predicates) to arbitrary predicates: they test code points without allocating, and strings, ranges and the `Ascii` predicates compile to comparisons. A `(c: string) => boolean` predicate receives each character as a new string. For a class of your own, declare it over code points with `Token.codePoints`, listing its ranges if you know them:

  ```ts
  const isNameStart = Token.codePoints("name start", (c) => c === 0x5f || (c >= 0x61 && c <= 0x7a) || c >= 0xc0, [
    [0x5f, 0x5f],
    [0x61, 0x7a],
    [0xc0, 0x10ffff]
  ])
  ```

- Avoid `flatMap` on hot paths: the parser it returns runs interpreted.
- Give `Parser.dispatch` a record of cases, not a function. With a record, compiled code switches on the key and runs the chosen case compiled, and on `Token.any` or `Parser.peek(Token.any)` it switches on the next unit without building the key. The parser a function returns runs interpreted, and if the function builds it (`(c) => Parser.cut(p)`), it is built again on every run.
- Build parsers once, outside callbacks and `Parser.gen` bodies. A parser built while parsing costs an allocation per combinator, every time, and is never compiled.
- On token arrays (the output of a lexer), match tokens with `Token.oneOf`, `Token.noneOf`, `Token.takeWhile` and `Token.anyToken`, with a predicate or a list of tokens: the JIT calls the predicate inline. A `Parser.make` that reads `state.input[state.pos]` runs interpreted, and records a failure, with its expected list, every time it doesn't match.
- Drive a lexer with `Parser.run` on one `Input.State` that you `reset` before each token: no run allocates a state, a `Result` or a slice, and the token parser runs compiled. When a failure only means "try something else", pass `{ diagnostics: false }`, so a failed compiled run isn't repeated interpreted to build an error you won't read.
- `Ascii.float` and `Text.float` convert numbers as they match them.

[`json-fast.ts`](examples/json-fast.ts) is the JSON example written this way; it runs records-heavy documents about 1.5 times as fast as [`json-text.ts`](examples/json-text.ts).

## Errors

Failures have a mode, as in winnow:

- **Backtrack**: recoverable. `alt`, `opt`, `repeat` and friends try something else.
- **Cut**: unrecoverable. Use `Parser.cut(p)` once a branch is certain (e.g. after an opening `[`), so errors point at the real problem instead of backtracking to an unhelpful alternative.
- **Incomplete**: partial input ran out (see below).

`ParseError` is a `Data.TaggedError("ParseError")`. It records the `offset`, `kind`, `expected` set, `context` labels and an optional typed `cause`, and its `message` points at the problem:

```text
Parse error at line 1, column 4:
1 | [1,,2]
  |    ^
while parsing array
expected value, found ","
```

effect-parse tries hard to produce good messages without annotations:

- `alt` merges the expectations of failed branches: `expected "true", "false" or "null"`.
- Optional and repeated parsers leave _hints_, so after `repeat(digit)` a failure reads `expected digit or ")"`.
- The furthest failure wins (the PEG heuristic), so a value that fails after a separator is reported where it failed.
- `Parser.expected("value")` names a rule; `Parser.context("array")` adds "while parsing array".

User errors are typed. `Parser.fail(e)`, `Parser.tryMap(f)` and `Parser.filterOrFail(pred, f)` add their error type to `E`, and the error arrives as `ParseError.cause`:

```ts
class OutOfRange extends Schema.TaggedError<OutOfRange>()("OutOfRange", { value: Schema.Number }) {}

const port = Ascii.decUint.pipe(
  Parser.filterOrFail(
    (n) => n < 65536,
    (value) => new OutOfRange({ value })
  )
)
// Parser<number, string | OutOfRange>
```

## Streaming and partial input

nom has separate `streaming` and `complete` modules. winnow marks the input as `Partial`. In effect-parse, partiality is decided by the runner, so every parser works in both modes:

```ts
Parser.parsePartial(Ascii.digit1, "123")
// Result.succeed({ _tag: "Incomplete", needed: Option.some(1) })   -- more digits may follow
Parser.parsePartial(Ascii.digit1, "123;")
// Result.succeed({ _tag: "Done", value: "123", offset: 3 })
```

`ParserStream.parseMany` connects this to Effect streams. It buffers chunks, retries on `Incomplete`, and parses the tail in complete mode when the stream ends:

```ts
import { Effect, Stream } from "effect"
import { Ascii, Parser, ParserStream, Token } from "@thomasfosterau/effect-parse"

const line = Parser.terminated(Ascii.decInt, Token.literal("\n"))

Stream.make("1\n2", "3\n", "4\n").pipe(ParserStream.parseMany(line), Stream.runCollect)
// Effect<[1, 23, 4], ParseError<string>>
```

### Parsing a download as it arrives

`ParserStream.parseAll` parses a stream as one document, and does not wait for it to end: each chunk is parsed as it arrives. When the input runs out mid-way, repetitions (`repeat`, `separated`, `fold`, `escaped`, ...) remember how far they got, so the next attempt carries on from there rather than starting over. `parseResponse` and `parseReadable` do the same for web streams, so the body of a `fetch` response is parsed straight from its bytes, without decoding it first or waiting for the download:

```ts
import { Effect } from "effect"
import { Compiler, ParserStream, Text } from "@thomasfosterau/effect-parse"

const json = Compiler.jit(jsonGrammar(Text.utf8)) // see examples/json-text.ts

const value = await Effect.runPromise(ParserStream.parseResponse(await fetch(url), json))
```

The result, and any error, is the same as parsing the whole body at once. Compiled parsers stream compiled. With the JSON example on a 2 MB document, `parseResponse` returns about 1 ms after the last byte at 10 MB/s, and keeps pace with `Response.json()` at 25 MB/s; on faster connections the native parser is quicker (`vp run bench:stream`).

## Services

Parsers can require Effect services. These replace winnow's `Stateful` input: configuration, symbol tables, indentation stacks and so on.

```ts
import { Context, Effect } from "effect"

class Radix extends Context.Service<Radix, number>()("Radix") {}

const number = Parser.service(Radix).pipe(
  Parser.flatMap((radix) => Ascii.alphanumeric1.pipe(Parser.map((s) => parseInt(s, radix))))
)
// Parser<number, never, Radix>

Parser.parse(Parser.provideService(number, Radix, 16), "ff") // 255
Parser.parseEffect(number, "777").pipe(Effect.provideService(Radix, 8)) // Effect<511>
```

## Parsers from schemas

`ParserSchema.toParser` derives a parser from an Effect `Schema`, so a text format can be declared once, as the schema of the values it holds. `parser` annotations, set with `ParserSchema.annotate`, say how each part is written: a `prefix` and `suffix`, the `separator` between fields, elements or entries, the `keySeparator` of `key=value` entries, whether `whitespace` may surround that text, or a `parser` that replaces the derived one.

```ts
import { Schema } from "effect"

const Point = Schema.Struct({ x: Schema.Int, y: Schema.Int }).pipe(
  ParserSchema.annotate({ prefix: "(", separator: ",", suffix: ")", whitespace: true })
)

const Config = Schema.Struct({
  name: Schema.String,
  origin: Point,
  color: Schema.optionalKey(Schema.Int.pipe(ParserSchema.annotate({ parser: Ascii.hexUint, prefix: "#" })))
}).pipe(ParserSchema.annotate({ separator: ";", keySeparator: "=" }))

const config = ParserSchema.toParser(Config)
Parser.parse(config, "origin=( 1, -2 );name=main;color=#ff")
// Result.succeed({ name: "main", origin: { x: 1, y: -2 }, color: 255 })

Parser.parse(config, "name=main;origin=(1,x)")
// Result.fail(ParseError):
//   Parse error at line 1, column 21:
//   1 | name=main;origin=(1,x)
//     |                     ^
//   expected one of "+-" or digit, found "x"
```

Without annotations, a struct or tuple is its fields in order, an array its elements, a union its first member that parses, and a `suspend`ed schema recursion. A string runs to the next separator or suffix; a number is decimal, and an integer when the schema checks `isInt`. A record, or a struct with a `keySeparator`, is `key=value` entries in any order. A schema's checks and transformations (a `Class`, `NumberFromString`, a brand) run as `Schema.decode` runs them, and their failures are parse errors whose `cause` is the `SchemaError`. The doc comment of `toParser` lists every rule.

A derived parser is an ordinary parser: it composes with the combinators, and the [compilers](#compiled-parsers) compile it. `ParserSchema.fromSchema(schema, { encode })` wraps it as a `Schema` from `string`.

## Unicode text and encodings

`Token` reads strings by code point, but the `Ascii` character classes and numbers only cover ASCII, and they treat bytes as ASCII. The `Text` module adds Unicode parsers that work with any encoding. `Text.make(encoding)` builds a set of parsers (`Text.TextParsers<I>`), and sets are provided for the common encodings:

| Parsers                        | Input        | Offsets           |
| ------------------------------ | ------------ | ----------------- |
| `Text.string`                  | `string`     | UTF-16 code units |
| `Text.utf8`                    | `Uint8Array` | bytes             |
| `Text.utf16le`, `Text.utf16be` | `Uint8Array` | bytes             |
| `Text.latin1`                  | `Uint8Array` | bytes             |

Every set has the same members (`any`, `literal`, `caseless`, `oneOf`, `takeWhile`, `takeUntil`, `alpha1`, `digit1`, `space1`, `identifier`, `lineEnding`, `decInt`, `float`, `escaped`, `bom`, ...), and every parser returns `string`s. A grammar written once against `TextParsers<I>` therefore parses any of these inputs:

```ts
import { Encoding, Parser, Text } from "@thomasfosterau/effect-parse"

const assignment = <I extends string | Uint8Array>(T: Text.TextParsers<I>) =>
  Parser.separatedPair(T.identifier, Parser.delimited(T.space0, T.literal("≔"), T.space0), T.decInt)

Parser.parse(assignment(Text.string), "größe ≔ 42") // ["größe", 42]
Parser.parse(assignment(Text.utf8), new TextEncoder().encode("größe ≔ 42")) // ["größe", 42]
Parser.parse(assignment(Text.utf16le), Encoding.utf16le.encode("größe ≔ 42"))
```

- **Unicode classes.** `alpha1` matches `"Ωμέγα"`, `digit1` matches `"١٢٣"`, `space1` matches a no-break space, and `identifier` follows UAX #31. The predicates (`Text.isLetter`, `Text.isWhitespace`, `Text.isIdStart`, ...) also work with `Token`, and `Text.property("Script=Greek")` tests any Unicode property. Numbers (`decInt`, `float`) take ASCII digits only, as most languages do.
- **Bytes are decoded as they are parsed.** Offsets stay byte offsets, and `Parser.taken` still returns a zero-copy `Uint8Array`. On partial input, a character split across chunks reports `Incomplete`, so `ParserStream.parseMany` parses a byte stream as text without decoding it first.
- **Decoding is strict.** Invalid UTF-8 and unpaired surrogates never match. Errors on encoded bytes show the input as text:

  ```text
  Parse error at line 1, column 3 (byte 2):
  1 | ab�c
    |   ^
  expected letter or end of input, found invalid UTF-8 0xff
  ```

- **Byte order marks.** `Encoding.sniff(bytes)` picks an encoding from a BOM, and `T.bom` skips one.
- **Binary data.** The byte parsers accept `ArrayBuffer`s, `DataView`s and typed arrays too (see [Running parsers](#running-parsers)).
- **Custom encodings.** `Text.make` accepts any `Encoding.Encoding`: a `decode` function plus a few properties.

JavaScript strings are parsed natively, and the `Text` parsers only decode byte input. Converting strings to bytes up front would be slower: a `TextDecoder` call to produce each slice costs several times more than `String.prototype.slice`. `vp run bench` compares the paths with a JSON grammar written once for every encoding ([`json-text.ts`](examples/json-text.ts)). In our runs `Text.string` was roughly 5–15% slower than the `Token`/`Ascii` parsers, and parsing UTF-8 directly was within about 10% of decoding it first.

## Syntax trees and incremental parsing

The `Syntax` module builds concrete syntax trees, like [Tree-sitter](https://tree-sitter.github.io): trees of nodes with spans, parents and siblings, which can be searched by position, walked with a cursor, and parsed again _incrementally_ after an edit.

Mark the rules that should appear in the tree with `Syntax.node`. Outside `Syntax.parse` the marks change nothing (compiled parsers compile them away), so a grammar can be used both for values and for trees:

```ts
import { Ascii, Parser, Syntax, Token } from "@thomasfosterau/effect-parse"

const name = Syntax.node(Ascii.alpha1, "name")
const number = Syntax.node(Ascii.decInt, "number")
const pair = Syntax.node(
  Parser.separatedPair(Syntax.field(name, "key"), Syntax.token(Token.literal("=")), Syntax.field(number, "value")),
  "pair"
)
const config = Parser.separated(pair, Token.literal("\n"))

const tree = Syntax.parse(config, "width=80\nheight=24")
String(tree.root)
// (document (pair key: (name) value: (number)) (pair key: (name) value: (number)))

const node = tree.descendantAt(16) // the deepest node at offset 16
node.kind // "number"
node.text // "24"
node.value // 24, the parser's output
node.parent?.childByField("key")?.text // "height"
tree.lineColumn(node.start) // { line: 2, column: 8 }
tree.value // Option.some([["width", 80], ["height", 24]])
```

Each node's `value` is its parser's output, so a tree carries the parsed values as well as the structure. `Syntax.token` marks _anonymous_ nodes (punctuation, keywords), which are left out of `namedChildren` and of the printed tree, and `Syntax.field` names a child in its parent. Nodes have `children`, `namedChildren`, `parent`, `nextSibling`, `previousSibling`, `childAt(offset)`, `descendantAt(start, end?)` and `descendants()`; `tree.walk()` returns a `TreeCursor` with Tree-sitter's `gotoFirstChild`, `gotoNextSibling`, `gotoParent`, `gotoFirstChildForOffset`, and so on.

**Errors.** A syntax parse always returns a tree. Failures recovered with `Parser.resumeAfter` or `Parser.retryAfter` (recovery is always on here) become `ERROR` nodes over the input that was skipped, and so does any input left after a fatal failure. `tree.errors` lists them as `ParseError`s.

**Incremental parsing.** After an edit, `Syntax.reparse(tree, newInput, edits?)` parses the new input reusing the nodes of the old tree that the edit leaves unchanged; `Syntax.replace(tree, start, end, text)` does the edit too. The result is exactly the tree a fresh parse gives (the test suite checks this on random edits), but only the nodes around the edit are parsed again:

```ts
const edited = Syntax.replace(tree, 6, 8, "100") // "width=100\nheight=24"
edited.value // Option.some([["width", 100], ["height", 24]])
edited.reused // 2: "width", and the second pair as a whole
```

The edits are Tree-sitter's `{ start, oldEnd, newEnd }`, applied in order; without them the edit is found by comparing the two inputs. A node is reused when it was built by the same `Syntax.node` and the input its parse _looked at_ is unchanged. That includes lookahead: a node is parsed again when an edit lands just after it, if its parse read that far (to see that a number ended, say). Built-in parsers record how far they read; custom ones may need the `lookahead` option. Values are reused as they are, so a node's value should depend only on its input: not on services, closure state or absolute offsets (`Parser.span`, `Parser.location`); use the node's `start` and `end` instead.

On a 0.58 M-character JSON document (`vp run bench:syntax`), building the tree takes about twice as long as parsing the value interpreted, and reparsing after a one-character edit takes about 2 ms, against 80 ms for the full parse. Most of that is stepping over the 2000 reused elements of the top-level array; the tree is not rebalanced as Tree-sitter's is.

## Modules

| Module | Contents | winnow / nom equivalent |
| --- | --- | --- |
| `Parser` | the type, combinators, runners | `Parser` trait, `combinator` / `combinator`, `branch`, `multi`, `sequence` |
| `Token` | `any`, `literal`, `oneOf`, `noneOf`, `take`, `takeWhile`, `takeTill`, `takeUntil`, `rest`, `range`, `codePoints` | `token` / `bytes` |
| `Text` | Unicode parsers for any encoding: `string`, `utf8`, `utf16le`, `utf16be`, `latin1`, `make`; Unicode predicates | — |
| `Encoding` | text encodings for `Text`, `sniff` | — |
| `Ascii` | character classes, `lineEnding`, `decInt`, `decUint`, `hexUint`, `float`, `caseless`, `takeEscaped`, `escaped`, `Ascii.bytes.*` | `ascii` / `character`, `number` |
| `Binary` | `u8`, `beU16` … `leI128`, floats, `lengthTake`, `lengthRepeat`, `lengthAndThen` | `binary` / `number`, `multi::length_*` |
| `Bits` | `bits`, `bytes`, `take`, `takeBig`, `pattern`, `bool` | `binary::bits` / `bits` |
| `Expression` | Pratt parser with prefix, postfix and infix operators | `combinator::expression` / `nom-language::precedence` |
| `Compiler` | `jit`, `closure`: [compiled parsers](#compiled-parsers) | — |
| `ParseError` | the error type, `lineColumn`, `formatExpected` | `error` |
| `ParserStream` | `parseMany`, `parseAll` over Effect `Stream`s | `Partial` / `streaming` |
| `ParserSchema` | `make`: a `Schema` from a parser; `toParser`, `fromSchema`, `annotate`: a parser from an annotated `Schema` | — |
| `Syntax` | syntax trees: `node`, `token`, `field`, `parse`, incremental `reparse` and `replace`, `Tree`, `SyntaxNode`, `TreeCursor` | — (Tree-sitter) |
| `Nom` | nom names and argument orders (`tag`, `many0`, `separatedList1`, `mapRes`, …) | nom |
| `Input` | input types and the `State` cursor for `Parser.make` | `stream` |

Token parsers that cannot infer their input type take a type argument that defaults to `string`, like a Rust turbofish:

```ts
Token.take(4) // Parser<string>
Token.take<Uint8Array>(4) // Parser<Uint8Array, never, never, Uint8Array>
Token.oneOf<ReadonlyArray<Tok>>((t) => t.kind === "Number")
```

## Coming from nom or winnow

| nom                     | winnow                              | effect-parse                                        |
| ----------------------- | ----------------------------------- | --------------------------------------------------- |
| `tag("x")`              | `"x"`, `literal("x")`               | `Token.literal("x")`                                |
| `char('x')`             | `'x'`                               | `Token.literal("x")`                                |
| `alt((a, b))`           | `alt((a, b))`                       | `Parser.alt(a, b)`                                  |
| `(a, b)` / `tuple`      | `(a, b)`                            | `Parser.seq(a, b)`                                  |
| —                       | `seq!(S { a: .., b: .. })`          | `Parser.struct({ a, b })`                           |
| `many0(p)`              | `repeat(0.., p)`                    | `Parser.repeat(p)`                                  |
| `many1(p)`              | `repeat(1.., p)`                    | `Parser.repeat(p, { min: 1 })`                      |
| `count(p, n)`           | `repeat(n, p)`                      | `Parser.repeat(p, n)`                               |
| `separated_list0(s, p)` | `separated(0.., p, s)`              | `Parser.separated(p, s)`                            |
| `fold_many0(p, i, f)`   | `repeat(0.., p).fold(i, f)`         | `Parser.fold(p, { init, f })`                       |
| `many_till(p, e)`       | `repeat_till(0.., p, e)`            | `Parser.repeatTill(p, e)`                           |
| `take_while1(f)`        | `take_while(1.., f)`                | `Token.takeWhile(f, { min: 1 })`                    |
| `map(p, f)`             | `p.map(f)`                          | `Parser.map(p, f)` / `p.pipe(Parser.map(f))`        |
| `map_res(p, f)`         | `p.try_map(f)`                      | `Parser.tryMap(p, f)` (`f` returns a `Result`)      |
| `map_opt(p, f)`         | `p.verify_map(f)`                   | `Parser.filterMap(p, f)` (`f` returns an `Option`)  |
| `verify(p, f)`          | `p.verify(f)`                       | `Parser.filter(p, f)`                               |
| `value(v, p)`           | `p.value(v)`                        | `Parser.as(p, v)`                                   |
| `recognize(p)`          | `p.take()`                          | `Parser.taken(p)`                                   |
| `consumed(p)`           | `p.with_taken()`                    | `Parser.withTaken(p)`                               |
| `map_parser(p, q)`      | `p.and_then(q)`                     | `Parser.mapParser(p, q)`                            |
| `flat_map(p, f)`        | `p.flat_map(f)`                     | `Parser.flatMap(p, f)`                              |
| `cut(p)`                | `cut_err(p)`                        | `Parser.cut(p)`                                     |
| `context("x", p)`       | `p.context(StrContext::Label("x"))` | `Parser.context(p, "x")`                            |
| `complete(p)`           | `p.complete_err()`                  | `Parser.complete(p)`                                |
| `IResult`               | `parse_peek`                        | `Parser.parsePeek`                                  |
| `streaming::*`          | `Partial<I>`                        | `Parser.parsePartial`, `ParserStream`               |
| —                       | `dispatch!`                         | `Parser.dispatch(selector, cases)`                  |
| —                       | `Stateful<I, S>`                    | `Parser.service` + Effect `Context`                 |
| —                       | `LocatingSlice`                     | `Parser.span`, `Parser.withSpan`, `Parser.location` |
| —                       | `resume_after`                      | `Parser.resumeAfter` + `Parser.parseRecoverable`    |

The `Nom` module provides the nom names directly, with nom's argument orders, for mechanical ports.

## Examples

[`examples/`](examples) contains ports of winnow's examples, each with tests in [`test/examples.test.ts`](test/examples.test.ts):

- [`json.ts`](examples/json.ts): JSON with `dispatch`, `cut` and escapes
- [`json-text.ts`](examples/json-text.ts): the same grammar written once against `Text.TextParsers`, for strings, UTF-8 and UTF-16
- [`json-fast.ts`](examples/json-fast.ts): the same grammar written for compiled parsers, with `Parser.fromEntries`
- [`arithmetic.ts`](examples/arithmetic.ts): direct evaluation, an AST via the Pratt parser, and a lexer plus a parser over the token array
- [`ini.ts`](examples/ini.ts): INI files with a generator-style parser
- [`http.ts`](examples/http.ts): HTTP requests over bytes, complete and streamed
- [`sexpr.ts`](examples/sexpr.ts): s-expressions with typed evaluation errors
- [`json-syntax.ts`](examples/json-syntax.ts): JSON as a syntax tree for editors, with fields, `ERROR` nodes for malformed elements, and incremental reparsing (tested in [`test/Syntax.test.ts`](test/Syntax.test.ts))

`vp run bench` (from a clone) compares the JSON examples, on each encoding, with `JSON.parse`.

## Design

[`docs/DESIGN.md`](docs/DESIGN.md) records the research into nom, winnow and Effect, and the reasoning behind each decision in this port.

## Development

```sh
pnpm install
vp check             # format + lint
vp run check         # type-check sources, tests, examples and benchmarks
vp run test:unit     # run the test suite
vp run build         # emit dist/
vp run check:dist    # check dist/ as a consumer imports it
vp run bench         # JSON example: interpreted vs compiled, per encoding
```

The other benchmarks (`bench:native`, `bench:stream`, `bench:gen`, `bench:syntax`) and single checks are listed in [CONTRIBUTING.md](CONTRIBUTING.md). Repository conventions are in [AGENTS.md](AGENTS.md), the release pipeline in [PUBLISHING.md](PUBLISHING.md) and the vulnerability-reporting policy in [SECURITY.md](SECURITY.md).

## License

MIT
