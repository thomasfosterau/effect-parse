---
"@thomasfosterau/effect-parse": minor
---

The overloaded exports have named types: `Parser.ParseFn`, `ParseSyncFn`, `ParsePeekFn`, `ParsePartialFn`, `ParseRecoverableFn` and `DispatchFn`, `Input.FromSourceFn`, `Token.LiteralFn` and `TakeUntilFn`, `Ascii.CaselessFn` and `Syntax.ParseFn`, each holding the same call signatures as before, so calls infer the same types. `SyntaxNode.toJSON()` returns the new `Syntax.SyntaxNodeJson` (`{ kind, start, end }`) instead of `unknown` (#77).
