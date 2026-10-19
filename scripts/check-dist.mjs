// Imports every entry in `exports` from the built `dist/`, by package name
// (Node resolves a package's own name through its `exports`), the way a
// consumer does. Fails when an entry is missing from `dist/`, a module throws
// at import, or a subpath stops exporting what the root namespace does.
//
// Also fails on a call that runs when a module loads (in a top-level
// declaration, outside any function) and is not marked `/*#__PURE__*/`:
// bundlers keep every such call they can't prove pure, so one unmarked parser
// keeps itself and everything it references in every bundle that imports its
// module.
import { readdir, readFile } from "node:fs/promises"
import { parseAst } from "rolldown/parseAst"

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
const root = await import(pkg.name)
let failures = 0

for (const subpath of Object.keys(pkg.exports)) {
  if (subpath === "./package.json") continue
  const specifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`
  try {
    const mod = await import(specifier)
    const namespace = subpath === "." ? undefined : root[subpath.slice(2)]
    if (subpath !== "." && namespace === undefined) {
      throw new Error(`the root entry does not re-export ${subpath.slice(2)}`)
    }
    if (namespace !== undefined && Object.keys(namespace).sort().join() !== Object.keys(mod).sort().join()) {
      throw new Error(`${specifier} and the root namespace export different names`)
    }
    console.log(`ok: ${specifier} (${Object.keys(mod).length} exports)`)
  } catch (error) {
    failures++
    console.error(`fail: ${specifier}: ${error instanceof Error ? error.message : error}`)
  }
}

const dist = new URL("../dist/", import.meta.url)
const deferred = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ClassBody"])
for (const file of (await readdir(dist, { recursive: true })).filter((f) => f.endsWith(".js")).sort()) {
  const source = await readFile(new URL(file, dist), "utf8")
  const unmarked = []
  const visit = (node) => {
    if (node === null || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach(visit)
    if (deferred.has(node.type)) return
    // A call in a chain (`f(x).pipe(g)`) starts where the chain does, so one
    // annotation marks both
    if (
      (node.type === "CallExpression" || node.type === "NewExpression") &&
      !/\/\*\s*[#@]__PURE__\s*\*\/$/.test(source.slice(0, node.start).trimEnd())
    ) {
      unmarked.push(node.start)
    }
    for (const key in node) if (key !== "type") visit(node[key])
  }
  for (const statement of parseAst(source, undefined, file).body) {
    const declaration = statement.type.startsWith("Export") ? statement.declaration : statement
    if (declaration?.type === "VariableDeclaration") declaration.declarations.forEach((d) => visit(d.init))
    if (declaration?.type === "ClassDeclaration") visit(declaration.superClass)
  }
  for (const start of unmarked) {
    failures++
    const line = source.slice(0, start).split("\n").length
    console.error(`fail: dist/${file}:${line}: top-level call without /*#__PURE__*/: ${source.slice(start, start + 60).split("\n")[0]}`)
  }
}
if (failures === 0) console.log("ok: every top-level call in dist/ is marked /*#__PURE__*/")

if (failures > 0) process.exit(1)
