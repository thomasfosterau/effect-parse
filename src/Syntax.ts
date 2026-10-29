/**
 * Concrete syntax trees and incremental parsing, in the spirit of
 * [Tree-sitter](https://tree-sitter.github.io).
 *
 * Mark the rules of a grammar that should appear in the tree with
 * {@link node} (and, optionally, {@link token} and {@link field}). Outside
 * this module the marks change nothing: `Parser.parse` returns the same
 * values, and compiled parsers compile them away. {@link parse} runs the
 * grammar and returns a {@link Tree}: a tree of {@link SyntaxNode}s with
 * spans, parents and siblings, to search by position (`descendantAt`) or walk
 * with a {@link TreeCursor}. Each node also carries the value its parser
 * returned.
 *
 * Like Tree-sitter, a syntax parse always produces a tree. Failures handled
 * by `Parser.resumeAfter` and `Parser.retryAfter` become `ERROR` nodes over
 * the input they skipped, and so does any input after a fatal failure.
 *
 * After an edit, {@link reparse} (or {@link replace}) parses the new input
 * reusing every node of the old tree whose input is unchanged: only the
 * nodes that enclose the edit, or looked at the edited input, are parsed
 * again, and each reused node is stepped over whole.
 *
 * @example
 * ```ts
 * import { Ascii, Parser, Syntax, Token } from "@thomasfosterau/effect-parse"
 *
 * const ws = Ascii.multispace0
 * const number = Syntax.node(Ascii.decInt, "number")
 * const list = Syntax.node(
 *   Parser.delimited(
 *     Token.literal("["),
 *     Parser.separated(Parser.delimited(ws, number, ws), Token.literal(",")),
 *     Token.literal("]")
 *   ),
 *   "list"
 * )
 *
 * const tree = Syntax.parse(list, "[1, 2, 3]")
 * String(tree.root) // "(list (number) (number) (number))"
 * tree.root.descendantAt(4)?.text // "2"
 *
 * const edited = Syntax.replace(tree, 4, 5, "20") // "[1, 20, 3]"
 * edited.root.namedChild(1)?.value // 20
 * edited.reused // 2: only "20" was parsed again
 * ```
 *
 * @since 0.2.0
 */
import * as Str from "effect/String"
import * as Predicate from "effect/Predicate"
import type * as Context from "effect/Context"
import { dual } from "effect/Function"
import * as Option from "effect/Option"
import type { Input, Slice, Source } from "./Input.js"
import { Fail, fromSource } from "./Input.js"
import * as ParseError from "./ParseError.js"
import { nodeOf } from "./internal/node.js"
import * as Stack from "./internal/stack.js"
import type { ErrorInfo, Green, Previous, Segment } from "./internal/syntax.js"
import { absolute, errorKind, SyntaxState } from "./internal/syntax.js"
import type { Parser } from "./Parser.js"
import { described, isParser } from "./Parser.js"

// -----------------------------------------------------------------------------
// Grammar annotations
// -----------------------------------------------------------------------------

const syntaxNode = (self: Parser.Any, kind: string, named: boolean): Parser.Any => {
  const step = self.step
  // Identifies the nodes this parser builds, so a reparse can reuse them
  const key = {}
  return described<unknown, unknown, unknown, Input>(
    (state) => {
      const builder = state.syntax
      return builder === undefined ? step(state) : builder.node(state, step, key, kind, named)
    },
    self.name,
    { _tag: "Syntax", self, kind, named }
  )
}

/**
 * Marks a parser as a rule of the syntax tree: in a {@link parse}, each
 * match becomes a named node of the given kind, spanning the input it
 * consumed, with the nodes built inside it as children and its output as
 * its `value`. Outside {@link parse}, the parser is unchanged.
 *
 * A match that consumes nothing adds no node (as in Tree-sitter, where rules
 * can't match the empty string).
 *
 * For {@link reparse} to reuse a node, its parser's output must depend only
 * on the input from where the node starts: not on services, on state kept
 * in closures, or on absolute offsets (`Parser.location`, `Parser.span`),
 * which are not updated when the node moves. Use the node's `start` and
 * `end` instead.
 *
 * @since 0.2.0
 * @category annotations
 */
export const node: {
  (kind: string): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E, R, I>
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, kind: string): Parser<A, E, R, I>
} = /*#__PURE__*/ dual(
  2,
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, kind: string): Parser<A, E, R, I> =>
    syntaxNode(self, kind, true) as Parser<A, E, R, I>
)

