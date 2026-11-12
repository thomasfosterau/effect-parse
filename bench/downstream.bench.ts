/**
 * A downstream benchmark: the libraries built on effect-parse, parsing
 * documents of their own formats through their public entry points.
 *
 * The other benchmarks time grammars written for them. These time the
 * grammars other people's programs run: BibTeX (effect-bib), iCalendar and
 * vCard (effect-ical), N-Triples, Turtle, SPARQL and ShExC (effect-rdf), XML,
 * HTML and XQuery (effect-xml), and robots.txt and the date and recurrence
 * formats of effect-ext. A change to a hot path of this package shows up
 * here as those libraries' users would see it.
 *
 * The libraries are the published releases pinned in `pnpm-workspace.yaml`,
 * resolved to this checkout's `dist/` (the `@thomasfosterau/effect-parse`
 * override there), so a figure moves only when this package does. Some of
 * what each case times is the library's own work (building records, terms or
 * a DOM): compare a case with itself before and after a change, not with
 * another case.
 *
 * Every document is generated, and each case checks what it parsed before
 * it is timed. Each case runs many times, interleaved with the others, and
 * the best time is reported.
 *
 * Run with `vp run bench:downstream`. Two optional arguments pick the cases
 * (a substring of `group / name`) and the number of rounds:
 * `vp run bench:downstream effect-xml 5`.
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { parseBibtex } from "@thomasfosterau/effect-bib"
import * as CronExpression from "@thomasfosterau/effect-ext/CronExpression"
import * as IsoDuration from "@thomasfosterau/effect-ext/IsoDuration"
import * as Rfc3339 from "@thomasfosterau/effect-ext/Rfc3339"
import * as Robots from "@thomasfosterau/effect-ext/Robots"
import * as RRule from "@thomasfosterau/effect-ext/RRule"
import { ContentLine, parseResult as parseCalendar, VCard } from "@thomasfosterau/effect-ical"
import { NTriples } from "@thomasfosterau/effect-rdf/ntriples"
import { ShExC } from "@thomasfosterau/effect-rdf/shex"
import { Parser as Sparql } from "@thomasfosterau/effect-rdf/sparql"
import { Turtle } from "@thomasfosterau/effect-rdf/turtle"
import { Html, Sax, Xml, XQuery } from "@thomasfosterau/effect-xml"
import { bestOf } from "./shared.ts"

interface Case {
  readonly group: string
  readonly name: string
  /** The characters one run reads. */
  readonly size: number
  /** Parses the input and returns a count of what it found, checked against `expected`. */
  readonly run: () => number
  readonly expected: number
}

const cases: Array<Case> = []
const lines = (n: number, line: (i: number) => string, eol = "\n"): string =>
  Array.from({ length: n }, (_, i) => line(i)).join(eol)
const total = (inputs: ReadonlyArray<string>): number => inputs.reduce((n, s) => n + s.length, 0)
/** Parses each of many short inputs, as a caller decoding one field at a time does. */
const each = <A>(inputs: ReadonlyArray<string>, parse: (input: string) => Result.Result<A, unknown>): number => {
  let ok = 0
  for (const input of inputs) if (Result.isSuccess(parse(input))) ok++
  return ok
}
const sync =
  <A, E>(parse: (input: string) => Effect.Effect<A, E>) =>
  (input: string): Result.Result<A, E> =>
    Effect.runSync(Effect.result(parse(input)))

// ---- effect-bib -------------------------------------------------------------

const bibtex = lines(1500, (i) =>
  [
    `@article{key${i},`,
    `  author = {M{\\"u}ller, J{\\"o}rg and van der Berg, Anna and {The ${i} Consortium}},`,
    `  title = {On the {B}ehaviour of \\emph{parsers} at scale, part ${i}: caf\\'e \\& na{\\"\\i}ve inputs},`,
    `  journal = jacm # { (Series ${i % 7})},`,
    `  year = ${1990 + (i % 35)}, month = mar, volume = {${i % 90}}, number = ${1 + (i % 12)},`,
    `  pages = {${i}--${i + 17}}, doi = {10.1000/xyz.${i}},`,
    `  abstract = "A study of nested {braces {and} quotes}, with $O(n \\log n)$ mathematics."`,
    `}`
  ].join("\n")
)
const bibtexDoc = `@string{jacm = "Journal of the ACM"}\n% a comment line\n${bibtex}\n`
cases.push({
  group: "effect-bib",
  name: "parseBibtex, 1500 entries",
  size: bibtexDoc.length,
  run: () => parseBibtex(bibtexDoc, { mode: "lenient" }).filter((o) => o.outcome === "parsed").length,
  expected: 1500
})

