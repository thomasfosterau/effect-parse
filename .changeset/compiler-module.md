---
"@thomasfosterau/effect-parse": minor
---

**Breaking:** compile parsers with the new `Compiler` module (`@thomasfosterau/effect-parse/Compiler`) instead of `Parser.compile`. `Compiler.jit(p)` replaces `Parser.compile(p)` and `Parser.compile(p, { backend: "auto" })`, and `Compiler.closure(p)` replaces `Parser.compile(p, { backend: "closure" })`. `Parser.compile` and `Parser.CompileOptions` are removed.

The two backends are now separate functions, so bundles contain only the compilers a program uses (#15). `Parser` and its runners no longer import a compiler. A program that never compiles a parser no longer bundles about 45 KB of minified compiler code. A program that uses only `Compiler.closure` contains no `new Function`, which Content Security Policy and supply-chain scanners flag even when it never runs.
