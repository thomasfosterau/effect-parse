import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { describe, expect, it } from "vite-plus/test"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { Binary, Bits, Parser, ParserStream, Token } from "../src/index.js"
import { expectFailure, expectSuccess, peek } from "./utils.js"

const b = (...xs: Array<number>) => new Uint8Array(xs)

describe("Binary", () => {
  it("bytes", () => {
    expectSuccess(Binary.u8, b(0xff), 255)
    expectSuccess(Binary.i8, b(0xff), -1)
    expectFailure(Binary.u8, b())
  })

  it("16/24/32-bit integers (winnow binary tests)", () => {
    expectSuccess(Binary.beU16, b(0x00, 0x03), 3)
    expectSuccess(Binary.leU16, b(0x03, 0x00), 3)
    expectSuccess(Binary.beI16, b(0xff, 0xff), -1)
    expectSuccess(Binary.leI16, b(0x00, 0x80), -32768)
    expectSuccess(Binary.beU24, b(0x12, 0x34, 0x56), 0x123456)
    expectSuccess(Binary.leU24, b(0x56, 0x34, 0x12), 0x123456)
    expectSuccess(Binary.beI24, b(0xff, 0xff, 0xff), -1)
    expectSuccess(Binary.leI24, b(0x00, 0x00, 0x80), -8388608)
    expectSuccess(Binary.beU32, b(0x12, 0x34, 0x56, 0x78), 0x12345678)
    expectSuccess(Binary.leU32, b(0x78, 0x56, 0x34, 0x12), 0x12345678)
    expectSuccess(Binary.beI32, b(0x80, 0, 0, 0), -2147483648)
    expectSuccess(Binary.leI32, b(0xff, 0xff, 0xff, 0x7f), 2147483647)
  })

  it("64/128-bit integers", () => {
    expectSuccess(Binary.beU64, b(0, 0, 0, 0, 0, 0, 1, 0), 256n)
    expectSuccess(Binary.leU64, b(0, 1, 0, 0, 0, 0, 0, 0), 256n)
    expectSuccess(Binary.beI64, b(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), -1n)
    expectSuccess(Binary.leI64, b(0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), -2n)
    const one128 = new Uint8Array(16)
    one128[15] = 1
    expectSuccess(Binary.beU128, one128, 1n)
    expectSuccess(Binary.leU128, one128, 1n << 120n)
    expectSuccess(Binary.beI128, new Uint8Array(16).fill(0xff), -1n)
    expectSuccess(Binary.leI128, new Uint8Array(16).fill(0xff), -1n)
  })

  it("floats", () => {
    const buf = new Uint8Array(8)
    new DataView(buf.buffer).setFloat64(0, 1.5, false)
    expectSuccess(Binary.beF64, buf, 1.5)
    new DataView(buf.buffer).setFloat64(0, -2.25, true)
    expectSuccess(Binary.leF64, buf, -2.25)
    const f = new Uint8Array(4)
    new DataView(f.buffer).setFloat32(0, 0.5, false)
    expectSuccess(Binary.beF32, f, 0.5)
    new DataView(f.buffer).setFloat32(0, 0.5, true)
    expectSuccess(Binary.leF32, f, 0.5)
  })

  it("endianness parameters", () => {
    expectSuccess(Binary.u16("big"), b(1, 0), 256)
    expectSuccess(Binary.u16("little"), b(1, 0), 1)
    expectSuccess(Binary.u32("big"), b(0, 0, 0, 1), 1)
    expectSuccess(Binary.i64("little"), b(1, 0, 0, 0, 0, 0, 0, 0), 1n)
    expect(Result.isSuccess(Parser.parse(Binary.u16("native"), b(1, 0)))).toBe(true)
  })

  it("reads every number as DataView does", () => {
    type Case = readonly [
      Parser.Parser<number | bigint, never, never, Uint8Array>,
      number,
      (v: DataView) => number | bigint
    ]
    const cases: ReadonlyArray<Case> = [
      [Binary.u8, 1, (v) => v.getUint8(0)],
      [Binary.i8, 1, (v) => v.getInt8(0)],
      [Binary.beU16, 2, (v) => v.getUint16(0)],
      [Binary.leU16, 2, (v) => v.getUint16(0, true)],
      [Binary.beI16, 2, (v) => v.getInt16(0)],
      [Binary.leI16, 2, (v) => v.getInt16(0, true)],
      [Binary.beU24, 3, (v) => (v.getUint8(0) << 16) | v.getUint16(1)],
      [Binary.leU24, 3, (v) => v.getUint16(0, true) | (v.getUint8(2) << 16)],
      [Binary.beI24, 3, (v) => (v.getInt8(0) << 16) | v.getUint16(1)],
      [Binary.leI24, 3, (v) => v.getUint16(0, true) | (v.getInt8(2) << 16)],
      [Binary.beU32, 4, (v) => v.getUint32(0)],
      [Binary.leU32, 4, (v) => v.getUint32(0, true)],
      [Binary.beI32, 4, (v) => v.getInt32(0)],
      [Binary.leI32, 4, (v) => v.getInt32(0, true)],
      [Binary.beU64, 8, (v) => v.getBigUint64(0)],
      [Binary.leI64, 8, (v) => v.getBigInt64(0, true)],
      [Binary.beF32, 4, (v) => v.getFloat32(0)],
      [Binary.leF64, 8, (v) => v.getFloat64(0, true)]
    ]
    const edges = [0x00, 0x01, 0x7f, 0x80, 0xff]
    cases.forEach(([p, size, read], i) => {
      Array.from({ length: 200 }).forEach((_, k) => {
        const bytes = Uint8Array.from({ length: size }, (_, j) =>
          k < 25 ? edges[(k + j * 3) % 5] : (k * 131 + j * 71 + i * 17) & 255
        )
        expectSuccess(p, bytes, read(new DataView(bytes.buffer)))
      })
    })
  })

  it("works on subarray views", () => {
    const backing = b(9, 9, 0x01, 0x02)
    expectSuccess(Binary.beU16, backing.subarray(2), 0x0102)
  })

  it("reads each state's own input, streamed in chunks", () => {
    const bytes = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 37) & 255))
    const expected = Array.from(
      { length: 16 },
      (_, i) => ((bytes[4 * i] << 24) | (bytes[4 * i + 1] << 16) | (bytes[4 * i + 2] << 8) | bytes[4 * i + 3]) >>> 0
    )
    const chunks = Array.from({ length: 13 }, (_, i) => bytes.subarray(i * 5, i * 5 + 5))
    const out = Effect.runSync(Stream.fromIterable(chunks).pipe(ParserStream.parseAll(Parser.repeat(Binary.beU32))))
    expect(out).toEqual(expected)
    expectSuccess(Parser.repeat(Binary.beU32), bytes.subarray(4), expected.slice(1))
  })

  it("partial", () => {
    expect(Parser.parsePartial(Binary.beU32, b(1, 2))).toEqual(
      Result.succeed({ _tag: "Incomplete", needed: Option.some(2) })
    )
  })

  it("lengthTake (winnow length_take tests)", () => {
    expect(peek(Binary.lengthTake(Binary.u8), b(2, 0xaa, 0xbb, 0xcc))).toEqual(Result.succeed([b(0xcc), b(0xaa, 0xbb)]))
    expectFailure(Binary.lengthTake(Binary.u8), b(3, 1))
    expectSuccess(Binary.lengthTake(Binary.beU64), b(0, 0, 0, 0, 0, 0, 0, 1, 7), b(7))
  })

  it("lengthTake works for text", () => {
    const counted = Binary.lengthTake(
      Parser.terminated(Token.takeWhile("0123456789", { min: 1 }).pipe(Parser.map(Number)), Token.literal(":"))
    )
    expectSuccess(counted, "5:hello", "hello")
  })

  it("lengthRepeat", () => {
    expectSuccess(Binary.lengthRepeat(Binary.u8, Binary.beU16), b(2, 0, 1, 0, 2), [1, 2])
    expectFailure(Binary.lengthRepeat(Binary.u8, Binary.beU16), b(2, 0, 1))
  })

  it("lengthAndThen", () => {
    const p = Binary.lengthAndThen(Binary.u8, Binary.beU16)
    expect(peek(p, b(3, 0, 1, 0xff, 0x42))).toEqual(Result.succeed([b(0x42), 1]))
    expectFailure(p, b(1, 0, 1))
  })
})