// ---- effect-ical ------------------------------------------------------------

const pad = (n: number, width = 2) => String(n).padStart(width, "0")
const day = (i: number) => `2026${pad(1 + (i % 12))}${pad(1 + (i % 28))}`
const vevent = (i: number) =>
  [
    "BEGIN:VEVENT",
    `UID:event-${i}@example.org`,
    `DTSTAMP:${day(i)}T120000Z`,
    `DTSTART;TZID=Australia/Sydney:${day(i)}T${pad(i % 24)}3000`,
    `DTEND;TZID=Australia/Sydney:${day(i)}T${pad((i + 1) % 24)}3000`,
    `SUMMARY;LANGUAGE=en-AU:Réunion ${i}\\, planning\\; notes`,
    `DESCRIPTION:A long description that is folded over several content lines\\n`,
    ` so that unfolding is exercised\\, with escaped commas\\, semicolons\\; and`,
    ` a backslash \\\\ in entry ${i}.`,
    `LOCATION:Room ${i % 40}\\, Level ${i % 9}`,
    `ATTENDEE;CN="Doe, Jane";ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:jane${i}@example.org`,
    `RRULE:FREQ=WEEKLY;INTERVAL=${1 + (i % 4)};BYDAY=MO,WE,FR;COUNT=${5 + (i % 20)}`,
    `CATEGORIES:WORK,PLANNING,Q${1 + (i % 4)}`,
    `X-CUSTOM-${i % 5};X-PARAM=^'quoted^' value:opaque ${i}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT15M",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT"
  ].join("\r\n")
const calendar = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//bench//EN\r\n${lines(1200, vevent, "\r\n")}\r\nEND:VCALENDAR\r\n`
const vcards = lines(
  1500,
  (i) =>
    [
      "BEGIN:VCARD",
      "VERSION:4.0",
      `FN:Jörg Müller ${i}`,
      `N:Müller;Jörg;Maria,Karl;Dr.;PhD`,
      `EMAIL;TYPE=work;PREF=1:jorg${i}@example.org`,
      `TEL;VALUE=uri;TYPE="voice,cell":tel:+61-4${pad(i % 100)}-555-${pad(i % 10000, 4)}`,
      `ADR;TYPE=home;LABEL="1 Main St\\nSydney":;;1 Main St;Sydney;NSW;2000;Australia`,
      `NOTE:Met at conference ${i}\\, follow up\\; see notes`,
      `X-SOCIAL;TYPE=mastodon:https://example.social/@jorg${i}`,
      "END:VCARD"
    ].join("\r\n"),
  "\r\n"
)
cases.push(
  {
    group: "effect-ical",
    name: "parseResult, 1200 events",
    size: calendar.length,
    run: () => Result.match(parseCalendar(calendar), { onFailure: () => -1, onSuccess: (c) => c.events?.length ?? 0 }),
    expected: 1200
  },
  {
    group: "effect-ical",
    name: "ContentLine.parseAll, calendar",
    size: calendar.length,
    run: () => Result.match(ContentLine.parseAll(calendar), { onFailure: () => -1, onSuccess: (ls) => ls.length }),
    expected: 4 + 1200 * 18
  },
  {
    group: "effect-ical",
    name: "VCard.parseResult, 1500 cards",
    size: vcards.length,
    run: () => Result.match(VCard.parseResult(vcards), { onFailure: () => -1, onSuccess: (cs) => cs.length }),
    expected: 1500
  }
)

// ---- effect-rdf -------------------------------------------------------------

const triple: ReadonlyArray<(s: string, i: number) => string> = [
  (s) => `${s} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Thing> .`,
  (s, i) => `${s} <http://schema.org/name> "Élément nº${i} — \\"quoted\\" \\u00E9"@fr-CA .`,
  (s, i) => `${s} <http://schema.org/price> "${i * 1.25}"^^<http://www.w3.org/2001/XMLSchema#decimal> .`,
  (s, i) => `_:b${i} <http://schema.org/about> ${s} . # a comment`
]
const ntriples = lines(6000, (i) => triple[i % 4]?.(`<http://example.org/resource/item-${i}>`, i) ?? "")
const turtle = `@prefix ex: <http://example.org/> .
@prefix schema: <http://schema.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@base <http://example.org/base/> .

${lines(
  1500,
  (i) => `ex:item${i} a schema:Product, schema:Thing ;
  schema:name "Item ${i}"@en, """A long
multi-line "description" of item ${i}"""@en-AU ;
  schema:price ${i}.25 ; schema:position ${i} ; schema:inStock ${i % 2 === 0} ;
  schema:weight "1.5e${i % 9}"^^xsd:double ;
  schema:offers [ a schema:Offer ; schema:seller <seller/${i % 50}> ; schema:validFrom "2026-01-0${1 + (i % 9)}"^^xsd:date ] ;
  schema:tags ( "a" "b" ex:tag${i % 30} ${i} ) .`
)}
`
const sparqlQueries = Array.from(
  { length: 150 },
  (_, i) => `PREFIX schema: <http://schema.org/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?item ?name (COUNT(?offer) AS ?offers) (AVG(?price) AS ?avg)
WHERE {
  ?item a schema:Product ; schema:name ?name ; schema:price ?price .
  OPTIONAL { ?item schema:offers ?offer . ?offer schema:seller/schema:name ?seller }
  { ?item schema:position ${i} } UNION { ?item schema:tags/rdf:rest*/rdf:first "tag${i}" }
  FILTER (?price > ${i}.5 && (LANG(?name) = "en" || REGEX(STR(?name), "^Item ${i}", "i")) && !BOUND(?missing))
  BIND (CONCAT(?name, " (", STR(?price * 1.1), ")") AS ?label)
  VALUES ?kind { schema:Product schema:Thing }
  FILTER NOT EXISTS { ?item schema:discontinued true }
}
GROUP BY ?item ?name
HAVING (COUNT(?offer) >= ${i % 5})
ORDER BY DESC(?avg) ?name
LIMIT ${10 + i} OFFSET ${i}`
)
const shexc = `PREFIX ex: <http://example.org/>
PREFIX schema: <http://schema.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

${lines(
  400,
  (i) => `ex:Shape${i} EXTRA a {
  a [ schema:Product schema:Thing ] ;
  schema:name xsd:string MINLENGTH 1 MAXLENGTH ${10 + i} + ;
  schema:price xsd:decimal MININCLUSIVE 0 ? ;
  ( schema:gtin /^[0-9]{8,14}$/ | schema:sku LITERAL ) ;
  schema:offers @ex:Shape${(i + 1) % 400} * ;
  ^schema:isRelatedTo IRI {0,${1 + (i % 9)}}
} AND NOT { schema:discontinued [ true ] }`
)}
`
const quads = (qs: ArrayLike<unknown>) => qs.length

const failed = () => -1
cases.push(
  {
    group: "effect-rdf",
    name: "NTriples.parseQuads, 6000 triples",
    size: ntriples.length,
    run: () => Result.match(sync(NTriples.parseQuads)(ntriples), { onFailure: failed, onSuccess: quads }),
    expected: 6000
  },
  {
    group: "effect-rdf",
    name: "Turtle.parseQuads, 1500 subjects",
    size: turtle.length,
    run: () => Result.match(sync(Turtle.parseQuads)(turtle), { onFailure: failed, onSuccess: (r) => r.quads.length }),
    expected: 1500 * 21
  },
  {
    group: "effect-rdf",
    name: "Sparql.parseQueryResult, 150 queries",
    size: total(sparqlQueries),
    run: () => each(sparqlQueries, Sparql.parseQueryResult),
    expected: 150
  },
  {
    group: "effect-rdf",
    name: "ShExC.parse, 400 shapes",
    size: shexc.length,
    run: () => Result.match(sync(ShExC.parse)(shexc), { onFailure: failed, onSuccess: (s) => s.shapes?.length ?? 0 }),
    expected: 400
  }
)

// ---- effect-xml -------------------------------------------------------------

const entries = (org: string) =>
  lines(
    2500,
    (i) => `  <entry xml:lang="en">
    <!-- entry ${i} -->
    <id>urn:uuid:${pad(i, 8)}-0000-4000-8000-000000000000</id>
    <title type="text">Entry ${i} &amp; friends &#x2014; ${org}</title>
    <dc:creator>Jörg Müller</dc:creator>
    <link rel="alternate" type="text/html" href="https://example.org/posts/${i}?a=1&amp;b=2"/>
    <content type="html"><![CDATA[<p>Body of <b>entry</b> ${i}</p>]]></content>
    <?render mode="fast"?>
  </entry>`
  )
const atom = (prolog: string, org: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
${prolog}<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
${entries(org)}
</feed>
`
const feed = atom("", "Example &amp; Co.")
// An internal subset turns the hand-written scanner off: every token is read by the effect-parse grammars
const feedWithDtd = atom(
  `<!DOCTYPE feed [
  <!ENTITY org "Example &amp; Co.">
  <!ATTLIST entry status CDATA "published">
]>
`,
  "&org;"
)
const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Bench &amp; test</title>
<style>p > b { color: red }</style><script>if (a < b && c > d) { run("</p>") }</script></head><body>
${lines(
  2000,
  (i) => `<section id=s${i} class="card wide"><h2>Section ${i} &mdash; caf&eacute;</h2>
<p>Unclosed paragraph with <b>bold <i>and nested</b> misnesting</i> &copy ${i}
<ul><li>one<li>two &amp; three<li><a href="/item?id=${i}&ref=bench">link</a></ul>
<table><tr><td>a<td>b<tr><td colspan=2>c</table><img src="/img/${i}.png" alt="">
<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/><title>icon</title></svg></section>`
)}
</body></html>`
const xqueries = Array.from(
  { length: 150 },
  (_, i) => `declare namespace atom = "http://www.w3.org/2005/Atom";
declare variable $min as xs:integer external := ${i};
declare function local:label($e as element(), $n as xs:integer) as xs:string {
  concat(normalize-space($e/atom:title), " #", string($n), if ($n mod 2 = 0) then " (even)" else ())
};
for $entry at $pos in //atom:entry[@xml:lang = "en"][position() > $min]
let $links := $entry/atom:link[@rel = ("alternate", "self")]/@href ! string(.)
where exists($links) and not(starts-with($entry/atom:id, "urn:x-${i}"))
group by $creator := $entry/*:creator/string()
order by count($entry) descending, $creator ascending empty least
return <author name="{ $creator }" entries="{ count($entry) }">{
  for $e in subsequence($entry, 1, ${1 + (i % 5)})
  return <item pos="{ $pos[1] }">{ local:label($e, ${i}) }, { map { "k": [1, 2, ${i}] }?k?* => sum() }</item>
}</author>`
)
// 26 events an entry (its tags, text, comment, CDATA and PI), and the declaration, the root and the text around them
const FEED_EVENTS = 2500 * 26 + 6
// The DOCTYPE and the line after it
const FEED_EVENTS_DTD = FEED_EVENTS + 2
let events = 0
const count = () => {
  events++
}
const saxEvents = (input: string, options: Parameters<typeof Sax.forEach>[2]) => () => {
  events = 0
  return Effect.runSync(
    Effect.match(Sax.forEach(input, count, options), { onFailure: failed, onSuccess: () => events })
  )
}
cases.push(
  {
    group: "effect-xml",
    name: "Sax.forEach, feed (scanner)",
    size: feed.length,
    run: saxEvents(feed, {}),
    expected: FEED_EVENTS
  },
  {
    group: "effect-xml",
    name: 'Sax.forEach, dtd: "internal" (grammars)',
    size: feedWithDtd.length,
    run: saxEvents(feedWithDtd, { dtd: "internal" }),
    expected: FEED_EVENTS_DTD
  },
  {
    group: "effect-xml",
    name: "Xml.parse, feed",
    size: feed.length,
    run: () => Result.match(sync(Xml.parse)(feed), { onFailure: failed, onSuccess: (d) => d.root.elements.length }),
    expected: 2500
  },
  {
    group: "effect-xml",
    name: "Html.parseDocument, 2000 sections",
    size: html.length,
    run: () =>
      Result.match(sync(Html.parseDocument)(html), {
        onFailure: failed,
        onSuccess: (d) => d.documentElement.descendants("section").length
      }),
    expected: 2000
  },
  {
    group: "effect-xml",
    name: "XQuery.compile, 150 modules",
    size: total(xqueries),
    run: () => each(xqueries, (q) => XQuery.compile(q)),
    expected: 150
  }
)

// ---- effect-ext -------------------------------------------------------------

const robotsLine: ReadonlyArray<(i: number) => string> = [
  (i) => `\nUser-agent: Bot${i}/1.0 # crawler ${i}`,
  () => `User-Agent: *`,
  (i) => `Crawl-delay: ${1 + (i % 30)}`,
  (i) => `Allow: /public/${i}/*.html$`,
  (i) => `Sitemap: https://example.org/sitemaps/${i}.xml`,
  (i) => `# a comment line about section ${i}`,
  (i) => `not a directive at all ${i}`,
  (i) => `Disallow: /private/${i}/?session=*&page=${i}`
]
const robots = lines(4000, (i) => robotsLine[i % 8]?.(i) ?? "")
const timestamps = Array.from(
  { length: 3000 },
  (_, i) =>
    `20${pad(i % 100)}-${pad(1 + (i % 12))}-${pad(1 + (i % 28))}T${pad(i % 24)}:${pad(i % 60)}:${pad((i * 7) % 60)}${
      i % 3 === 0 ? "Z" : i % 3 === 1 ? `.${pad(i % 1000, 3)}+10:30` : `.${pad(i % 1000000, 6)}-08:00`
    }`
)
const crons = Array.from(
  { length: 3000 },
  (_, i) =>
    `${i % 60} ${i % 2 === 0 ? `*/${1 + (i % 12)}` : `${i % 12},${12 + (i % 12)}`} 1-${1 + (i % 28)} JAN,MAR,DEC MON-FRI`
)
const rrules = Array.from(
  { length: 3000 },
  (_, i) =>
    `FREQ=${["DAILY", "WEEKLY", "MONTHLY", "YEARLY"][i % 4]};INTERVAL=${1 + (i % 6)};BYDAY=${i % 4 < 2 ? "MO,TU,FR" : "MO,+2TU,-1FR"};BYMONTH=1,6,${1 + (i % 12)};BYHOUR=${i % 24};WKST=SU;UNTIL=20${pad(26 + (i % 60))}1231T235959Z`
)
const durations = Array.from(
  { length: 3000 },
  (_, i) => `P${i % 9}Y${i % 12}M${i % 28}DT${i % 24}H${i % 60}M${i % 60}.${pad(i % 1000, 3)}S`
)
cases.push(
  {
    group: "effect-ext",
    name: "Robots.parse, 4000 lines",
    size: robots.length,
    run: () => Robots.parse(robots).groups.length,
    expected: 500
  },
  {
    group: "effect-ext",
    name: "Rfc3339.parse, 3000 date-times",
    size: total(timestamps),
    run: () => each(timestamps, sync(Rfc3339.parse)),
    expected: 3000
  },
  {
    group: "effect-ext",
    name: "CronExpression.parse, 3000",
    size: total(crons),
    run: () => each(crons, sync(CronExpression.parse)),
    expected: 3000
  },
  {
    group: "effect-ext",
    name: "RRule.parse, 3000 rules",
    size: total(rrules),
    run: () => each(rrules, sync(RRule.parse)),
    expected: 3000
  },
  {
    group: "effect-ext",
    name: "IsoDuration.parse, 3000",
    size: total(durations),
    run: () => each(durations, sync(IsoDuration.parse)),
    expected: 3000
  }
)

// ---- run --------------------------------------------------------------------

const [filter = "", roundsArg = "20"] = process.argv.slice(2)
const rounds = Number(roundsArg)
const selected = cases.filter((c) => `${c.group} / ${c.name}`.includes(filter))

// Every case must parse its whole document before it is timed
for (const c of selected) {
  const found = c.run()
  if (found !== c.expected) throw new Error(`${c.group} / ${c.name}: found ${found}, expected ${c.expected}`)
}

const best = bestOf(selected, rounds)

console.log(`best of ${rounds} interleaved runs\n`)
let group = ""
for (const c of selected) {
  if (c.group !== group) {
    group = c.group
    console.log(group)
  }
  const ms = best.get(c) ?? Infinity
  const mchars = c.size / 1e6 / (ms / 1000)
  console.log(
    `  ${c.name.padEnd(42)} ${(c.size / 1e3).toFixed(0).padStart(5)} K chars ${ms.toFixed(2).padStart(8)} ms ${mchars.toFixed(1).padStart(6)} M chars/s`
  )
}
