/**
 * Colours: ripgrep's `--colors` specs and the ANSI sequences it writes for
 * them (those of the `termcolor` crate).
 *
 * @since 0.0.0
 */

/**
 * The parts of the output that can be coloured.
 *
 * @since 0.0.0
 */
export type ColorTarget = "path" | "line" | "column" | "match" | "highlight"

type Color =
  | { readonly _tag: "Named"; readonly n: number }
  | { readonly _tag: "Ansi256"; readonly n: number }
  | { readonly _tag: "Rgb"; readonly r: number; readonly g: number; readonly b: number }

/**
 * A colour and style.
 *
 * @since 0.0.0
 */
export interface Spec {
  fg: Color | undefined
  bg: Color | undefined
  bold: boolean
  intense: boolean
  underline: boolean
}

const blank = (): Spec => ({
  fg: undefined,
  bg: undefined,
  bold: false,
  intense: false,
  underline: false
})

const names: ReadonlyMap<string, number> = new Map([
  ["black", 0],
  ["red", 1],
  ["green", 2],
  ["yellow", 3],
  ["blue", 4],
  ["magenta", 5],
  ["cyan", 6],
  ["white", 7]
])

const parseColor = (value: string): Color | undefined => {
  const named = names.get(value)
  if (named !== undefined) return { _tag: "Named", n: named }
  const num = (s: string) =>
    /^0x[0-9a-f]+$/i.test(s) ? Number.parseInt(s.slice(2), 16) : /^\d+$/.test(s) ? Number(s) : Number.NaN
  const parts = value.split(",")
  if (parts.length === 3) {
    const [r = -1, g = -1, b = -1] = parts.map(num)
    if ([r, g, b].every((x) => x >= 0 && x <= 255)) return { _tag: "Rgb", r, g, b }
    return undefined
  }
  const n = num(value)
  return n >= 0 && n <= 255 ? { _tag: "Ansi256", n } : undefined
}

/**
 * The colours in effect: ripgrep's defaults with the `--colors` specs
 * applied in order. Returns an error message for a malformed spec.
 *
 * @since 0.0.0
 */
export const parseSpecs = (specs: ReadonlyArray<string>): Map<ColorTarget, Spec> | string => {
  const table = new Map<ColorTarget, Spec>([
    ["path", { ...blank(), fg: { _tag: "Named", n: 5 } }],
    ["line", { ...blank(), fg: { _tag: "Named", n: 2 } }],
    ["column", blank()],
    ["match", { ...blank(), fg: { _tag: "Named", n: 1 }, bold: true }],
    ["highlight", blank()]
  ])
  for (const spec of specs) {
    const error = applySpec(table, spec)
    if (error !== undefined) return error
  }
  return table
}

const targets: ReadonlyArray<ColorTarget> = ["path", "line", "column", "match", "highlight"]

const styles: ReadonlyMap<string, (x: Spec) => void> = new Map([
  ["bold", (x) => (x.bold = true)],
  ["nobold", (x) => (x.bold = false)],
  ["intense", (x) => (x.intense = true)],
  ["nointense", (x) => (x.intense = false)],
  ["underline", (x) => (x.underline = true)],
  ["nounderline", (x) => (x.underline = false)]
])

/** Applies one `{type}:{attribute}:{value}` spec; returns ripgrep's message for a malformed one. */
const applySpec = (table: Map<ColorTarget, Spec>, spec: string): string | undefined => {
  const [name = "", attribute = "", value] = spec.split(":")
  const target = targets.find((t) => t === name)
  if (target === undefined)
    return `unrecognized output type '${name}'. Choose from: path, line, column, match, highlight.`
  if (attribute === "none") {
    table.set(target, blank())
    return undefined
  }
  if (value === undefined) return `invalid color spec '${spec}': expected {type}:{attribute}:{value}`
  const s = table.get(target) ?? blank()
  table.set(target, s)
  return applyAttribute(s, attribute, value)
}

const applyAttribute = (s: Spec, attribute: string, value: string): string | undefined => {
  if (attribute === "style") {
    const set = styles.get(value)
    if (set === undefined) {
      return `unrecognized style attribute '${value}'. Choose from: nobold, bold, nointense, intense, nounderline, underline.`
    }
    set(s)
    return undefined
  }
  if (attribute !== "fg" && attribute !== "bg") {
    return `unrecognized color spec attribute '${attribute}'. Choose from: fg, bg, style, none.`
  }
  const color = parseColor(value)
  if (color === undefined)
    return `unrecognized color name '${value}'. Choose from: black, blue, green, red, cyan, magenta, yellow, white`
  if (attribute === "fg") s.fg = color
  else s.bg = color
  return undefined
}

const intenseCodes = [8, 9, 10, 11, 12, 13, 14, 15]

const colorCode = (fg: boolean, c: Color, intense: boolean): string => {
  const base = fg ? 38 : 48
  switch (c._tag) {
    case "Named":
      return intense ? `\x1b[${base};5;${intenseCodes[c.n]}m` : `\x1b[${fg ? 3 : 4}${c.n}m`
    case "Ansi256":
      return `\x1b[${base};5;${c.n}m`
    case "Rgb":
      return `\x1b[${base};2;${c.r};${c.g};${c.b}m`
  }
}

/**
 * The escape sequence that starts text in a spec (always resetting first,
 * as ripgrep does).
 *
 * @since 0.0.0
 */
export const start = (s: Spec): string =>
  "\x1b[0m" +
  (s.bold ? "\x1b[1m" : "") +
  (s.underline ? "\x1b[4m" : "") +
  (s.fg === undefined ? "" : colorCode(true, s.fg, s.intense)) +
  (s.bg === undefined ? "" : colorCode(false, s.bg, s.intense))

/**
 * The sequence that ends coloured text.
 *
 * @since 0.0.0
 */
export const reset = "\x1b[0m"

/**
 * The hyperlink formats ripgrep names, by alias.
 *
 * @since 0.0.0
 */
export const hyperlinkAliases: ReadonlyMap<string, string> = new Map([
  ["default", "file://{host}{path}"],
  ["file", "file://{host}{path}"],
  ["grep+", "grep+://{path}:{line}"],
  ["kitty", "file://{host}{path}#{line}"],
  ["macvim", "mvim://open?url=file://{path}&line={line}&column={column}"],
  ["none", ""],
  ["textmate", "txmt://open?url=file://{path}&line={line}&column={column}"],
  ["vscode", "vscode://file{path}:{line}:{column}"],
  ["vscode-insiders", "vscode-insiders://file{path}:{line}:{column}"],
  ["vscodium", "vscodium://file{path}:{line}:{column}"]
])

/**
 * Expands a hyperlink format for a path (absolute) and position.
 *
 * @since 0.0.0
 */
export const hyperlink = (format: string, host: string, path: string, line: number, column: number): string =>
  format
    .replaceAll("{host}", host)
    .replaceAll("{path}", encodeURI(path))
    .replaceAll("{line}", String(line))
    .replaceAll("{column}", String(column))
    .replaceAll("{wslprefix}", "")