/**
 * Like {@link node}, but builds an *anonymous* node, Tree-sitter's name for
 * punctuation and keywords: anonymous nodes are left out of
 * `namedChildren` and of the tree's printed form. The kind defaults to the
 * literal for a `Token.literal` of a string, and to the parser's name
 * otherwise.
 *
 * @example
 * ```ts
 * import { Syntax, Token } from "@thomasfosterau/effect-parse"
 *
 * const comma = Syntax.token(Token.literal(",")) // kind ","
 * ```
 *
 * @since 0.2.0
 * @category annotations
 */
export const token: {
  (kind?: string): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E, R, I>
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, kind?: string): Parser<A, E, R, I>
} = /*#__PURE__*/ dual(
  (args) => isParser(args[0]),
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, kind?: string): Parser<A, E, R, I> =>
    syntaxNode(self, kind ?? defaultTokenKind(self), false) as Parser<A, E, R, I>
)

const defaultTokenKind = (self: Parser.Any): string => {
  const n = nodeOf(self)
  if (n._tag === "Literal" && Predicate.isString(n.literal) && !n.caseless) return n.literal
  return self.name ?? "token"
}

/**
 * Gives the nodes built by a parser a field name in their parent, like
 * Tree-sitter's `field(name, rule)`: find them with `childByField` and
 * `childrenByField`. Outside {@link parse}, the parser is unchanged.
 *
 * @example
 * ```ts
 * import { Ascii, Parser, Syntax, Token } from "@thomasfosterau/effect-parse"
 *
 * const name = Syntax.node(Ascii.alpha1, "name")
 * const number = Syntax.node(Ascii.decInt, "number")
 * const pair = Syntax.node(
 *   Parser.separatedPair(Syntax.field(name, "key"), Token.literal("="), Syntax.field(number, "value")),
 *   "pair"
 * )
 * Syntax.parse(pair, "x=1").root.childByField("value")?.value // 1
 * ```
 *
 * @since 0.2.0
 * @category annotations
 */
export const field: {
  (name: string): <A, E, R, I extends Input>(self: Parser<A, E, R, I>) => Parser<A, E, R, I>
  <A, E, R, I extends Input>(self: Parser<A, E, R, I>, name: string): Parser<A, E, R, I>
} = /*#__PURE__*/ dual(2, <A, E, R, I extends Input>(self: Parser<A, E, R, I>, name: string): Parser<A, E, R, I> => {
  const step = self.step
  return described<A, E, R, I>(
    (state) => {
      const builder = state.syntax
      return (builder === undefined ? step(state) : builder.field(state, step, name)) as A | typeof Fail
    },
    self.name,
    { _tag: "Syntax", self, kind: undefined, named: false }
  )
})

// -----------------------------------------------------------------------------
// Trees
// -----------------------------------------------------------------------------

/**
 * The kind of the nodes that stand for input that could not be parsed.
 *
 * @since 0.2.0
 * @category models
 */
export const ERROR: "ERROR" = errorKind

/**
 * An edit to an input, as Tree-sitter's `TSInputEdit`: the input
 * `[start, oldEnd)` was replaced by `[start, newEnd)`. Offsets are in the
 * input's units (UTF-16 code units for strings, bytes, elements).
 *
 * @since 0.2.0
 * @category models
 */
export interface Edit {
  readonly start: number
  readonly oldEnd: number
  readonly newEnd: number
}

/**
 * Options for {@link parse}.
 *
 * @since 0.2.0
 * @category models
 */
export interface ParseOptions {
  /**
   * The kind of the root node, when the grammar itself is not a
   * {@link node}. Defaults to `"document"`.
   */
  readonly kind?: string | undefined
  /**
   * For {@link reparse}: how many input units custom parsers may read past
   * the furthest position they move the cursor to or record a failure at,
   * besides one token there. Defaults to 0, which is right for the built-in
   * parsers, and for custom parsers (`Parser.make`) that only read past
   * where they stop to see that the token there doesn't match.
   *
   * A node is reused only when the input its parse looked at is unchanged.
   * Built-in parsers that read further, such as a literal that fails part
   * way or `Token.takeUntil`, record how far they read.
   */
  readonly lookahead?: number | undefined
}

/**
 * Options for {@link parse} with a parser that requires services.
 *
 * @since 0.2.0
 * @category models
 */
