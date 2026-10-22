import * as Record from "effect/Record"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { assert, describe, expect, it } from "vite-plus/test"
import { Ascii, Parser, ParserSchema, Token } from "../src/index.js"
import { expectFailure, expectSuccess } from "./utils.js"

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result))
  return result.success
}

const { annotate, toParser } = ParserSchema

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
      const Yes = Schema.Literal("yes").annotate({ parser: Token.takeWhile(Ascii.isAlpha, { min: 1 }) })
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
      class Point extends Schema.Class<Point>("Point")({ x: Schema.Int, y: Schema.Int }) {}
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
    expect(Schema.decodeUnknownSync(Pair)("width=10")).toEqual(["width", 10])
    expect(Schema.encodeSync(Pair)(["height", 2])).toBe("height=2")
  })

  it("reports parse errors as issues", () => {
    expect(() => Schema.decodeUnknownSync(Pair)("width")).toThrow(/expected "="/)
  })

  it("composes with a token parser", () => {
    const Ident = Schema.String.pipe(annotate(Token.takeWhile(Ascii.isAlpha, { min: 1 })))
    expect(Schema.decodeUnknownSync(ParserSchema.fromSchema(Ident))("abc")).toBe("abc")
  })
})
