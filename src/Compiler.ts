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
 * message) is exactly the one the interpreter reports. Running out of
 * partial input is not a failure that needs it: compiled code reports
 * `Incomplete` where the interpreter does, with the same `needed`.
 *
 * **Callbacks should be pure.** On an input that fails, the callbacks given
 * to `map`, `filter`, `tryMap`, `tap`, `fold`, ... may run twice, once
 * compiled and once interpreted. Callbacks whose results are discarded
 * (a `map` inside `taken` or `preceded`, for example) may not run at all,
 * nor those of a branch that is certain to fail, and token-set predicates
 * may be called once per character code and cached.
 *
 * `Parser.parsePartial`, `ParserStream.parseAll` and
 * `ParserStream.parseMany` run a build that handles partial input;
 * `parseMany` runs it once per value and parses a value again, interpreted,
 * only when it fails. `Parser.parseRecoverable`, `Syntax`
 * parses and runs with the `trace` option are always interpreted. Parsers that
 * can't be described, such as `Parser.make` and `Parser.gen`, run
 * interpreted inside compiled code; the parsers given to a
 * `Parser.combinator` compile, and its step is built from theirs.
 *
 * @since 0.2.0
 */
import type { Fail, Input, State } from "./Input.js"
import type { Parser, RunOptions } from "./Parser.js"
import { backend as closureBackend } from "./internal/compiler/closure.js"
import { backend as jitBackend } from "./internal/compiler/jit.js"
import { register } from "./internal/compiler/registry.js"
import { backend as wasmBackend } from "./internal/compiler/wasm.js"
import { prepare } from "./internal/run.js"

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

/**
 * Prepares a parser for running many times on states you own, as
 * `Parser.run` does: for drivers that make one small run per token, such as
 * a lexer over a buffer. `Parser.run` looks the parser's compiled form up
 * on every run, which costs about a quarter of a small token's time; the
 * function returned here looks it up once (again only when the input kind
 * changes, or between complete and partial states) and calls the compiled
 * code directly.
 *
 * It returns exactly what `Parser.run(self, state, options)` returns, and
 * leaves the state as it would: the output with the cursor where the
 * parser stopped, or `Fail` with the interpreter's failure (or, with
 * `diagnostics: false`, only the mode). Compile the parser first with
 * {@link jit} or {@link closure}; a parser that isn't compiled runs
 * interpreted. The compiled form is looked up on the first run, so compile
 * the parser before using the runner: compiling it again later doesn't
 * reach a runner that has already run.
 *
 * @example
 * ```ts
 * import { Ascii, Compiler, Input, Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const token = Compiler.jit(Parser.preceded(Ascii.space0, Parser.alt(Ascii.alpha1, Token.oneOf("+-"))))
 * const next = Compiler.runner(token)
 *
 * const tokens = (text: string): Array<string> => {
 *   const state = new Input.State(text)
 *   const out: Array<string> = []
 *   while (state.pos < state.end) {
 *     const t = next(state.reset(state.pos))
 *     if (t === Input.Fail) break
 *     out.push(t)
 *   }
 *   return out
 * }
 *
 * tokens("a + b") // ["a", "+", "b"]
 * ```
 *
 * @since 0.5.0
 * @category running
 */
export const runner = <A, E, R, I extends Input>(
  self: Parser<A, E, R, I>,
  options?: RunOptions
): ((state: State<I>) => A | Fail) => prepare(self, self.step, options?.diagnostics !== false)
