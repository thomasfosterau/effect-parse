import * as Record from "effect/Record"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { assert, describe, expect, it } from "vite-plus/test"
import { Ascii, Parser, ParserSchema, Token } from "../src/index.js"
import { mutations } from "./generators.js"
import { expectFailure, expectSuccess } from "./utils.js"

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result))
  return result.success
}

const { annotate, toParser, toPrinter } = ParserSchema

/** The text `schema`'s printer writes for `value`, failing the test if it cannot. */
const printed = <S extends Schema.Codec<any, any>>(schema: S, value: S["Type"]): string =>
  success(toPrinter(schema)(value))

/** Why `schema`'s printer cannot write `value`. */
const unprinted = <S extends Schema.Codec<any, any>>(schema: S, value: S["Type"]): string => {
  const result = toPrinter(schema)(value)
  assert(Result.isFailure(result), `expected a failure, got ${Result.isSuccess(result) ? result.success : ""}`)
  return result.failure.message
}

/** Checks that every value parsed from `inputs` prints as text that parses back to it. */
const roundTrips = <S extends Schema.Codec<any, any>>(schema: S, inputs: ReadonlyArray<string>): number => {
  const parser = toParser(schema)
  const print = toPrinter(schema)
  const values = inputs.map((input) => Parser.parse(parser, input)).filter(Result.isSuccess)
  values.forEach(({ success: value }) => {
    const text = success(print(value))
    expect(success(Parser.parse(parser, text)), text).toEqual(value)
  })
  return values.length
}

