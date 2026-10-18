/**
 * rfclib.test.mjs — self-test for rfc-lib, run with `node --test`.
 *
 * No network, no GitHub, no fixtures on disk: the library is pure, so its
 * contract can be pinned here. The Action and the CLI both depend on it, and a
 * regression in either direction (too strict → real RFCs rejected; too loose →
 * junk materialized) is caught on this page.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  RFC_FIELDS,
  STAGES,
  STAGE_PREFIX,
  TRANSITIONS,
  canTransition,
  normaliseTitle,
  parseIssueBody,
  readStage,
  renderRfcBody,
  rfcFilename,
  rfcId,
  scanSecrets,
  slugify,
  splitSections,
  validateRfc,
} from "./rfc-lib.mjs"

/** A minimal RFC that must pass validation. */
function goodBody() {
  return renderRfcBody({
    summary: "Compile a DML template into static HTML and generic XML markup.",
    motivation:
      "Today a template can only be rendered through the live runtime, so any consumer that speaks XML cannot use DML at all.",
    shapeRationale:
      "The emitter is a subcommand of the existing CLI (`dml emit --to html`), not new syntax, so it adds no reserved words to the language.",
    proposal:
      "Walk the hoisted shape array and serialize it. Reject dynamic bindings in v1; define the runtime-only prop policy explicitly.",
    alternatives: "A second runtime host was rejected: serialization needs no reactivity.",
    drawbacks: "Attribute semantics need a policy table; `onClick` has no static form.",
    unresolved: "Whether `@if` snapshots or is rejected.",
  })
}

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

test("rfcId derives from the issue number, so uniqueness is delegated", () => {
  assert.equal(rfcId(42), "RFC-42")
  assert.equal(rfcId("7"), "RFC-7")
  // a second counter must never be introduced — it would race
  assert.throws(() => rfcId(0))
  assert.throws(() => rfcId(-1))
  assert.throws(() => rfcId("abc"))
})

test("filename zero-pads and slugifies, keeping sort order stable", () => {
  assert.equal(rfcFilename(42, "Static markup emission"), "0042-static-markup-emission.md")
  assert.equal(rfcFilename(7, "XAML backend"), "0007-xaml-backend.md")
  // long titles are truncated without leaving a trailing dash
  const long = rfcFilename(1, "a".repeat(40) + " " + "b".repeat(40))
  assert.ok(long.endsWith(".md"))
  assert.ok(!long.includes("-.md"))
  assert.ok(!/-\.md$/.test(long))
})

test("slugify is stable and never empty", () => {
  assert.equal(slugify("Hello, World!"), "hello-world")
  assert.equal(slugify("  "), "rfc")
  assert.equal(slugify("RFC-0001: Foo"), "rfc-0001-foo")
  assert.equal(slugify("a".repeat(200)).length, 60)
})

// ---------------------------------------------------------------------------
// body parsing — the ONE path both submission routes share
// ---------------------------------------------------------------------------

test("splitSections keys on ### headings regardless of case or colon", () => {
  const s = splitSections("### Summary\n\nhi\n\n### MOTIVATION:\n\nwhy\n")
  assert.equal(s.get("summary"), "hi")
  assert.equal(s.get("motivation"), "why")
})

test("splitSections strips Issue Form HTML comments", () => {
  const body = "### Summary\n\n<!-- a hint the form leaves behind -->\nreal content\n"
  assert.equal(splitSections(body).get("summary"), "real content")
})

test("parseIssueBody maps every canonical field", () => {
  const fields = parseIssueBody(goodBody())
  for (const f of RFC_FIELDS) {
    assert.ok(f.key in fields, `missing ${f.key}`)
  }
  assert.match(fields.summary, /static HTML/)
})

test("an untouched form field (_No response_) counts as empty", () => {
  const body = renderRfcBody({ summary: "x".repeat(30) })
  const fields = parseIssueBody(body)
  assert.equal(fields.summary, "x".repeat(30))
  assert.equal(fields.alternatives, "")
})

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test("a well-formed RFC passes", () => {
  const r = validateRfc({ title: "Static markup emission", body: goodBody() })
  assert.deepEqual(r.errors, [])
  assert.equal(r.ok, true)
})

test("placeholders and short titles are rejected", () => {
  assert.equal(validateRfc({ title: "RFC", body: goodBody() }).ok, false)
  assert.equal(validateRfc({ title: "todo", body: goodBody() }).ok, false)
  assert.equal(validateRfc({ title: "wip: stuff", body: goodBody() }).ok, false)
  assert.equal(validateRfc({ title: "Untitled", body: goodBody() }).ok, false)
})

test("each required section is enforced, naming the heading", () => {
  for (const f of RFC_FIELDS.filter((x) => x.required)) {
    const fields = {
      summary: "s".repeat(40),
      motivation: "m".repeat(40),
      shapeRationale: "r".repeat(40),
      proposal: "p".repeat(40),
    }
    delete fields[f.key]
    const body = renderRfcBody(fields)
    const res = validateRfc({ title: "A real proposal title", body })
    assert.equal(res.ok, false, `${f.key} should be required`)
    assert.ok(
      res.errors.some((e) => e.includes(f.label)),
      `error should name "${f.label}", got ${JSON.stringify(res.errors)}`,
    )
  }
})

