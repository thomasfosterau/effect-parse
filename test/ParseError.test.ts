import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Formatter from "effect/Formatter"
import * as Record from "effect/Record"
import { describe, expect, it } from "vite-plus/test"
import { Parser, ParseError, Text, Token } from "../src/index.js"
import { expectFailure } from "./utils.js"

describe("ParseError does not serialise its input (#117)", () => {
  const secret = "hunter2-hunter2"
  const p = Parser.terminated(Parser.repeat(Token.literal("a")), Token.literal(";"))
  const input = `aaa!${secret}`
  const error = expectFailure(p, input)
  const bytes = new TextEncoder().encode(input)
  const byteError = expectFailure(
    Parser.terminated(Parser.repeat(Text.utf8.literal("a")), Text.utf8.literal(";")),
    bytes
  )

  it("keeps input and encoding readable", () => {
    expect(error.input).toBe(input)
    expect(error.position).toEqual({ line: 1, column: 4 })
    expect(byteError.input).toBe(bytes)
    expect(byteError.encoding?.name).toBe("UTF-8")
    expect(byteError.position).toEqual({ line: 1, column: 4 })
    expect(ParseError.lineColumn(error.input, error.offset)).toEqual({ line: 1, column: 4 })
  })

  it("hides them from everything that walks the error's own properties", () => {
    ;[error, byteError].forEach((e) => {
      // Not own properties at all, enumerable or not
      expect(Object.getOwnPropertyDescriptor(e, "input")).toBeUndefined()
      expect(Object.getOwnPropertyDescriptor(e, "encoding")).toBeUndefined()
      // What object spread and `Object.keys` copy: the own enumerable properties
      const copied = Object.assign({}, e)
      expect("input" in copied).toBe(false)
      expect("encoding" in copied).toBe(false)
      expect(copied).toMatchObject({ offset: 3, kind: "Literal", mode: "Backtrack", context: [] })
    })
    // Nothing reachable from the error's own keys (the stack and the arguments `Data.TaggedError` keeps
    // among them) holds input beyond the message's window
    const far = expectFailure(p, `${"a".repeat(500)}!${"x".repeat(500)}${secret}`)
    const own = Object.getOwnPropertyDescriptors(far)
    const reachable = Reflect.ownKeys(own).map((key) =>
      Formatter.format(Object.getOwnPropertyDescriptor(own, key)?.value)
    )
    expect(reachable.length).toBeGreaterThan(8)
    expect(reachable.join("\n")).not.toContain(secret)
    expect(far.input).toContain(secret)
  })

  it("is not written by JSON.stringify, toJSON, Formatter or inspect, beyond the message's window", () => {
    // The secret sits within the window here, so only the message may show it
    const withoutMessage = (text: string) => text.replaceAll(Formatter.formatJson(error.message).slice(1, -1), "")
    const json = Formatter.formatJson(error)
    expect(json).toContain('"offset":3')
    expect(json).toContain('"position":{"line":1,"column":4}')
    expect(withoutMessage(json)).not.toContain(secret)
    expect(json).not.toContain('"input"')
    expect(Record.keys(error.toJSON())).toEqual([
      "_tag",
      "offset",
      "position",
      "kind",
      "mode",
      "expected",
      "context",
      "cause",
      "description",
      "message"
    ])
    expect(Formatter.format(error)).not.toContain("input")
    // A megabyte of bytes used to serialise as an object with a key per byte: 12.9 MB of JSON
    const large = expectFailure(Parser.repeat(Token.literal(new Uint8Array([1]))), new Uint8Array(1 << 20))
    expect(Formatter.formatJson(large).length).toBeLessThan(1000)
    expect(Formatter.format(large).length).toBeLessThan(1000)
  })

  it("is not written by Effect's Cause rendering or a failed Exit", () => {
    const far = `${"a".repeat(500)}!${"x".repeat(500)}${secret}`
    const exit = Effect.runSyncExit(Parser.parseEffect(p, far))
    expect(Exit.isFailure(exit)).toBe(true)
    const rendered = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(rendered).toContain("Parse error at line 1, column 501")
    expect(rendered).not.toContain(secret)
    expect(Formatter.formatJson(exit)).not.toContain(secret)
    expect(Formatter.format(exit)).not.toContain(secret)
    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : "")).not.toContain(secret)
  })
})

