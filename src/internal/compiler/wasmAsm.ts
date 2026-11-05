/**
 * A small WebAssembly assembler for the WASM compiler: function bodies with
 * structured labels, and the binary module around them. It writes only the
 * instructions and sections that compiler uses.
 */

/** Value types. */
export const I32 = 0x7f
export const F64 = 0x7c
const Void = 0x40

/** Opcodes used by the compiler. */
export const Op = {
  unreachable: 0x00,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  brIf: 0x0d,
  brTable: 0x0e,
  return: 0x0f,
  call: 0x10,
  drop: 0x1a,
  select: 0x1b,
  localGet: 0x20,
  localSet: 0x21,
  localTee: 0x22,
  globalGet: 0x23,
  globalSet: 0x24,
  i32Load: 0x28,
  f64Load: 0x2b,
  i32Load8U: 0x2d,
  i32Load16U: 0x2f,
  i32Store: 0x36,
  i32Store8: 0x3a,
  i32Store16: 0x3b,
  f64Store: 0x39,
  i32Const: 0x41,
  f64Const: 0x44,
  i32Eqz: 0x45,
  i32Eq: 0x46,
  i32Ne: 0x47,
  i32LtS: 0x48,
  i32LtU: 0x49,
  i32GtS: 0x4a,
  i32GtU: 0x4b,
  i32LeS: 0x4c,
  i32LeU: 0x4d,
  i32GeS: 0x4e,
  i32GeU: 0x4f,
  f64Eq: 0x61,
  f64Ne: 0x62,
  i32Add: 0x6a,
  i32Sub: 0x6b,
  i32Mul: 0x6c,
  i32And: 0x71,
  i32Or: 0x72,
  i32Xor: 0x73,
  i32Shl: 0x74,
  i32ShrU: 0x76,
  f64Abs: 0x99,
  f64Neg: 0x9a,
  f64Add: 0xa0,
  f64Sub: 0xa1,
  f64Mul: 0xa2,
  f64Div: 0xa3,
  f64ConvertI32U: 0xb8
} as const

/** Unsigned LEB128. */
export const uleb = (n: number, out: Array<number> = []): Array<number> => {
  let v = n >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v !== 0) b |= 0x80
    out.push(b)
  } while (v !== 0)
  return out
}

/** Signed LEB128 of a 32-bit integer. */
export const sleb = (n: number, out: Array<number> = []): Array<number> => {
  let v = n | 0
  for (;;) {
    const b = v & 0x7f
    v >>= 7
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
      out.push(b)
      return out
    }
    out.push(b | 0x80)
  }
}

/** A branch target: a block, a loop or an `if`. */
export class Label {
  readonly _label = true
}

/**
 * The body of a function being written: its code, its locals (after the
 * parameters) and the stack of labels that branches refer to.
 */
export class Body {
  readonly code: Array<number> = []
  private readonly i32s: Array<number> = []
  private readonly f64s: Array<number> = []
  private readonly labels: Array<Label> = []
  private next: number
  /** Trace writes since the last check that dominates the code that follows (see the compiler). */
  writes = 0
  /** The local holding the trace pointer, in the compiler's rule functions. */
  tp = -1

  constructor(readonly params: number) {
    this.next = params
  }

  /** A new local of type `i32`. */
  local(): number {
    const l = this.next++
    this.i32s.push(l)
    return l
  }

  /** A new local of type `f64`. */
  localF64(): number {
    const l = this.next++
    this.f64s.push(l)
    return l
  }

  /** The locals declaration, in index order (runs of one type each). */
  locals(): Array<number> {
    const groups: Array<[number, number]> = []
    for (let l = this.params; l < this.next; l++) {
      const type = this.f64s.includes(l) ? F64 : I32
      const last = groups[groups.length - 1]
      if (last !== undefined && last[1] === type) last[0]++
      else groups.push([1, type])
    }
    const out = uleb(groups.length)
    for (const [n, type] of groups) {
      uleb(n, out)
      out.push(type)
    }
    return out
  }

  op(...bytes: ReadonlyArray<number>): this {
    for (const b of bytes) this.code.push(b)
    return this
  }

  i32(n: number): this {
    this.code.push(Op.i32Const)
    sleb(n, this.code)
    return this
  }

  f64(x: number): this {
    this.code.push(Op.f64Const)
    const bytes = new Uint8Array(new Float64Array([x]).buffer)
    for (const b of bytes) this.code.push(b)
    return this
  }

  get(l: number): this {
    this.code.push(Op.localGet)
    uleb(l, this.code)
    return this
  }

  set(l: number): this {
    this.code.push(Op.localSet)
    uleb(l, this.code)
    return this
  }

  tee(l: number): this {
    this.code.push(Op.localTee)
    uleb(l, this.code)
    return this
  }

  gget(g: number): this {
    this.code.push(Op.globalGet)
    uleb(g, this.code)
    return this
  }

  gset(g: number): this {
    this.code.push(Op.globalSet)
    uleb(g, this.code)
    return this
  }

  call(f: number): this {
    this.code.push(Op.call)
    uleb(f, this.code)
    return this
  }

  /** A memory access with an alignment exponent and a constant offset. */
  mem(op: number, align: number, offset: number): this {
    this.code.push(op)
    uleb(align, this.code)
    uleb(offset, this.code)
    return this
  }

  /** `block ... end`: a branch to its label exits the block. */
  block(body: (exit: Label) => void): this {
    return this.structured(Op.block, body)
  }

  /** `loop ... end`: a branch to its label restarts the loop. */
  loop(body: (again: Label) => void): this {
    return this.structured(Op.loop, body)
  }

