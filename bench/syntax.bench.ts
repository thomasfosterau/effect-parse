/**
 * A benchmark of syntax trees: building the tree of a JSON document
 * (`examples/json-syntax.ts`), against parsing it for its value alone, and
 * re-parsing it after small edits.
 *
 * The edits are what an editor sends while someone types: one character
 * changed, inserted or deleted somewhere in the middle of the document,
 * and a run of keystrokes, each reparsed from the previous tree.
 *
 * Run with `pnpm build && pnpm bench:syntax`.
 */
import { Parser, Syntax } from "@thomasfosterau/effect-parse"
import { json } from "../examples/json-syntax.ts"

const doc = JSON.stringify(
  Array.from({ length: 2000 }, (_, i) => ({
    id: i,
    name: `item ${i}`,
    label: `élément nº${i} — 項目 😀`,
    tags: ["a", "b", "c"],
    price: i * 1.25,
    active: i % 2 === 0,
    nested: { x: i, y: [1, 2, 3], z: null }
  })),
  null,
  2
)

const tree = Syntax.parse(json, doc)
const middle = doc.indexOf('"item 1000"') + 6
const keystrokes = "hello world"

const time = (run: () => unknown, rounds: number): number => {
  let best = Infinity
  for (let i = 0; i < rounds; i++) {
    const start = performance.now()
    run()
    best = Math.min(best, performance.now() - start)
  }
  return best
}

const cases: ReadonlyArray<readonly [string, () => unknown]> = [
  ["Parser.parse (interpreted, value only)", () => Parser.parseSync(json, doc)],
  ["Syntax.parse (tree and value)", () => Syntax.parse(json, doc)],
  ["reparse: change a character", () => Syntax.replace(tree, middle, middle + 1, "X")],
  ["reparse: insert a character", () => Syntax.replace(tree, middle, middle, "X")],
  ["reparse: delete a character", () => Syntax.replace(tree, middle, middle + 1, "")],
  ["reparse: edit found by diff", () => Syntax.reparse(tree, doc.slice(0, middle) + "X" + doc.slice(middle + 1))],
  [
    `reparse: ${keystrokes.length} keystrokes, each`,
    () => {
      let t = tree
      for (let i = 0; i < keystrokes.length; i++) t = Syntax.replace(t, middle + i, middle + i, keystrokes[i]!)
      return t
    }
  ]
]

// Every reparse must give the tree a fresh parse does
const check = Syntax.replace(tree, middle, middle + 1, "X")
if (String(check.root) !== String(Syntax.parse(json, check.input).root)) throw new Error("reparse disagrees with parse")

console.log(`document: ${(doc.length / 1e6).toFixed(2)} M chars, ${[...tree.root.descendants()].length} nodes`)
console.log("best of 20 runs\n")
for (const [name, run] of cases) {
  let ms = time(run, 20)
  if (name.includes("keystrokes")) ms /= keystrokes.length
  console.log(`  ${name.padEnd(40)} ${ms.toFixed(3).padStart(8)} ms`)
}
