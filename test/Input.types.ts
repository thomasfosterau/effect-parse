/**
 * Compile-time assertions for `Input`: each expect-error directive is the
 * assertion (the statement below it must fail to type-check). Checked by
 * `vp run check`, never executed.
 */
import { Parser, Text, Token } from "../src/index.js"

// @ts-expect-error: a string parser does not accept binary data
Parser.parse(Text.string.alpha1, new ArrayBuffer(1))
// @ts-expect-error: neither does a parser over token arrays
Parser.parse(Token.anyToken<ReadonlyArray<number>>(), new ArrayBuffer(1))