  /** `if ... (else ...) end` on the `i32` at the top of the stack. */
  if(then: () => void, otherwise?: () => void): this {
    this.code.push(Op.if, Void)
    this.labels.push(new Label())
    then()
    if (otherwise !== undefined) {
      this.code.push(Op.else)
      otherwise()
    }
    this.labels.pop()
    this.code.push(Op.end)
    return this
  }

  /** `if (result i32) ... else ... end`. */
  ifI32(then: () => void, otherwise: () => void): this {
    this.code.push(Op.if, I32)
    this.labels.push(new Label())
    then()
    this.code.push(Op.else)
    otherwise()
    this.labels.pop()
    this.code.push(Op.end)
    return this
  }

  private structured(op: number, body: (label: Label) => void): this {
    const label = new Label()
    this.code.push(op, Void)
    this.labels.push(label)
    body(label)
    this.labels.pop()
    this.code.push(Op.end)
    return this
  }

  /**
   * Whether a branch went to a label out of scope: a bug in the compiler,
   * which then refuses the function (see the WebAssembly compiler).
   */
  invalid = false

  private depth(label: Label): number {
    const i = this.labels.lastIndexOf(label)
    if (i < 0) this.invalid = true
    return this.labels.length - 1 - i
  }

  br(label: Label): this {
    this.code.push(Op.br)
    uleb(this.depth(label), this.code)
    return this
  }

  brIf(label: Label): this {
    this.code.push(Op.brIf)
    uleb(this.depth(label), this.code)
    return this
  }

  /** `br_table`: `targets[i]` for the index at the top of the stack, `otherwise` out of range. */
  brTable(targets: ReadonlyArray<Label>, otherwise: Label): this {
    this.code.push(Op.brTable)
    uleb(targets.length, this.code)
    for (const t of targets) uleb(this.depth(t), this.code)
    uleb(this.depth(otherwise), this.code)
    return this
  }
}

/** A function type: parameter and result types. */
export interface FuncType {
  readonly params: ReadonlyArray<number>
  readonly results: ReadonlyArray<number>
}

/** A global: its type, whether it is mutable, and its initial value. */
export interface Global {
  readonly type: number
  readonly init: number
}

/** What a module is made of. */
export interface ModuleSpec {
  readonly types: ReadonlyArray<FuncType>
  /** Imported functions: module, name, type index. */
  readonly imports: ReadonlyArray<readonly [string, string, number]>
  /** The imported memory (module "env", name "mem"). */
  readonly memoryPages: number
  /** Defined functions: type index and body. */
  readonly functions: ReadonlyArray<readonly [number, Body]>
  readonly globals: ReadonlyArray<Global>
  /** Exported functions and globals: name, kind (0 function, 3 global), index. */
  readonly exports: ReadonlyArray<readonly [string, 0 | 3, number]>
  /** Active data segments: offset and bytes. */
  readonly data: ReadonlyArray<readonly [number, Uint8Array]>
}

const utf8Encoder = /*#__PURE__*/ new TextEncoder()

/** Appends `bytes` to `out`. */
const append = (out: Array<number>, bytes: ArrayLike<number>): void => {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i])
}

/** Appends a name: its length and its UTF-8 bytes. */
const name = (out: Array<number>, s: string): void => {
  const bytes = utf8Encoder.encode(s)
  uleb(bytes.length, out)
  append(out, bytes)
}

/** Appends a section: its id, its size, the number of its items and the items `write` appends. */
const section = <A>(
  out: Array<number>,
  id: number,
  items: ReadonlyArray<A>,
  write: (body: Array<number>, item: A) => void
) => {
  const body = uleb(items.length)
  for (const item of items) write(body, item)
  out.push(id)
  uleb(body.length, out)
  append(out, body)
}

const f64Bytes = (x: number): Uint8Array => new Uint8Array(new Float64Array([x]).buffer)

/** The binary module. */
export const encodeModule = (spec: ModuleSpec): Uint8Array<ArrayBuffer> => {
  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  section(out, 1, spec.types, (body, t) => {
    body.push(0x60)
    uleb(t.params.length, body)
    append(body, t.params)
    uleb(t.results.length, body)
    append(body, t.results)
  })
  const memory: readonly [string, string, number] = ["env", "mem", -1]
  section(out, 2, [...spec.imports, memory], (body, [m, n, t]) => {
    name(body, m)
    name(body, n)
    if (t < 0) body.push(0x02, 0x00, ...uleb(spec.memoryPages))
    else body.push(0x00, ...uleb(t))
  })
  section(out, 3, spec.functions, (body, [t]) => uleb(t, body))
  section(out, 6, spec.globals, (body, g) => {
    if (g.type === F64) {
      body.push(F64, 0x01, Op.f64Const)
      append(body, f64Bytes(g.init))
    } else {
      body.push(I32, 0x01, Op.i32Const)
      sleb(g.init, body)
    }
    body.push(Op.end)
  })
  section(out, 7, spec.exports, (body, [n, kind, i]) => {
    name(body, n)
    body.push(kind)
    uleb(i, body)
  })
  section(out, 10, spec.functions, (body, [, fn]) => {
    const locals = fn.locals()
    uleb(locals.length + fn.code.length + 1, body)
    append(body, locals)
    append(body, fn.code)
    body.push(Op.end)
  })
  section(out, 11, spec.data, (body, [offset, bytes]) => {
    body.push(0x00, Op.i32Const)
    sleb(offset, body)
    body.push(Op.end)
    uleb(bytes.length, body)
    append(body, bytes)
  })
  return new Uint8Array(out)
}
