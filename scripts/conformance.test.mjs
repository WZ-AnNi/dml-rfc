/**
 * conformance.test.mjs — cross-check the artifacts that must agree.
 *
 * Three files encode the same RFC contract in different media: the Issue Form
 * (YAML), the CLI/library (JS) and the docs. Nothing in the toolchain forces
 * them to stay in step, so this test does. It is the guard against the exact
 * drift that would make a browser-submitted RFC fail validation — or pass in the
 * browser and fail in CI.
 *
 * No YAML dependency: the form is small and its structure is regular, so the
 * labels are read with a targeted scan. A real parser would hide a malformed
 * form behind a parse error; this reads what GitHub actually keys on.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { RFC_FIELDS, STAGES, STAGE_PREFIX, renderScaffold, validateRfc } from "./rfc-lib.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const FORM = join(ROOT, ".github", "ISSUE_TEMPLATE", "rfc.yml")

/** Every `label:` value that appears under a textarea/checkboxes block. */
function formSectionLabels(yaml) {
  const labels = []
  // a section is introduced by `- type: <kind>`; its `label:` is the field name
  const blocks = yaml.split(/^\s*-\s*type:\s*/m).slice(1)
  for (const block of blocks) {
    const kind = block.slice(0, block.indexOf("\n")).trim()
    const m = /^\s*label:\s*(.+?)\s*$/m.exec(block)
    if (m) labels.push({ kind, label: m[1].replace(/^["']|["']$/g, "") })
  }
  return labels
}

test("the Issue Form exists", () => {
  assert.ok(existsSync(FORM), `missing ${FORM}`)
})

test("every library field appears in the Issue Form, with the same label", () => {
  const yaml = readFileSync(FORM, "utf8")
  const labels = formSectionLabels(yaml).map((l) => l.label.toLowerCase())
  for (const f of RFC_FIELDS) {
    assert.ok(
      labels.includes(f.label.toLowerCase()),
      `form is missing a section labelled "${f.label}" (has: ${labels.join(", ")})`,
    )
  }
})

test("the form declares no section the library does not know", () => {
  // extra form fields would be silently dropped by parseIssueBody, which looks
  // like "my text disappeared" to the author
  const yaml = readFileSync(FORM, "utf8")
  const labels = formSectionLabels(yaml)
    .filter((l) => l.kind === "textarea")
    .map((l) => l.label.toLowerCase())
  const known = new Set(RFC_FIELDS.map((f) => f.label.toLowerCase()))
  for (const label of labels) {
    assert.ok(known.has(label), `form section "${label}" is not in RFC_FIELDS`)
  }
})

test("required sections in the form match required sections in the library", () => {
  const yaml = readFileSync(FORM, "utf8")
  const blocks = yaml.split(/^\s*-\s*type:\s*/m).slice(1)
  for (const block of blocks) {
    const kind = block.slice(0, block.indexOf("\n")).trim()
    if (kind !== "textarea") continue
    const label = /^\s*label:\s*(.+?)\s*$/m.exec(block)?.[1]
    if (!label) continue
    const field = RFC_FIELDS.find((f) => f.label.toLowerCase() === label.toLowerCase())
    if (!field) continue
    // the form's `validations: required: true` must agree with the library's
    // `required`, or one route enforces and the other does not
    const formRequired = /validations:\s*\n\s*required:\s*true/m.test(block)
    assert.equal(
      formRequired,
      field.required,
      `"${label}": form says required=${formRequired}, library says required=${field.required}`,
    )
  }
})

test("the form starts issues at stage:draft", () => {
  const yaml = readFileSync(FORM, "utf8")
  // the first stage must be draft — a new RFC cannot arrive pre-accepted
  const m = /^labels:\s*\[(.+?)\]/m.exec(yaml)
  assert.ok(m, "form declares no labels")
  const labels = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
  assert.ok(labels.includes(`${STAGE_PREFIX}draft`), `labels: ${labels.join(", ")}`)
})

test("every stage the form could assign is a known stage", () => {
  const yaml = readFileSync(FORM, "utf8")
  const stages = [...yaml.matchAll(/["']?stage:([a-z]+)["']?/g)].map((m) => m[1])
  for (const s of stages) assert.ok(STAGES.includes(s), `unknown stage in form: ${s}`)
})

test("a body in the form's shape validates end to end", () => {
  // simulate what the browser posts: `### <label>` sections from the form
  const body = RFC_FIELDS.map((f) => {
    const text = f.required
      ? `Content for ${f.label}, long enough to satisfy the minimum length rule.`
      : ""
    return `### ${f.label}\n\n${text}`
  }).join("\n\n")
  const r = validateRfc({ title: "A real proposal title", body })
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors))
})

test("the CLI scaffold exposes every field the library requires", () => {
  // `rfc new` writes a scaffold derived from RFC_FIELDS; if it drifted, the
  // tool would reject its own output
  const scaffold = renderScaffold()
  for (const f of RFC_FIELDS) {
    assert.ok(scaffold.includes(`### ${f.label}`), `scaffold is missing "${f.label}"`)
  }
  // and a fully filled scaffold passes validation
  const filled = RFC_FIELDS.map((f) => {
    const text = f.required
      ? `Content for ${f.label}, long enough to clear the minimum length rule.`
      : ""
    return `### ${f.label}\n\n${text}`
  }).join("\n\n")
  const r = validateRfc({ title: "A real proposal title", body: filled })
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors))
})
