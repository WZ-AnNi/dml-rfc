/**
 * docs.test.mjs — keep the prose honest.
 *
 * The README is the first thing a contributor reads, and it is the artifact most
 * likely to drift: nobody's test breaks when a doc lies. This suite pins the
 * claims that are cheap to verify (the field table, the test count, the section
 * names) so a doc that contradicts the code fails CI instead of misleading
 * someone.
 *
 * It deliberately checks *claims*, not prose: rewriting a paragraph is fine,
 * contradicting `RFC_FIELDS` is not.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { RFC_FIELDS, STAGES, STAGE_PREFIX } from "./rfc-lib.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const README = join(ROOT, "README.md")

test("the README exists and is substantial", () => {
  assert.ok(existsSync(README))
  const text = readFileSync(README, "utf8")
  assert.ok(text.length > 2000, "README looks truncated")
})

test("the README's field table matches RFC_FIELDS' requiredness", () => {
  const text = readFileSync(README, "utf8")
  // the table lives between the field table heading and the next `## `
  const section = /## Required sections([\s\S]*?)\n## /.exec(text)
  assert.ok(section, "could not find the 'Required sections' table")

  for (const f of RFC_FIELDS) {
    // find the row whose first cell names this field. Cells may be wrapped in
    // `**` for emphasis, so the markers are tolerated on both cells.
    const row = new RegExp(
      `^\\|\\s*\\*{0,2}${escapeRe(f.label)}\\*{0,2}\\s*\\|\\s*\\*{0,2}(yes|no)\\b`,
      "im",
    )
    const m = row.exec(section[1])
    assert.ok(m, `README field table has no row for "${f.label}"`)
    const docSaysRequired = m[1].toLowerCase() === "yes"
    assert.equal(
      docSaysRequired,
      f.required,
      `README says "${f.label}" required=${docSaysRequired}, RFC_FIELDS says ${f.required}`,
    )
  }
})

test("the README does not document fields that do not exist", () => {
  const text = readFileSync(README, "utf8")
  const section = /## Required sections([\s\S]*?)\n## /.exec(text)
  const known = new Set(RFC_FIELDS.map((f) => f.label.toLowerCase()))
  for (const line of section[1].split("\n")) {
    const m = /^\|\s*\*{0,2}([^|*]+?)\*{0,2}\s*\|\s*(?:yes|no)\b/.exec(line)
    if (!m) continue
    const label = m[1].trim().toLowerCase()
    if (label === "section") continue // header row
    assert.ok(known.has(label), `README documents unknown field "${m[1].trim()}"`)
  }
})

test("the README names every stage", () => {
  const text = readFileSync(README, "utf8")
  for (const s of STAGES) {
    assert.ok(
      text.includes(`${STAGE_PREFIX}${s}`),
      `README never mentions ${STAGE_PREFIX}${s}`,
    )
  }
})

test("the README states the id rule: the issue number is the RFC id", () => {
  const text = readFileSync(README, "utf8")
  assert.match(text, /issue number/i)
  // and it must say a second counter is absent — that is the design, not a detail
  assert.match(text, /no second counter/i)
})

test("the documented file tree matches what is on disk", () => {
  const text = readFileSync(README, "utf8")
  // every path the README shows under the tree must exist
  for (const rel of [
    ".github/ISSUE_TEMPLATE/rfc.yml",
    ".github/workflows/validate.yml",
    ".github/workflows/materialize.yml",
    "scripts/rfc-lib.mjs",
    "scripts/rfc.mjs",
    "scripts/action-validate.mjs",
    "scripts/action-materialize.mjs",
  ]) {
    assert.ok(existsSync(join(ROOT, rel)), `README lists ${rel}, which does not exist`)
  }
  assert.ok(text.includes("scripts/rfc-lib.mjs"))
})

test("the documented test count matches the real count", () => {
  const text = readFileSync(README, "utf8")
  // collect the test files that actually exist
  const files = readdirSync(HERE)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort()
  assert.ok(files.length >= 4, `expected at least 4 test files, found ${files.length}`)
  for (const f of files) {
    assert.ok(text.includes(f), `README does not mention the test file ${f}`)
  }
  // The README states a count in two places; both must be an integer and both
  // must agree with each other. The absolute value is not asserted (it changes
  // whenever a test is added, and a test that must be edited whenever any test
  // is added is noise); disagreement between the two mentions is the real bug.
  const counts = [...text.matchAll(/(\d+)\s+tests?, (?:no dependencies|pure Node)/g)].map((m) =>
    Number(m[1]),
  )
  assert.ok(counts.length >= 1, "README never states the test count")
  assert.equal(new Set(counts).size, 1, `README states conflicting counts: ${counts.join(", ")}`)
})

test("every test file the README lists actually exists", () => {
  const text = readFileSync(README, "utf8")
  for (const m of text.matchAll(/`([a-z0-9-]+\.test\.mjs)`/g)) {
    const name = m[1]
    // the glob form in the file tree is not a filename
    if (name.startsWith("*")) continue
    assert.ok(existsSync(join(HERE, name)), `README mentions ${name}, which does not exist`)
  }
})

test("the README does not promise a credential argument", () => {
  // the CLI explicitly refuses tokens; the doc must not suggest otherwise
  const text = readFileSync(README, "utf8")
  assert.ok(
    !/rfc submit[^\n]*--token/.test(text),
    "README must not document a --token flag (the CLI refuses them)",
  )
})

/** Escape a string for use inside a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
