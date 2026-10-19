# @thomasfosterau/effect-parse

## 0.1.0

### Minor Changes

- [#11](https://github.com/thomasfosterau/effect-parse/pull/11) [`8f77dad`](https://github.com/thomasfosterau/effect-parse/commit/8f77dad2cd9ca1afe000b9dfe8b370b94b06460f) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - First release of `@thomasfosterau/effect-parse` (developed as `effect-nom`): parser combinators for Effect, ported from Rust's nom and winnow. Text, byte, bit and token-stream input; `Backtrack` / `Cut` / `Incomplete` error modes; streaming input through `ParserStream`; compiled parsers through `Parser.compile`; `Schema` integration through `ParserSchema`; and `ParseError` diagnostics with line and column. Requires `effect` 4.x as a peer.