export interface ParseOptionsWithContext<R> extends ParseOptions {
  readonly context: Context.Context<R>
}

interface Config {
  readonly kind: string
  readonly inner: Parser.Any
  readonly lookahead: number
  readonly context: Context.Context<never> | undefined
}

/**
 * The result of a {@link parse}: a syntax tree over the whole input, the
 * grammar's output, and the errors met on the way.
 *
 * @since 0.2.0
 * @category models
 */
export class Tree<out A, out E = never, I extends Input = string> {
  /** The root node. It always spans the whole input. */
  readonly root: SyntaxNode<I>
  private lines: Array<number> | undefined
  private errorList: ReadonlyArray<ParseError.ParseError<E>> | undefined

  /** @internal */
  constructor(
    /** The input the tree was parsed from. */
    readonly input: I,
    /** The grammar's output: `none` when the parse failed. */
    readonly value: Option.Option<A>,
    /** How many nodes were reused from the previous tree by {@link reparse}. */
    readonly reused: number,
    /** @internal */
    readonly green: Green,
    /** @internal */
    readonly config: Config,
    /** @internal */
    readonly encoding: ParseError.ParseError<never>["encoding"]
  ) {
    this.root = new SyntaxNode(this, green, 0, undefined, 0)
  }

  /**
   * Every error of the parse, in input order: the failures recovered by
   * `Parser.resumeAfter` and `Parser.retryAfter`, then the fatal one, if
   * the parse failed. Each one belongs to an `ERROR` node.
   */
  get errors(): ReadonlyArray<ParseError.ParseError<E>> {
    if (this.errorList === undefined) {
      const out: Array<ParseError.ParseError<E>> = []
      const visit = (green: Green, start: number) => {
        if (!green.hasError) return
        if (green.error !== undefined) out.push(this.toError(green.error, start))
        for (let i = 0; i < green.children.length; i++) visit(green.children[i], start + green.offsets[i])
      }
      visit(this.green, 0)
      this.errorList = out
    }
    return this.errorList
  }

  /** Whether the tree has any `ERROR` node. */
  get hasErrors(): boolean {
    return this.green.hasError
  }

  /** The smallest node containing `[start, end)` (see {@link SyntaxNode.descendantAt}). */
  descendantAt(start: number, end?: number): SyntaxNode<I> {
    return this.root.descendantAt(start, end)
  }

  /** A cursor at the root. */
  walk(): TreeCursor<I> {
    return new TreeCursor(this.root)
  }

  /**
   * The 1-based line and column (in code points) of an offset, as in
   * `ParseError`. Lines of a string input are indexed once, so lookups take
   * logarithmic time.
   */
  lineColumn(offset: number): ParseError.LineColumn {
    const input = this.input
    if (!Predicate.isString(input)) return ParseError.lineColumn(input, offset, this.encoding)
    let lines = this.lines
    if (lines === undefined) {
      lines = [0]
      for (let i = input.indexOf("\n"); i >= 0; i = input.indexOf("\n", i + 1)) lines.push(i + 1)
      this.lines = lines
    }
    const at = Math.max(0, Math.min(offset, input.length))
    let lo = 0
    let hi = lines.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lines[mid] <= at) lo = mid
      else hi = mid - 1
    }
    const lineStart = lines[lo]
    return { line: lo + 1, column: ParseError.lineColumn(input.slice(lineStart, at), at - lineStart).column }
  }

  /** The root's S-expression (see {@link SyntaxNode.toString}). */
  toString(): string {
    return this.root.toString()
  }

  /** @internal */
  toError(error: ErrorInfo, start: number): ParseError.ParseError<E> {
    return ParseError.fromFailure<E>(this.input, absolute(error.failure, start), error.mode, this.encoding)
  }
}

/**
 * A node of a syntax tree: its kind, span and value, and its place in the
 * tree. Nodes are views built on demand; two views of the same node are
 * different objects but have the same `start`, `end` and `kind`.
 *
 * @since 0.2.0
 * @category models
 */
export class SyntaxNode<I extends Input = string> {
  private childList: ReadonlyArray<SyntaxNode<I>> | undefined

  /** @internal */
  constructor(
    /** The tree this node belongs to. */
    readonly tree: Tree<unknown, unknown, I>,
    /** @internal */
    readonly green: Green,
    /** The offset where the node starts. */
    readonly start: number,
    /** The parent node; `undefined` for the root. */
    readonly parent: SyntaxNode<I> | undefined,
    /** The node's index among its parent's children. */
    readonly index: number
  ) {}

