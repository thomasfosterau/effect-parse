/**
 * Compiles parsers into fused, specialized code. Grammars are written as
 * usual; compiling the root of a grammar only makes `Parser.parse`,
 * `Parser.parseSync`, `Parser.parsePeek`, `Parser.parsePartial` and
 * `Parser.parseEffect` faster, from any `offset`.
 *
 * There are three compilers, one function each, so a program bundles only
 * the ones it uses, and a program that compiles nothing bundles none:
 *
 * - {@link wasm} scans the input in WebAssembly and builds the value with
 *   generated JavaScript. It is the fastest on strings and bytes, and uses
 *   the JIT for array input and streaming, and where WebAssembly or
 *   `new Function` is unavailable.
 * - {@link jit} generates code with `new Function` where it is allowed, and
 *   otherwise uses the closure compiler.
 * - {@link closure} builds specialized closures only. It never generates
 *   code, and a bundle that uses only it contains no `new Function`, so it
 *   is the choice under a Content Security Policy, where even probing for
 *   `new Function` is reported as a violation.
 *
 * ```ts
 * import { Ascii, Compiler, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * export const list = Compiler.jit(
 *   Parser.separated(Ascii.decInt, Token.literal(","))
 * )
 * Parser.parse(list, "1,2,3") // Result.succeed([1, 2, 3]), compiled
 * ```
 *
 * Both return the same parser, so they also work in a pipe:
 * `p.pipe(Compiler.closure)`. The code is built lazily on the first run, for
 * each kind of input (string, bytes or array), and cached with the parser.
 * Compiling a parser again, with either function, replaces its compiled
 * form.
 *
 * **Results and errors are unchanged.** Compiled code records no
 * diagnostics. When it fails, the parser runs again, interpreted, from the
 * same offset, so every `ParseError` (offset, expected, context, cause and
 * message) is exactly the one the interpreter reports.
 *
 * **Callbacks should be pure.** On an input that fails, the callbacks given
 * to `map`, `filter`, `tryMap`, `tap`, `fold`, ... may run twice, once
 * compiled and once interpreted. Callbacks whose results are discarded
 * (a `map` inside `taken` or `preceded`, for example) may not run at all,
 * nor those of a branch that is certain to fail, and token-set predicates
 * may be called once per character code and cached.
 *
 * `Parser.parsePartial` and `ParserStream.parseAll` run a build that
 * handles partial input. `ParserStream.parseMany`, `Parser.parseRecoverable`
 * and runs with the `trace` option are always interpreted. Parsers that
 * can't be described, such as `Parser.make` and `Parser.gen`, run
 * interpreted inside compiled code.
 *
 * @since 0.2.0
 */
import type { Input } from "./Input.js"
import type { Parser } from "./Parser.js"
import { backend as closureBackend } from "./internal/compiler/closure.js"
import { backend as jitBackend } from "./internal/compiler/jit.js"
import { register } from "./internal/compiler/registry.js"
import { backend as wasmBackend } from "./internal/compiler/wasm.js"

/**
 * Compiles a parser with the WebAssembly compiler. Returns the same parser.
 *
 * The input is copied into WebAssembly memory and scanned there, by code
 * generated from the grammar; a JavaScript function generated with
 * `new Function` then builds the value from what the scan recorded, with
 * the same callbacks and the same objects as the JIT. Parts of the grammar
 * with no WebAssembly form (such as `Parser.make`, `flatMap`, or `filter`
 * on a value) run their JIT-compiled code from inside the scan.
 *
 * It uses the JIT (see {@link jit}) for array input, for the streaming build
 * of `Parser.parsePartial` and `ParserStream`, and where `WebAssembly` or
 * `new Function` is unavailable: a Content Security Policy needs both
 * `'wasm-unsafe-eval'` and `'unsafe-eval'` for it. Short strings with the
 * same characters may be returned as one string, which no program can tell
 * apart from two.
 *
 * @example
 * ```ts
 * import { Ascii, Compiler, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const list = Compiler.wasm(Parser.separated(Ascii.decInt, Token.literal(",")))
 * Parser.parse(list, "1,2,3") // Result.succeed([1, 2, 3])
 * ```
 *
 * @since 0.5.0
 * @category compilation
 */
export const wasm = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<A, E, R, I> => {
  register(self, wasmBackend)
  return self
}

/**
 * Compiles a parser with the JIT: generated code where `new Function` is
 * allowed, otherwise specialized closures (see {@link closure}). Returns the
 * same parser.
 *
 * @example
 * ```ts
 * import { Ascii, Compiler, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const list = Compiler.jit(Parser.separated(Ascii.decInt, Token.literal(",")))
 * Parser.parse(list, "1,2,3") // Result.succeed([1, 2, 3])
 * ```
 *
 * @since 0.2.0
 * @category compilation
 */
export const jit = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<A, E, R, I> => {
  register(self, jitBackend)
  return self
}

/**
 * Compiles a parser into specialized closures. Returns the same parser.
 * Nothing is generated, so it works under a Content Security Policy, and a
 * bundle that compiles only with `closure` contains no `new Function`.
 *
 * @example
 * ```ts
 * import { Ascii, Compiler, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const list = Compiler.closure(Parser.separated(Ascii.decInt, Token.literal(",")))
 * Parser.parse(list, "1,2,3") // Result.succeed([1, 2, 3])
 * ```
 *
 * @since 0.2.0
 * @category compilation
 */
export const closure = <A, E, R, I extends Input>(self: Parser<A, E, R, I>): Parser<A, E, R, I> => {
  register(self, closureBackend)
  return self
}
