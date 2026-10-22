/**
 * Arithmetic expressions, after winnow's `examples/arithmetic`:
 *
 * - `evaluate`: computes values directly with `separatedFoldl1`
 *   (`parser.rs`)
 * - `ast`: builds a syntax tree with the Pratt `Expression` parser
 *   (`parser_ast.rs`)
 * - `lex` + `tokens`: a separate lexer producing tokens, and a parser over
 *   the token array (`parser_lexer.rs`, winnow's `TokenSlice`)
 */
import { Ascii, Expression, Parser, Token } from "@thomasfosterau/effect-parse"

const ws = <A, E>(p: Parser.Parser<A, E>) => Parser.delimited(Ascii.space0, p, Ascii.space0)

// -----------------------------------------------------------------------------
// Direct evaluation
// -----------------------------------------------------------------------------

const parens: Parser.Parser<number, string> = Parser.delimited(
  ws(Token.literal("(")),
  Parser.suspend(() => evaluate),
  ws(Token.literal(")"))
)

const factor: Parser.Parser<number, string> = ws(Parser.alt(Ascii.decInt, parens))

const term = Parser.separatedFoldl1(factor, Token.oneOf("*/"), (l, op, r) => (op === "*" ? l * r : l / r))

export const evaluate: Parser.Parser<number, string> = Parser.separatedFoldl1(term, Token.oneOf("+-"), (l, op, r) =>
  op === "+" ? l + r : l - r
)

// -----------------------------------------------------------------------------
// Syntax tree with the Pratt parser
// -----------------------------------------------------------------------------

export type Expr =
  | { readonly _tag: "Value"; readonly value: number }
  | { readonly _tag: "Neg"; readonly expr: Expr }
  | { readonly _tag: "Binary"; readonly op: string; readonly left: Expr; readonly right: Expr }
  | { readonly _tag: "Paren"; readonly expr: Expr }

const binary = (left: Expr, op: string, right: Expr): Expr => ({ _tag: "Binary", op, left, right })

export const ast: Parser.Parser<Expr, string> = Expression.make({
  operand: ws(
    Parser.alt(
      Ascii.decUint.pipe(Parser.map((value): Expr => ({ _tag: "Value", value }))),
      Parser.delimited(
        Token.literal("("),
        Parser.suspend(() => ast),
        Token.literal(")")
      ).pipe(Parser.map((expr): Expr => ({ _tag: "Paren", expr })))
    )
  ),
  operators: [
    Expression.prefix(ws(Token.literal("-")), 3, (_, expr: Expr): Expr => ({ _tag: "Neg", expr })),
    Expression.infixLeft(ws(Token.oneOf("*/")), 2, binary),
    Expression.infixLeft(ws(Token.oneOf("+-")), 1, binary)
  ]
})

/** Renders an expression with explicit parentheses, as winnow's example does. */
export const show = (e: Expr): string => {
  switch (e._tag) {
    case "Value":
      return String(e.value)
    case "Neg":
      return `-${show(e.expr)}`
    case "Paren":
      return `(${show(e.expr)})`
    case "Binary":
      return `${e.op} ${show(e.left)} ${show(e.right)}`
  }
}

// -----------------------------------------------------------------------------
// Lexer + token parser
// -----------------------------------------------------------------------------

export type Tok =
  | { readonly kind: "Value"; readonly value: number }
  | { readonly kind: "Oper"; readonly op: "+" | "-" | "*" | "/" }
  | { readonly kind: "OpenParen" }
  | { readonly kind: "CloseParen" }

const tok = Parser.alt(
  Ascii.decUint.pipe(Parser.map((value): Tok => ({ kind: "Value", value }))),
  Token.oneOf("+-*/").pipe(Parser.map((op): Tok => ({ kind: "Oper", op: op as "+" | "-" | "*" | "/" }))),
  Token.literal("(").pipe(Parser.as<Tok>({ kind: "OpenParen" })),
  Token.literal(")").pipe(Parser.as<Tok>({ kind: "CloseParen" }))
)

/** The lexer: a string to an array of tokens. */
export const lex: Parser.Parser<Array<Tok>, string> = Parser.preceded(
  Ascii.multispace0,
  Parser.repeat(Parser.terminated(tok, Ascii.multispace0))
)

type Tokens = ReadonlyArray<Tok>

const kind = <K extends Tok["kind"]>(k: K) =>
  Token.oneOf<Tokens>((t) => t.kind === k).pipe(
    Parser.map((t) => t as Extract<Tok, { kind: K }>),
    Parser.expected(k)
  )

const oper = (ops: string) =>
  kind("Oper").pipe(
    Parser.filter((t) => ops.includes(t.op)),
    Parser.map((t) => t.op)
  )

const tokFactor: Parser.Parser<number, never, never, Tokens> = Parser.alt(
  kind("Value").pipe(Parser.map((t) => t.value)),
  Parser.delimited(
    kind("OpenParen"),
    Parser.suspend(() => tokens),
    kind("CloseParen")
  )
)

const tokTerm = Parser.separatedFoldl1(tokFactor, oper("*/"), (l, op, r) => (op === "*" ? l * r : l / r))

/** The parser over tokens. */
export const tokens: Parser.Parser<number, never, never, Tokens> = Parser.separatedFoldl1(
  tokTerm,
  oper("+-"),
  (l, op, r) => (op === "+" ? l + r : l - r)
)