describe("Bits", () => {
  it("takes every width at every bit offset", () => {
    const bytes = Uint8Array.from({ length: 9 }, (_, i) => (i * 0x5b + 0x3c) & 255)
    // One bit at a time, most significant first
    const reference = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => (bytes[(from + i) >>> 3] >>> (7 - ((from + i) & 7))) & 1).reduce(
        (v, bit) => v * 2 + bit,
        0
      )
    Array.from({ length: 8 }).forEach((_, skip) => {
      Array.from({ length: 53 }).forEach((_, i) => {
        const count = i + 1
        const p = Bits.bits(Parser.preceded(Bits.takeBig(skip), Bits.take(count)))
        expect(Parser.parse(Parser.terminated(p, Token.restOf<Uint8Array>()), bytes)).toEqual(
          Result.succeed(reference(skip, count))
        )
      })
    })
  })

  it("take", () => {
    const p = Bits.bits(Parser.seq(Bits.take(4), Bits.take(4)))
    expectSuccess(p, b(0x45), [4, 5])
  })

  it("take across byte boundaries (nom bits tests)", () => {
    const p = Bits.bits(Parser.seq(Bits.take(4), Bits.take(8), Bits.take(4)))
    expectSuccess(p, b(0x12, 0x34), [1, 0x23, 4])
  })

  it("skips the remainder of a partial byte", () => {
    const p = Parser.seq(Bits.bits(Bits.take(3)), Binary.u8)
    expectSuccess(p, b(0b10100000, 7), [5, 7])
  })

  it("pattern / bool", () => {
    const p = Bits.bits(Parser.seq(Bits.pattern(0b101, 3), Bits.bool, Bits.bool))
    expectSuccess(p, b(0b10110000), [0b101, true, false])
    const err = expectFailure(p, b(0b11110000))
    expect(err.offset).toBe(0)
    expect(err.expected).toEqual(["bit pattern 101"])
  })

  it("alternatives backtrack at bit granularity", () => {
    const p = Bits.bits(
      Parser.seq(Bits.take(1), Parser.alt(Bits.pattern(0b11, 2), Bits.pattern(0b10, 2)), Bits.take(5))
    )
    expectSuccess(p, b(0b01011111), [0, 0b10, 0b11111])
  })

  it("takeBig", () => {
    expectSuccess(Bits.bits(Bits.takeBig(64)), new Uint8Array(8).fill(0xff), 0xffffffffffffffffn)
  })

  it("bytes inside bits", () => {
    const p = Bits.bits(Parser.seq(Bits.take(4), Bits.bytes(Binary.u8), Bits.take(8)))
    expectSuccess(p, b(0xa0, 0x07, 0x09), [0xa, 7, 9])
  })

  it("reports byte offsets and needed bytes", () => {
    const err = expectFailure(Bits.bits(Bits.take(12)), b(0xff))
    expect(err.offset).toBe(0)
    expect(Parser.parsePartial(Bits.bits(Bits.take(12)), b(0xff))).toEqual(
      Result.succeed({ _tag: "Incomplete", needed: Option.some(1) })
    )
  })
})