  /** The node's kind: the name given to {@link node} or {@link token}, or `"ERROR"`. */
  get kind(): string {
    return this.green.kind
  }

  /** `false` for the anonymous nodes built by {@link token}. */
  get named(): boolean {
    return this.green.named
  }

  /** The field name given by {@link field}, if any. */
  get field(): string | undefined {
    return this.parent?.green.fields?.[this.index]
  }

  /** The offset where the node ends (exclusive). */
  get end(): number {
    return this.start + this.green.width
  }

  /** The number of input units the node spans. */
  get length(): number {
    return this.green.width
  }

  /** The output of the node's parser (`undefined` for `ERROR` nodes, and for a root that failed). */
  get value(): unknown {
    return this.green.value
  }

  /** The input the node spans. */
  get text(): Slice<I> {
    const input = this.tree.input as any
    return input instanceof Uint8Array
      ? (input.subarray(this.start, this.end) as any)
      : input.slice(this.start, this.end)
  }

  /** Whether this is an `ERROR` node. */
  get isError(): boolean {
    return this.green.error !== undefined
  }

  /** Whether this node or a descendant is an `ERROR` node. */
  get hasError(): boolean {
    return this.green.hasError
  }

  /** For an `ERROR` node, the error it stands for. */
  get error(): ParseError.ParseError<unknown> | undefined {
    const error = this.green.error
    return error === undefined ? undefined : this.tree.toError(error, this.start)
  }

  /** The child nodes, named and anonymous, in input order. */
  get children(): ReadonlyArray<SyntaxNode<I>> {
    if (this.childList === undefined) {
      const green = this.green
      const out = new Array<SyntaxNode<I>>(green.children.length)
      for (let i = 0; i < out.length; i++) out[i] = this.makeChild(i)
      this.childList = out
    }
    return this.childList
  }

  /** The number of children. */
  get childCount(): number {
    return this.green.children.length
  }

  /** The child at `index` (negative indices count from the end). */
  child(index: number): SyntaxNode<I> | undefined {
    const n = this.green.children.length
    const i = index < 0 ? n + index : index
    return i >= 0 && i < n ? this.children[i] : undefined
  }

  /** The named children. */
  get namedChildren(): ReadonlyArray<SyntaxNode<I>> {
    return this.children.filter((c) => c.named)
  }

  /** The named child at `index`. */
  namedChild(index: number): SyntaxNode<I> | undefined {
    return this.namedChildren[index]
  }

  /** The first child with the given field name. */
  childByField(name: string): SyntaxNode<I> | undefined {
    const fields = this.green.fields
    if (fields === undefined) return undefined
    const i = fields.indexOf(name)
    return i < 0 ? undefined : this.children[i]
  }

  /** The children with the given field name. */
  childrenByField(name: string): ReadonlyArray<SyntaxNode<I>> {
    const fields = this.green.fields
    if (fields === undefined) return []
    return this.children.filter((_, i) => fields[i] === name)
  }

  /** The next sibling, named or anonymous. */
  get nextSibling(): SyntaxNode<I> | undefined {
    return this.parent?.children[this.index + 1]
  }

  /** The previous sibling, named or anonymous. */
  get previousSibling(): SyntaxNode<I> | undefined {
    return this.index > 0 ? this.parent?.children[this.index - 1] : undefined
  }

  /** The next named sibling. */
  get nextNamedSibling(): SyntaxNode<I> | undefined {
    const siblings = this.parent?.children
    if (siblings === undefined) return undefined
    for (let i = this.index + 1; i < siblings.length; i++) if (siblings[i].named) return siblings[i]
    return undefined
  }

  /** The previous named sibling. */
  get previousNamedSibling(): SyntaxNode<I> | undefined {
    const siblings = this.parent?.children
    if (siblings === undefined) return undefined
    for (let i = this.index - 1; i >= 0; i--) if (siblings[i].named) return siblings[i]
    return undefined
  }