describe("ParserSchema.toParser", () => {
  describe("primitives", () => {
    it("parses numbers, integers and bigints", () => {
      expectSuccess(toParser(Schema.Number), "-1.5e3", -1500)
      expectSuccess(toParser(Schema.Int), "42", 42)
      expectSuccess(toParser(Schema.Int.check(Schema.isInt32())), "-7", -7)
      // `isInt32` restricts to integers inside a filter group
      expectSuccess(
        toParser(Schema.Tuple([Schema.Number.check(Schema.isInt32()), Schema.Int]).pipe(annotate({ separator: "." }))),
        "1.2",
        [1, 2]
      )
      expectSuccess(toParser(Schema.BigInt), "123456789012345678901", 123456789012345678901n)
    })

    it("reads an integer schema as an integer", () => {
      // `Ascii.float` would take "1.2" whole
      const Version = Schema.Tuple([Schema.Int, Schema.Int]).pipe(annotate({ separator: "." }))
      expectSuccess(toParser(Version), "1.2", [1, 2])
    })

    it("parses booleans, null, undefined and literals", () => {
      expectSuccess(toParser(Schema.Boolean), "false", false)
      expectSuccess(toParser(Schema.Null), "null", null)
      expectSuccess(toParser(Schema.Undefined), "", undefined)
      expectSuccess(toParser(Schema.Void), "", undefined)
      expectSuccess(toParser(Schema.Literal("GET")), "GET", "GET")
      expectSuccess(toParser(Schema.Literal(7)), "7", 7)
      expectSuccess(toParser(Schema.Literal(true)), "true", true)
    })

    it("parses enums by value", () => {
      enum Level {
        Low = "lo",
        Lower = "lower",
        High = 2
      }
      const p = toParser(Schema.Enum(Level))
      expectSuccess(p, "lo", Level.Low)
      expectSuccess(p, "lower", Level.Lower)
      expectSuccess(p, "2", Level.High)
    })

    it("takes an unannotated string to the end at the top level", () => {
      expectSuccess(toParser(Schema.String), "a, b; c", "a, b; c")
      expectFailure(toParser(Schema.String), "")
    })

    it("parses template literals as their text", () => {
      const Id = Schema.TemplateLiteral(["user-", Schema.String, "-", Schema.Number])
      expectSuccess(toParser(Id), "user-ann-12", "user-ann-12")
      expectSuccess(toParser(Id), "user--12", "user--12")
      expectFailure(toParser(Id), "user-ann")
    })

    it("cannot parse never", () => {
      expectFailure(toParser(Schema.Never), "")
    })
  })

  describe("structs and tuples", () => {
    const Point = Schema.Struct({ x: Schema.Int, y: Schema.Int }).pipe(
      annotate({ prefix: "(", separator: ",", suffix: ")" })
    )

    it("parses fields in order between separators", () => {
      expectSuccess(toParser(Point), "(1,-2)", { x: 1, y: -2 })
      expectFailure(toParser(Point), "(1,-2")
      expectFailure(toParser(Point), "(1;-2)")
    })

    it("stops an unannotated string at the separator", () => {
      const Person = Schema.Struct({ name: Schema.String, city: Schema.String, age: Schema.Int }).pipe(
        annotate({ separator: ";" })
      )
      expectSuccess(toParser(Person), "Ann Lee;Paris, FR;34", { name: "Ann Lee", city: "Paris, FR", age: 34 })
    })

    it("stops an unannotated string at the suffix", () => {
      const Quoted = Schema.String.pipe(annotate({ prefix: '"', suffix: '"' }))
      expectSuccess(toParser(Schema.Tuple([Quoted, Quoted])), '"a b""c"', ["a b", "c"])
    })

    it("leaves out a missing optional field with its separator", () => {
      const S = Schema.Struct({
        a: Schema.optionalKey(Schema.Int),
        b: Schema.Int,
        c: Schema.optionalKey(Schema.Int),
        d: Schema.optionalKey(Schema.Int)
      }).pipe(annotate({ separator: "," }))
      const p = toParser(S)
      expectSuccess(p, "1,2,3,4", { a: 1, b: 2, c: 3, d: 4 })
      expectSuccess(p, "2", { b: 2 })
      expectSuccess(p, "1,2", { a: 1, b: 2 })
      // An optional field is tried before it is left out
      expectSuccess(p, "2,3", { a: 2, b: 3 })
      expectSuccess(p, "1,2,3", { a: 1, b: 2, c: 3 })
      expectFailure(p, ",2")
    })

    it("parses tuples with optional elements and a rest", () => {
      const T = Schema.TupleWithRest(Schema.Tuple([Schema.Literal("v"), Schema.optionalKey(Schema.Int)]), [
        Schema.Boolean
      ]).pipe(annotate({ separator: " " }))
      const p = toParser(T)
      expectSuccess(p, "v", ["v"])
      expectSuccess(p, "v 1", ["v", 1])
      expectSuccess(p, "v 1 true false", ["v", 1, true, false])
    })

    it("allows whitespace around the text a grammar writes", () => {
      const p = toParser(
        Schema.Struct({ name: Schema.String, age: Schema.Int }).pipe(
          annotate({ prefix: "{", separator: ",", suffix: "}", whitespace: true })
        )
      )
      expectSuccess(p, " { Ann Lee , 34 } ", { name: "Ann Lee", age: 34 })
      expectSuccess(p, "{Ann,34}", { name: "Ann", age: 34 })
      // Whitespace around an unannotated string is trimmed even where no grammar text precedes it,
      // and does not count as the string
      const spaced = toParser(
        Schema.Tuple([Schema.String, Schema.Int]).pipe(annotate({ separator: ",", whitespace: true }))
      )
      expectSuccess(spaced, " a ,1", ["a", 1])
      expectFailure(spaced, "  ,1")
    })
  })

  describe("arrays", () => {
    it("parses elements between separators", () => {
      const p = toParser(Schema.Array(Schema.Int).pipe(annotate({ prefix: "[", separator: ",", suffix: "]" })))
      expectSuccess(p, "[]", [])
      expectSuccess(p, "[1,2,3]", [1, 2, 3])
      expectFailure(p, "[1,2,]")
    })

    it("parses non-empty arrays and arrays without separators", () => {
      expectSuccess(toParser(Schema.NonEmptyArray(Schema.Int).pipe(annotate({ separator: "|" }))), "1|2|3", [1, 2, 3])
      expectFailure(toParser(Schema.NonEmptyArray(Schema.Int).pipe(annotate({ separator: "|" }))), "")
      expectSuccess(toParser(Schema.Array(Schema.Literals(["a", "b"]))), "abba", ["a", "b", "b", "a"])
    })

    it("runs length checks", () => {
      const p = toParser(
        Schema.Array(Schema.Int).pipe(Schema.check(Schema.isMaxLength(2)), annotate({ separator: "," }))
      )
      expectSuccess(p, "1,2", [1, 2])
      const e = expectFailure(p, "1,2,3")
      expect(e.cause).toBeInstanceOf(Schema.SchemaError)
    })
  })

  describe("keyed", () => {
    it("parses struct fields as key-value pairs in any order", () => {
      const Config = Schema.Struct({
        host: Schema.String,
        port: Schema.Int,
        debug: Schema.optionalKey(Schema.Boolean)
      }).pipe(annotate({ separator: ";", keySeparator: "=" }))
      const p = toParser(Config)
      expectSuccess(p, "host=example.com;port=80", { host: "example.com", port: 80 })
      expectSuccess(p, "port=80;debug=true;host=a", { host: "a", port: 80, debug: true })
      // A missing field is expected where its entry could have been
      const missing = expectFailure(p, "host=a")
      expect(missing.offset).toBe(6)
      expect(missing.message).toContain('"port="')
      // A bad entry is reported, rather than the field it would have given
      const bad = expectFailure(p, "host=a;port=x")
      expect(bad.offset).toBe(12)
      expect(bad.message).toContain('expected one of "+-" or digit, found "x"')
      expect(expectFailure(p, "port=1;port=2;host=a").message).toContain("Duplicate key")
    })

    it("parses records", () => {
      const p = toParser(
        Schema.Record(Schema.String, Schema.Int).pipe(annotate({ separator: ",", keySeparator: ":", whitespace: true }))
      )
      expectSuccess(p, "a: 1, b c : 2", { a: 1, "b c": 2 })
      expectSuccess(p, "", {})
      expect(Record.keys(success(Parser.parse(p, "__proto__:1")))).toEqual(["__proto__"])
    })

    it("parses records with known keys", () => {
      const S = Schema.StructWithRest(Schema.Struct({ id: Schema.Literal("x") }), [
        Schema.Record(Schema.String, Schema.String)
      ]).pipe(annotate({ separator: "&", keySeparator: "=" }))
      expectSuccess(toParser(S), "a=1&id=x&b=2", { id: "x", a: "1", b: "2" })
    })

    it("parses entries without a separator", () => {
      const p = toParser(Schema.Struct({ a: Schema.Int, b: Schema.Int }).pipe(annotate({ keySeparator: ":" })))
      expectSuccess(p, "b:2a:1", { a: 1, b: 2 })
    })

    it("needs a key separator for a record", () => {
      expect(() => toParser(Schema.Record(Schema.String, Schema.Int))).toThrow(/keySeparator/)
    })
  })

  describe("unions and recursion", () => {
    it("tries members in order", () => {
      const p = toParser(Schema.Union([Schema.Int, Schema.Boolean, Schema.Null]))
      expectSuccess(p, "12", 12)
      expectSuccess(p, "true", true)
      expectSuccess(p, "null", null)
      expect(expectFailure(p, "x").message).toContain("expected")
    })

    it("tries literals longest first", () => {
      const p = toParser(Schema.Literals(["<", "<=", "<<="]))
      expectSuccess(p, "<<=", "<<=")
      expectSuccess(p, "<=", "<=")
      expectSuccess(p, "<", "<")
    })

    it("parses recursive schemas", () => {
      interface Tree {
        readonly value: number
        readonly children: ReadonlyArray<Tree>
      }
      const Tree: Schema.Codec<Tree> = Schema.Struct({
        value: Schema.Int,
        children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)).pipe(
          annotate({ prefix: "(", separator: " ", suffix: ")" })
        )
      })
      expectSuccess(toParser(Tree), "1(2() 3(4()))", {
        value: 1,
        children: [
          { value: 2, children: [] },
          { value: 3, children: [{ value: 4, children: [] }] }
        ]
      })
    })
  })

  describe("annotations", () => {
    it("uses an annotated parser, then the schema's checks", () => {
      const Word = Schema.String.pipe(annotate(Ascii.alpha1), Schema.check(Schema.isMaxLength(3)))
      const p = toParser(Schema.Tuple([Word, Word]).pipe(annotate({ separator: " " })))
      expectSuccess(p, "ab cde", ["ab", "cde"])
      expect(expectFailure(p, "ab cdef").cause).toBeInstanceOf(Schema.SchemaError)
    })

    it("reads the annotation from a checked schema", () => {
      const Hex = Schema.Int.pipe(annotate(Ascii.hexUint), Schema.check(Schema.isLessThan(256)))
      expectSuccess(toParser(Hex), "ff", 255)
      expectFailure(toParser(Hex), "100")
    })

    it("validates an annotated parser's output against the schema's type", () => {
      // `annotate` rejects this parser at compile time; `.annotate` does not
      const Yes = Schema.Literal("yes").annotate({
        [ParserSchema.annotationKey]: Token.takeWhile(Ascii.isAlpha, { min: 1 })
      })
      expectSuccess(toParser(Yes), "yes", "yes")
      expect(expectFailure(toParser(Yes), "no").cause).toBeInstanceOf(Schema.SchemaError)
    })

    it("turns an annotated parser's causes into schema errors", () => {
      const Even = Schema.Int.pipe(
        annotate(Parser.tryMap(Ascii.decUint, (n) => (n % 2 === 0 ? Result.succeed(n) : Result.fail("odd"))))
      )
      const e = expectFailure(toParser(Even), "3")
      expect(e.cause).toBeInstanceOf(Schema.SchemaError)
      expect(e.message).toContain("odd")
    })

    it("accepts a grammar with a parser", () => {
      const p = toParser(Schema.Number.pipe(annotate({ parser: Ascii.hexUint, prefix: "0x" })))
      expectSuccess(p, "0x1f", 31)
    })

    it("reports the identifier or expected annotation", () => {
      const Port = Schema.Int.annotate({ identifier: "Port" })
      expect(expectFailure(toParser(Port), "x").message).toContain("expected Port")
      expect(expectFailure(toParser(Schema.Number.annotate({ expected: "a size" })), "x").message).toContain(
        "expected a size"
      )
      // A check's `expected` annotation is not about the text
      expect(expectFailure(toParser(Schema.Int.check(Schema.isGreaterThan(0))), "x").message).not.toContain("greater")
    })

    it("passes an annotated parser's schema errors through", () => {
      const error = new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: "nope" }))
      const p = toParser(Schema.Int.pipe(annotate(Parser.fail(error))))
      expect(expectFailure(p, "").cause).toBe(error)
      const other = toParser(Schema.Int.pipe(annotate(Parser.fail({ message: "boom" }))))
      expect(expectFailure(other, "").message).toContain("boom")
    })

    it("throws for a schema it cannot derive", () => {
      expect(() => toParser(Schema.Option(Schema.Int))).toThrow(/Declaration at \[\]/)
      expect(() => toParser(Schema.TupleWithRest(Schema.Tuple([]), [Schema.Int, Schema.Int]))).toThrow(/Arrays/)
      expect(() => toParser(Schema.Struct({ a: Schema.Unknown }))).toThrow(/Unknown at \[a\]/)
      expect(() => toParser(Schema.Struct({ a: Schema.Unknown.pipe(annotate(Ascii.digit1)) }))).not.toThrow()
    })
  })

  describe("transformations", () => {
    it("parses the encoded side and decodes it", () => {
      const p = toParser(Schema.Tuple([Schema.NumberFromString, Schema.Int]).pipe(annotate({ separator: ":" })))
      expectSuccess(p, "1.5:2", [1.5, 2])
    })

    it("runs a chain of transformations in order", () => {
      // Two links on one node: trim, then NumberFromString
      const Padded = Schema.String.pipe(Schema.decodeTo(Schema.NumberFromString, SchemaTransformation.trim()))
      expectSuccess(toParser(Padded), "  12 ", 12)
    })

    it("decodes classes, applying their grammar to the fields", () => {
      class Point extends Schema.Class<Point, { readonly brand: unique symbol }>("Point")({
        x: Schema.Int,
        y: Schema.Int
      }) {}
      const P = Point.pipe(annotate({ separator: ",", prefix: "<", suffix: ">" }))
      const r = success(Parser.parse(toParser(P), "<1,2>"))
      expect(r).toBeInstanceOf(Point)
      expect(r).toEqual(new Point({ x: 1, y: 2 }))
      expect(expectFailure(toParser(P), "<1>").message).toContain('expected digit or ","')
      expect(expectFailure(toParser(P), "1,2").message).toContain("expected Point")
    })

    it("reports failed checks and transformations with the schema error", () => {
      const p = toParser(Schema.Int.check(Schema.isGreaterThan(0)))
      const e = expectFailure(p, "0")
      expect(e.kind).toBe("Verify")
      expect(e.cause).toBeInstanceOf(Schema.SchemaError)
      expect(e.message).toContain("Expected a value greater than 0")
    })
  })
})