describe("ParseError.message shows a window around the failure (#117)", () => {
  const a = Token.literal("a")

  it("bounds a failure at the end of a long line", () => {
    const error = expectFailure(Parser.repeat(a), `${"a".repeat(5e6)}!`)
    // Used to be 10 000 090 characters, built on every access
    expect(error.message.length).toBeLessThan(300)
    expect(error.message.split("\n")).toEqual([
      "Parse error at line 1, column 5000001:",
      `1 | …${"a".repeat(60)}!`,
      `  | ${" ".repeat(61)}^`,
      'expected "a" or end of input, found "!"'
    ])
    expect(String(error).length).toBeLessThan(320)
  })

  it("marks what it leaves out on either side, and keeps the caret under the failure", () => {
    const line = `${"a".repeat(100)}!${"b".repeat(100)}`
    const lines = expectFailure(Parser.repeat(a), `first\n${line}\nlast`.replace("first\n", "")).message.split("\n")
    expect(lines[1]).toBe(`1 | …${"a".repeat(60)}!${"b".repeat(59)}…`)
    expect(lines[2].indexOf("^")).toBe(lines[1].indexOf("!"))
    const second = expectFailure(Parser.seq(Token.literal("x\n"), Parser.repeat(a)), `x\n${line}\nlast`)
    expect(second.message.split("\n").slice(0, 3)).toEqual([
      "Parse error at line 2, column 101:",
      `2 | …${"a".repeat(60)}!${"b".repeat(59)}…`,
      `  | ${" ".repeat(61)}^`
    ])
  })

  it("leaves a short line whole", () => {
    expect(expectFailure(Parser.repeat(a), "aa!bb\r\nnext").message.split("\n").slice(0, 3)).toEqual([
      "Parse error at line 1, column 3:",
      "1 | aa!bb",
      "  |   ^"
    ])
    const exact = `${"a".repeat(60)}!${"b".repeat(59)}`
    expect(expectFailure(Parser.repeat(a), exact).message.split("\n")[1]).toBe(`1 | ${exact}`)
  })

  it("never splits a surrogate pair at the edge of the window", () => {
    const line = `😀${"a".repeat(59)}é!${"b".repeat(58)}😀😀`
    const lines = expectFailure(Parser.repeat(Token.oneOf("aé😀")), line).message.split("\n")
    expect(lines[1]).toBe(`1 | …${"a".repeat(59)}é!${"b".repeat(58)}😀…`)
    expect(encodeURIComponent(lines[1])).toContain("%F0%9F%98%80")
    const whole = `😀${"a".repeat(58)}é!${"b".repeat(58)}😀`
    expect(expectFailure(Parser.repeat(Token.oneOf("aé😀")), whole).message.split("\n")[1]).toBe(`1 | ${whole}`)
  })

  it("bounds encoded bytes the same way", () => {
    const T = Text.utf8
    const encode = (s: string) => new TextEncoder().encode(s)
    const long = expectFailure(Parser.repeat(T.literal("é")), encode(`${"é".repeat(2e6)}!${"é".repeat(100)}`))
    expect(long.message.length).toBeLessThan(300)
    expect(long.message.split("\n").slice(0, 3)).toEqual([
      "Parse error at line 1, column 2000001 (byte 4000000):",
      `1 | …${"é".repeat(60)}!${"é".repeat(59)}…`,
      `  | ${" ".repeat(61)}^`
    ])
    const short = expectFailure(Parser.seq(T.literal("x\n"), Parser.repeat(T.literal("é"))), encode("x\néé!é\r\nnext"))
    expect(short.message.split("\n").slice(0, 3)).toEqual([
      "Parse error at line 2, column 3 (byte 6):",
      "2 | éé!é",
      "  |   ^"
    ])
  })
})