test("optional sections are not required", () => {
  const body = renderRfcBody({
    summary: "s".repeat(40),
    motivation: "m".repeat(40),
    shapeRationale: "r".repeat(40),
    proposal: "p".repeat(40),
  })
  assert.equal(validateRfc({ title: "A real proposal title", body }).ok, true)
})

test("the shape-rationale section is part of the contract", () => {
  // guards the rule that a new construct must state its shape, not just its name
  const keys = RFC_FIELDS.map((f) => f.key)
  assert.ok(keys.includes("shapeRationale"))
  assert.equal(RFC_FIELDS.find((f) => f.key === "shapeRationale").required, true)
})

// ---------------------------------------------------------------------------
// stage machine
// ---------------------------------------------------------------------------

test("readStage finds exactly one stage", () => {
  assert.equal(readStage([`${STAGE_PREFIX}draft`, "rfc"]).stage, "draft")
  assert.equal(readStage([]).stage, null)
  const two = readStage([`${STAGE_PREFIX}draft`, `${STAGE_PREFIX}review`])
  assert.equal(two.stage, null)
  assert.deepEqual(two.conflict, ["draft", "review"])
})

test("an unknown stage label is reported, not silently ignored", () => {
  const r = readStage([`${STAGE_PREFIX}banana`])
  assert.deepEqual(r.unknown, ["banana"])
  assert.equal(validateRfc({ title: "A real proposal title", body: goodBody(), labels: [`${STAGE_PREFIX}banana`] }).ok, false)
})

test("the transition table admits the lifecycle and blocks shortcuts", () => {
  assert.ok(canTransition("draft", "review"))
  assert.ok(canTransition("review", "accepted"))
  assert.ok(canTransition("review", "rejected"))
  assert.ok(canTransition("accepted", "superseded"))
  // no review before acceptance
  assert.ok(!canTransition("draft", "accepted"))
  // terminal states stay terminal
  for (const t of ["rejected", "withdrawn", "superseded"]) {
    assert.deepEqual(TRANSITIONS[t], [], `${t} must be terminal`)
  }
  // a missing stage reads as draft
  assert.ok(canTransition(null, "review"))
  assert.ok(!canTransition(null, "accepted"))
})

test("every stage is reachable and named in STAGES", () => {
  for (const s of Object.keys(TRANSITIONS)) assert.ok(STAGES.includes(s), `${s} missing from STAGES`)
})

// ---------------------------------------------------------------------------
// secrets — an issue body is world-readable
// ---------------------------------------------------------------------------

test("credential-shaped text is flagged with severity", () => {
  assert.equal(scanSecrets("no secrets here").length, 0)
  const ghp = scanSecrets("token: ghp_" + "a".repeat(36))
  assert.equal(ghp.length, 1)
  assert.equal(ghp[0].severity, "error")
  assert.ok(scanSecrets("-----BEGIN RSA PRIVATE KEY-----").length === 1)
})

test("a flagged secret blocks validation", () => {
  const body = goodBody() + "\n\n### Notes\n\nghp_" + "b".repeat(36)
  const r = validateRfc({ title: "A real proposal title", body })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /public/i.test(e)))
})

test("the reported sample is redacted, never the secret itself", () => {
  const secret = "ghp_" + "c".repeat(36)
  const [hit] = scanSecrets(secret)
  assert.ok(!hit.sample.includes(secret), "must not echo the full secret")
  assert.ok(hit.sample.includes("…"))
})

// ---------------------------------------------------------------------------
// escaping — issue text is DATA, never code
// ---------------------------------------------------------------------------

test("markdown/HTML in the body survives round-trip as text", () => {
  const nasty = "<script>alert(1)</script> && `rm -rf /`"
  const body = renderRfcBody({ summary: nasty })
  assert.equal(parseIssueBody(body).summary, nasty)
})

test("a heading injected inside a section does not become a field", () => {
  const body = renderRfcBody({ summary: "ok", proposal: "### Summary\ninjected" })
  // the injected heading starts a new (unrecognised) section
  const fields = parseIssueBody(body)
  assert.notEqual(fields.summary, "injected")
})

test("first occurrence wins, so a stray heading cannot overwrite a field", () => {
  // this is the exact case that broke before the fix: an RFC quoting markup
  const body =
    "### Summary\n\nreal summary\n\n### Proposal\n\n### Summary\noverwritten\n"
  const fields = parseIssueBody(body)
  assert.equal(fields.summary, "real summary")
})

test("a ### line inside a fenced code block is content, not a boundary", () => {
  // an RFC about markup WILL contain literal `### ` in its samples
  const sample = "```md\n### Summary\n\nthis is sample text\n```"
  const body = renderRfcBody({ summary: "s".repeat(40), proposal: sample })
  const fields = parseIssueBody(body)
  assert.ok(fields.proposal.includes("### Summary"), "fence content must survive")
  assert.equal(fields.summary, "s".repeat(40))
})

test("an RFC whose proposal is an HTML sample still validates", () => {
  const body = renderRfcBody({
    summary: "s".repeat(40),
    motivation: "m".repeat(40),
    shapeRationale: "r".repeat(40),
    proposal: "```html\n### heading\n<div a=\"b\">x</div>\n```",
  })
  assert.equal(validateRfc({ title: "Static markup emission", body }).ok, true)
})

test("normaliseTitle collapses whitespace", () => {
  assert.equal(normaliseTitle("  a \n  b  "), "a b")
})