describe("ParserSchema.fromSchema", () => {
  const Pair = ParserSchema.fromSchema(
    Schema.Tuple([Schema.String, Schema.Number]).pipe(annotate({ separator: "=" })),
    { encode: ([key, value]) => `${key}=${value}` }
  )

  it("decodes and encodes", () => {
    expect(Schema.decodeSync(Pair)("width=10")).toEqual(["width", 10])
    expect(Schema.encodeSync(Pair)(["height", 2])).toBe("height=2")
  })

  it("reports parse errors as issues", () => {
    expect(() => Schema.decodeSync(Pair)("width")).toThrow(/expected "="/)
  })

  it("encodes with the derived printer", () => {
    const Point = ParserSchema.fromSchema(
      Schema.Struct({ x: Schema.Int, y: Schema.Int }).pipe(annotate({ prefix: "(", separator: ",", suffix: ")" }))
    )
    expect(Schema.encodeSync(Point)({ x: 1, y: -2 })).toBe("(1,-2)")
    expect(Schema.decodeSync(Point)("(1,-2)")).toEqual({ x: 1, y: -2 })
  })

  it("fails to encode a value its printer cannot write", () => {
    const Pair2 = ParserSchema.fromSchema(Schema.Tuple([Schema.String, Schema.Int]).pipe(annotate({ separator: "=" })))
    expect(() => Schema.encodeSync(Pair2)(["a=b", 1])).toThrow(/containing "="/)
  })

  it("refuses to encode text that reads back as a different value", () => {
    const S = ParserSchema.fromSchema(
      Schema.Struct({ a: Schema.optionalKey(Schema.Int), b: Schema.Int, c: Schema.optionalKey(Schema.Int) }).pipe(
        annotate({ separator: "," })
      )
    )
    expect(Schema.encodeSync(S)({ a: 1, b: 2 })).toBe("1,2")
    // "2,3" reads back as { a: 2, b: 3 }
    expect(() => Schema.encodeSync(S)({ b: 2, c: 3 })).toThrow(/"2,3", which does not read back/)
  })

  it("composes with a token parser", () => {
    const Ident = Schema.String.pipe(annotate(Token.takeWhile(Ascii.isAlpha, { min: 1 })))
    expect(Schema.decodeSync(ParserSchema.fromSchema(Ident))("abc")).toBe("abc")
  })
})

