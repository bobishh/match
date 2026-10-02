import { readFile, readdir, mkdir, writeFile } from "node:fs/promises"
import { resolve, join, relative } from "node:path"
import v8toIstanbul from "v8-to-istanbul"
import coverage from "istanbul-lib-coverage"
import report from "istanbul-lib-report"
import reports from "istanbul-reports"

const input = resolve(process.argv[2] ?? "test-results")
const output = resolve(process.argv[3] ?? "coverage/e2e")
const maps = new Map()
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collect(path)
    else if (entry.name === "source-coverage.json") await convert(JSON.parse(await readFile(path, "utf8")))
  }
}
async function convert(raw) {
  if (raw.status !== "passed") return
  const map = maps.get(raw.title) ?? coverage.createCoverageMap({})
  for (const entry of raw.entries) {
    const path = resolve(`.${new URL(entry.url).pathname}`)
    const converter = v8toIstanbul(path, 0, { source: entry.source })
    await converter.load()
    converter.applyCoverage(entry.functions)
    for (const [file, data] of Object.entries(converter.toIstanbul())) {
      const normalized = relative(process.cwd(), file)
      if (normalized.startsWith("src/") && !normalized.startsWith("src/vendor/")) map.addFileCoverage(data)
    }
  }
  maps.set(raw.title, map)
}
await collect(input)
if (!maps.size) throw new Error("No passed browser coverage collected. Run tests with MATCH_E2E_COVERAGE=1.")
const combined = coverage.createCoverageMap({})
for (const map of maps.values()) combined.merge(map)
if (!combined.files().length) throw new Error("Browser coverage has no source mappings; do not publish an empty report")
await mkdir(output, { recursive: true })
const context = report.createContext({ dir: output, coverageMap: combined })
for (const name of ["html", "json", "json-summary", "lcovonly", "text-summary"]) reports.create(name).execute(context)
const rows = []
for (const [title, map] of maps) {
  const remaining = coverage.createCoverageMap({})
  for (const [other, value] of maps) if (other !== title) remaining.merge(value)
  let uniqueStatements = 0
  for (const file of map.files()) {
    const data = map.fileCoverageFor(file).toJSON()
    const other = remaining.files().includes(file) ? remaining.fileCoverageFor(file).toJSON() : null
    const covered = new Set(Object.entries(other?.statementMap ?? {}).filter(([id]) => other.s[id] > 0).map(([, location]) => JSON.stringify(location)))
    for (const [id, location] of Object.entries(data.statementMap)) if (data.s[id] > 0 && !covered.has(JSON.stringify(location))) uniqueStatements++
  }
  rows.push({ title, sourceFiles: map.files().length, uniqueStatements: map.files().length ? uniqueStatements : null })
}
await writeFile(join(output, "test-contributions.json"), JSON.stringify({
  scope: "Passed fixture-page main-thread JavaScript. Extra pages, Workers, WASM, CSS, and performance benchmarks excluded. Zero unique statements does not establish redundant assertions.",
  tests: rows.sort((a, b) => a.uniqueStatements - b.uniqueStatements),
}, null, 2) + "\n")
console.log(`Browser coverage: ${maps.size} passed scenarios; ${combined.files().length} source files; ${output}`)
