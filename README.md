# effect-parse

Parser combinators for [Effect](https://effect.website), ported from Rust's [nom](https://github.com/rust-bakery/nom) and [winnow](https://github.com/winnow-rs/winnow): text, bytes, bits and token streams, streaming input, compiled parsers, syntax trees and Schema integration.

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. The API may change between minor versions.

## Install

```sh
pnpm add @thomasfosterau/effect-parse effect
```

`effect` (`^4.0.0`) is a peer dependency. Every module is on the root entry as a namespace and on its own subpath (`@thomasfosterau/effect-parse/Parser`, …).

## Example

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

Parser.parse(point, "(1,-2)") // Result.succeed({ x: 1, y: -2 })
Parser.parse(point, "(1;-2)") // Result.fail(ParseError): expected digit or ",", found ";" at line 1, column 3
```

## Documentation

- [Guide](https://github.com/thomasfosterau/effect-parse/blob/trunk/docs/guide.md): writing, running and compiling parsers, errors, streaming, schemas, Unicode, syntax trees, coming from nom or winnow.
- [Architecture](https://github.com/thomasfosterau/effect-parse/blob/trunk/docs/ARCHITECTURE.md): how parsing, compilation, streaming and syntax trees fit together.
- [Examples](https://github.com/thomasfosterau/effect-parse/tree/trunk/examples): JSON, arithmetic, INI, HTTP, jq and a ripgrep clone.
- [Contributing](https://github.com/thomasfosterau/effect-parse/blob/trunk/docs/CONTRIBUTING.md), [security](https://github.com/thomasfosterau/effect-parse/blob/trunk/docs/SECURITY.md), [changelog](https://github.com/thomasfosterau/effect-parse/blob/trunk/CHANGELOG.md).

## License

[MIT](https://github.com/thomasfosterau/effect-parse/blob/trunk/LICENSE.md)