  /**
   * The index of the child containing the input unit at `offset`, or -1.
   * Takes logarithmic time.
   */
  childIndexAt(offset: number): number {
    const green = this.green
    const offsets = green.offsets
    const rel = offset - this.start
    let lo = 0
    let hi = offsets.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid] <= rel) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    // Skip back over empty `ERROR` nodes at `offset`
    while (found >= 0 && green.children[found].width === 0 && offsets[found] === rel) found--
    return found >= 0 && rel < offsets[found] + green.children[found].width ? found : -1
  }

  /** The child containing the input unit at `offset`. */
  childAt(offset: number): SyntaxNode<I> | undefined {
    const i = this.childIndexAt(offset)
    return i < 0 ? undefined : this.children[i]
  }

  /**
   * The smallest node, this one or a descendant, that contains
   * `[start, end)` (Tree-sitter's `descendant_for_byte_range`). With only
   * `start`, the deepest node containing the input unit at `start`. Takes
   * time proportional to the depth of the tree times the logarithm of the
   * number of children.
   */
  descendantAt(start: number, end: number = start + 1): SyntaxNode<I> {
    return descendantOf(this, start, end)
  }

  /** Like {@link descendantAt}, but only stops at named nodes. */
  namedDescendantAt(start: number, end: number = start + 1): SyntaxNode<I> {
    let node: SyntaxNode<I> = this.descendantAt(start, end)
    // Every node below `this` has a parent, so the walk stops at `this` at the latest
    while (!node.named && node !== this) node = node.parent ?? this
    return node
  }

  /** This node and its descendants, in pre-order. */
  *descendants(): Generator<SyntaxNode<I>, void, undefined> {
    const cursor = this.walk()
    while (true) {
      yield cursor.node
      if (cursor.gotoFirstChild()) continue
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return
      }
    }
  }

  /** The descendants of the given kind, in pre-order. */
  *descendantsOfKind(kind: string): Generator<SyntaxNode<I>, void, undefined> {
    for (const n of this.descendants()) if (n.kind === kind) yield n
  }

  /** A cursor at this node, which cannot move above it. */
  walk(): TreeCursor<I> {
    return new TreeCursor(this)
  }

  /**
   * The node as an S-expression of its named descendants, with field
   * names, as Tree-sitter prints it: `(pair key: (name) value: (number))`.
   */
  toString(): string {
    let out = ""
    const visit = (green: Green, field: string | undefined) => {
      if (green.named || green === this.green) {
        if (Str.isNonEmpty(out)) out += " "
        if (field !== undefined) out += `${field}: `
        out += `(${green.kind}`
        for (let i = 0; i < green.children.length; i++) visit(green.children[i], green.fields?.[i])
        out += ")"
      } else {
        for (let i = 0; i < green.children.length; i++) visit(green.children[i], green.fields?.[i])
      }
    }
    visit(this.green, this.field)
    return out
  }

  toJSON(): unknown {
    return { kind: this.kind, start: this.start, end: this.end }
  }

  private makeChild(i: number): SyntaxNode<I> {
    const green = this.green
    return new SyntaxNode(this.tree, green.children[i], this.start + green.offsets[i], this, i)
  }
}

/** The smallest node, `root` or a descendant, that contains `[start, end)` (see `SyntaxNode.descendantAt`). */
const descendantOf = <I extends Input>(root: SyntaxNode<I>, start: number, end: number): SyntaxNode<I> => {
  let node = root
  while (true) {
    const i = node.childIndexAt(start)
    if (i < 0) return node
    const child = node.children[i]
    if (end > child.end) return node
    node = child
  }
}

/**
 * A cursor for walking a tree, as Tree-sitter's `TreeCursor`. It starts at
 * a node and cannot move above it.
 *
 * @since 0.2.0
 * @category models
 */
export class TreeCursor<I extends Input = string> {
  private current: SyntaxNode<I>
  private depth = 0

  /** @internal */
  constructor(node: SyntaxNode<I>) {
    this.current = node
  }

  /** The node at the cursor. */
  get node(): SyntaxNode<I> {
    return this.current
  }

  /** The field name of the node at the cursor, if any. */
  get field(): string | undefined {
    return this.depth === 0 ? undefined : this.current.field
  }

  /** Moves to the first child; `false` if there is none. */
  gotoFirstChild(): boolean {
    return this.goto(this.current.child(0))
  }

  /** Moves to the last child; `false` if there is none. */
  gotoLastChild(): boolean {
    return this.goto(this.current.child(-1))
  }

  /** Moves to the child containing the input unit at `offset`; `false` if there is none. */
  gotoFirstChildForOffset(offset: number): boolean {
    return this.goto(this.current.childAt(offset))
  }

  /** Moves to the next sibling; `false` if there is none. */
  gotoNextSibling(): boolean {
    if (this.depth === 0) return false
    const next = this.current.nextSibling
    if (next === undefined) return false
    this.current = next
    return true
  }