describe("ParserSchema.toPrinter", () => {
  it("prints primitives as they are parsed", () => {
    expect(printed(Schema.Number, -1.5)).toBe("-1.5")
    expect(printed(Schema.Int, 42)).toBe("42")
    expect(printed(Schema.BigInt, 12n)).toBe("12")
    expect(printed(Schema.Boolean, false)).toBe("false")
    expect(printed(Schema.Null, null)).toBe("null")
    expect(printed(Schema.Undefined, undefined)).toBe("")
    expect(printed(Schema.Literals(["<", "<="]), "<=")).toBe("<=")
    expect(printed(Schema.TemplateLiteral(["user-", Schema.Number]), "user-7")).toBe("user-7")
    expect(printed(Schema.String, "a b")).toBe("a b")
  })

  it("prints numbers that read back", () => {
    const p = toParser(Schema.Number)
    ;[0, -0.5, 1e21, 1e-7, Infinity, -Infinity].forEach((n) => {
      expect(success(Parser.parse(p, printed(Schema.Number, n)))).toBe(n)
    })
    expect(Number.isNaN(success(Parser.parse(p, printed(Schema.Number, NaN))))).toBe(true)
  })

  it("prints structs, leaving out missing optional fields with their separators", () => {
    const S = Schema.Struct({
      a: Schema.optionalKey(Schema.Int),
      b: Schema.Int,
      c: Schema.optionalKey(Schema.Int)
    }).pipe(annotate({ prefix: "(", separator: ",", suffix: ")" }))
    expect(printed(S, { a: 1, b: 2, c: 3 })).toBe("(1,2,3)")
    expect(printed(S, { b: 2 })).toBe("(2)")
    expect(printed(S, { b: 2, c: 3 })).toBe("(2,3)")
  })

  it("prints tuples and arrays", () => {
    const T = Schema.TupleWithRest(Schema.Tuple([Schema.Literal("v"), Schema.optionalKey(Schema.Int)]), [
      Schema.Boolean
    ]).pipe(annotate({ separator: " " }))
    expect(printed(T, ["v"])).toBe("v")
    expect(printed(T, ["v", 1, true, false])).toBe("v 1 true false")
    const A = Schema.Array(Schema.Int).pipe(annotate({ prefix: "[", separator: ",", suffix: "]" }))
    expect(printed(A, [])).toBe("[]")
    expect(printed(A, [1, 2])).toBe("[1,2]")
  })

  it("prints keyed structs in declared order, then records", () => {
    const Config = Schema.Struct({ host: Schema.String, port: Schema.Int, debug: Schema.optionalKey(Schema.Boolean) })
    expect(printed(Config.pipe(annotate({ separator: ";", keySeparator: "=" })), { port: 80, host: "a" })).toBe(
      "host=a;port=80"
    )
    const R = Schema.StructWithRest(Schema.Struct({ id: Schema.Literal("x") }), [
      Schema.Record(Schema.String, Schema.String)
    ]).pipe(annotate({ separator: "&", keySeparator: "=" }))
    expect(printed(R, { b: "2", id: "x", a: "1" })).toBe("id=x&b=2&a=1")
  })

  it("prints transformations' encoded side", () => {
    class Point extends Schema.Class<Point, { readonly brand: unique symbol }>("Point")({
      x: Schema.Int,
      y: Schema.Int
    }) {}
    expect(printed(Point.pipe(annotate({ separator: ",", prefix: "<", suffix: ">" })), new Point({ x: 1, y: 2 }))).toBe(
      "<1,2>"
    )
    const Padded = Schema.String.pipe(Schema.decodeTo(Schema.NumberFromString, SchemaTransformation.trim()))
    expect(printed(Padded, 12)).toBe("12")
  })

  it("prints a union's value with the first member it belongs to", () => {
    const U = Schema.Union([Schema.Int, Schema.Boolean, Schema.Array(Schema.Int).pipe(annotate({ separator: "," }))])
    expect(printed(U, true)).toBe("true")
    expect(printed(U, [1, 2])).toBe("1,2")
  })

  it("falls back to the next member that can write the value", () => {
    const Quoted = Schema.String.pipe(
      annotate({
        parser: Parser.delimited(Token.literal('"'), Token.takeTill('"'), Token.literal('"')),
        print: (s) => `"${s}"`
      })
    )
    const row = (member: ReadonlyArray<typeof Schema.String>) =>
      Schema.Tuple([Schema.Union(member), Schema.Int]).pipe(annotate({ separator: ";" }))
    // The plain string cannot hold ";", so the quoted one writes it
    const PlainFirst = row([Schema.String, Quoted])
    expect(printed(PlainFirst, ["a;b", 1])).toBe('"a;b";1')
    expect(printed(PlainFirst, ["a", 1])).toBe("a;1")
    // But the parser takes the plain string `"a` and does not come back to the union,
    // so the text does not read back, and `fromSchema` refuses to encode it
    expectFailure(toParser(PlainFirst), '"a;b";1')
    expect(() => Schema.encodeSync(ParserSchema.fromSchema(PlainFirst))(["a;b", 1])).toThrow(/does not read back/)
    // Quoted first, every value reads back
    const QuotedFirst = row([Quoted, Schema.String])
    expect(printed(QuotedFirst, ["a;b", 1])).toBe('"a;b";1')
    expect(Schema.decodeSync(ParserSchema.fromSchema(QuotedFirst))('"a;b";1')).toEqual(["a;b", 1])
  })

  it("prints recursive schemas", () => {
    interface Tree {
      readonly value: number
      readonly children: ReadonlyArray<Tree>
    }
    const Tree: Schema.Codec<Tree> = Schema.Struct({
      value: Schema.Int,
      children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)).pipe(
        annotate({ prefix: "(", separator: " ", suffix: ")" })
      )
    })
    const tree = { value: 1, children: [{ value: 2, children: [] }] }
    expect(printed(Tree, tree)).toBe("1(2())")
  })

  it("uses an annotation's print", () => {
    const Hex = Schema.Int.pipe(annotate({ parser: Ascii.hexUint, print: (n) => n.toString(16), prefix: "#" }))
    expect(printed(Hex, 255)).toBe("#ff")
    expect(unprinted(Schema.Int.pipe(annotate(Ascii.hexUint)), 255)).toContain("no print")
  })

  it("refuses strings that would not read back", () => {
    const Pair = Schema.Tuple([Schema.String, Schema.String]).pipe(annotate({ separator: ";" }))
    expect(unprinted(Pair, ["a;b", "c"])).toContain('containing ";"')
    expect(unprinted(Pair, ["a;b", "c"])).toContain("[0]")
    expect(unprinted(Pair, ["", "c"])).toContain("empty")
    // The last field may hold the separator: nothing follows it
    expect(printed(Pair, ["a", "b;c"])).toBe("a;b;c")
    const Spaced = Schema.Tuple([Schema.String, Schema.Int]).pipe(annotate({ separator: ",", whitespace: true }))
    expect(unprinted(Spaced, [" a", 1])).toContain("whitespace")
    expect(printed(Spaced, ["a b", 1])).toBe("a b,1")
  })

  it("validates the value", () => {
    expect(unprinted(Schema.Int, 1.5)).toContain("integer")
    // SAFETY: deliberately not of the schema's type, to check that the printer validates it
    expect(unprinted(Schema.Struct({ a: Schema.Int }), {} as never)).toContain("Missing key")
  })

  it("throws for a schema it cannot derive", () => {
    expect(() => toPrinter(Schema.Struct({ a: Schema.Unknown }))).toThrow(/printer for Unknown at \[a\]/)
  })

  it("writes text that parses back as the value", () => {
    const Entry = Schema.Struct({
      name: Schema.String,
      tags: Schema.Array(Schema.Literals(["a", "ab"])).pipe(annotate({ prefix: "[", separator: ",", suffix: "]" })),
      size: Schema.optionalKey(Schema.Int)
    }).pipe(annotate({ separator: ";", whitespace: true }))
    const Doc = Schema.Union([
      Schema.Array(Entry).pipe(annotate({ separator: "|" })),
      Schema.Record(Schema.String, Schema.Int).pipe(annotate({ prefix: "{", separator: ",", keySeparator: "=" }))
    ])
    const docs = ["x;[a,ab];3| y ; [ ] ", "{a=1,b=2}"]
    const inputs = docs.flatMap((doc) => [doc, ...mutations(doc, "xy;[],ab3 |{}=1", 300, 5)])
    expect(roundTrips(Doc, inputs)).toBeGreaterThan(50)
  })
})