  /** Moves to the previous sibling; `false` if there is none. */
  gotoPreviousSibling(): boolean {
    if (this.depth === 0) return false
    const previous = this.current.previousSibling
    if (previous === undefined) return false
    this.current = previous
    return true
  }

  /** Moves to the parent; `false` at the node the cursor started at. */
  gotoParent(): boolean {
    const parent = this.current.parent
    if (this.depth === 0 || parent === undefined) return false
    this.current = parent
    this.depth--
    return true
  }

  /** Moves to the deepest node containing the input unit at `offset`. */
  gotoDescendantAt(offset: number): void {
    while (this.gotoFirstChildForOffset(offset)) {
      // descend
    }
  }

  /** Starts again at `node`. */
  reset(node: SyntaxNode<I>): void {
    this.current = node
    this.depth = 0
  }

  private goto(node: SyntaxNode<I> | undefined): boolean {
    if (node === undefined) return false
    this.current = node
    this.depth++
    return true
  }
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

const expectedEof = ["end of input"]

const run = <A, E, I extends Input>(config: Config, input: I, previous: Previous | undefined): Tree<A, E, I> => {
  const state = new SyntaxState<I>(input, { context: config.context }, previous)
  const a = Stack.run(config.inner.step, state)
  // Text parsers record the encoding when they fail, which they may have done inside reused nodes
  if (state.encoding === undefined && previous !== undefined) state.encoding = previous.encoding
  let fatal: ErrorInfo | undefined
  let value: Option.Option<A> = Option.none()
  if (a === Fail) {
    fatal = { failure: state.reportedFailure(), mode: state.mode }
  } else if (state.pos < state.end) {
    state.backtrack("Eof", expectedEof)
    fatal = { failure: state.reportedFailure(), mode: "Backtrack" }
  } else {
    value = Option.some(a as A)
  }
  const green = state.finish(config.kind, Option.getOrUndefined(value), fatal, state.pos)
  return new Tree<A, E, I>(input, value, state.reused, green, config, state.encoding)
}

/**
 * Parses an input into a syntax {@link Tree}. The grammar's output is the
 * tree's `value`, and its {@link node}s are the tree's nodes. When the
 * grammar is itself a {@link node}, that node is the root; otherwise the
 * root is a node of kind `options.kind` (by default `"document"`).
 *
 * The parse never fails: recovered failures (see `Parser.resumeAfter`), a
 * fatal failure and unparsed input at the end all become `ERROR` nodes, and
 * are listed in `tree.errors`. The parse is interpreted, never compiled.
 *
 * @since 0.2.0
 * @category parsing
 */
export const parse: {
  <A, E, I extends Input>(
    grammar: Parser<A, E, never, I>,
    input: NoInfer<Source<I>>,
    options?: ParseOptions
  ): Tree<A, E, I>
  <A, E, R, I extends Input>(
    grammar: Parser<A, E, R, I>,
    input: NoInfer<Source<I>>,
    options: ParseOptionsWithContext<R>
  ): Tree<A, E, I>
} = <A, E, R, I extends Input>(
  grammar: Parser<A, E, R, I>,
  input: I | Source<I>,
  options?: ParseOptions & { readonly context?: Context.Context<R> }
): Tree<A, E, I> => {
  const n = nodeOf(grammar)
  const isRoot = n._tag === "Syntax" && n.kind !== undefined && n.named
  const config: Config = {
    kind: isRoot ? n.kind : (options?.kind ?? "document"),
    inner: isRoot ? (n.self as Parser.Any) : grammar,
    lookahead: options?.lookahead ?? 0,
    context: options?.context as Context.Context<never> | undefined
  }
  return run(config, fromSource(input as Input) as I, undefined)
}

/**
 * Parses the new version of a tree's input, reusing the nodes of the tree
 * that the edits leave unchanged (Tree-sitter's `ts_tree_edit` followed by
 * `ts_parser_parse` with the old tree). The result is the tree a fresh
 * {@link parse} of `input` would build, but only the parts of the tree
 * around the edits are parsed again. `tree.reused` says how many nodes were
 * reused.
 *
 * `edits` describe how the old input became the new one, applied in order,
 * each in the coordinates of the input as the previous edits left it. When
 * they are omitted, the edit is found by comparing the inputs (their common
 * prefix and suffix), which takes time linear in their length but much less
 * than parsing.
 *
 * Errors in the new tree are those a fresh parse reports, except that an
 * error just after a reused node may list fewer expected alternatives.
 *
 * @example
 * ```ts
 * import { Ascii, Syntax } from "@thomasfosterau/effect-parse"
 *
 * const number = Syntax.node(Ascii.decInt, "number")
 * const tree = Syntax.parse(number, "12")
 * Syntax.reparse(tree, "123", [{ start: 2, oldEnd: 2, newEnd: 3 }]).root.value // 123
 * ```
 *
 * @since 0.2.0
 * @category parsing
 */
export const reparse = <A, E, I extends Input>(
  tree: Tree<A, E, I>,
  input: NoInfer<Source<I>>,
  edits?: Edit | ReadonlyArray<Edit>
): Tree<A, E, I> => {
  const next = fromSource(input as Input) as I
  const list =
    edits === undefined
      ? diffList(tree.input, next)
      : "start" in edits
        ? [edits as Edit]
        : (edits as ReadonlyArray<Edit>)
  const previous: Previous = {
    root: tree.green,
    oldLength: tree.input.length,
    newLength: next.length,
    segments: segmentsOf(tree.input.length, next.length, list),
    input: tree.input,
    extra: tree.config.lookahead,
    encoding: tree.encoding
  }
  return run(tree.config, next, previous)
}

/**
 * Replaces `[start, end)` of a tree's string input with `text` and parses
 * the result incrementally (see {@link reparse}).
 *
 * @since 0.2.0
 * @category parsing
 */
export const replace = <A, E>(
  tree: Tree<A, E, string>,
  start: number,
  end: number,
  text: string
): Tree<A, E, string> => {
  const input = tree.input
  if (start < 0 || end < start || end > input.length) {
    throw new RangeError(`invalid range [${start}, ${end}) of an input of length ${input.length}`)
  }
  return reparse(tree, input.slice(0, start) + text + input.slice(end), {
    start,
    oldEnd: end,
    newEnd: start + text.length
  })
}

/**
 * Finds the edit that turns `before` into `after`: the part between their
 * longest common prefix and suffix. `undefined` when they are equal.
 *
 * @since 0.2.0
 * @category parsing
 */
export const diff = <I extends Input>(before: I, after: I): Edit | undefined => {
  const a = before as any
  const b = after as any
  const at = Predicate.isString(a) ? (s: string, i: number) => s.charCodeAt(i) : (s: any, i: number) => s[i]
  const max = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < max && at(a, prefix) === at(b, prefix)) prefix++
  if (prefix === a.length && prefix === b.length) return undefined
  let suffix = 0
  while (suffix < max - prefix && at(a, a.length - 1 - suffix) === at(b, b.length - 1 - suffix)) suffix++
  return { start: prefix, oldEnd: a.length - suffix, newEnd: b.length - suffix }
}

const diffList = (before: Input, after: Input): ReadonlyArray<Edit> => {
  const edit = diff(before, after)
  return edit === undefined ? [] : [edit]
}

/** The stretches of the new input copied unchanged from the old one. */
const segmentsOf = (oldLength: number, newLength: number, edits: ReadonlyArray<Edit>): Array<Segment> => {
  let segments: Array<Segment> = oldLength > 0 ? [{ newStart: 0, oldStart: 0, length: oldLength }] : []
  let length = oldLength
  for (const { newEnd, oldEnd, start } of edits) {
    if (!(start >= 0 && oldEnd >= start && oldEnd <= length && newEnd >= start)) {
      throw new RangeError(
        `invalid edit { start: ${start}, oldEnd: ${oldEnd}, newEnd: ${newEnd} } of an input of length ${length}`
      )
    }
    const delta = newEnd - oldEnd
    const out: Array<Segment> = []
    for (const s of segments) {
      const end = s.newStart + s.length
      if (s.newStart < start) {
        out.push({ newStart: s.newStart, oldStart: s.oldStart, length: Math.min(end, start) - s.newStart })
      }
      if (end > oldEnd) {
        const from = Math.max(s.newStart, oldEnd)
        out.push({ newStart: from + delta, oldStart: s.oldStart + (from - s.newStart), length: end - from })
      }
    }
    segments = out
    length += delta
  }
  if (length !== newLength) {
    throw new RangeError(`the edits give an input of length ${length}, but the new input has length ${newLength}`)
  }
  return segments
}
