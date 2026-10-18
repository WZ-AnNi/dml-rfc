/**
 * seeds.test.mjs — the seed proposals must satisfy the contract they document.
 *
 * `seeds/` holds RFCs written before the repository existed, waiting to be filed.
 * If a seed failed `rfc check`, that would mean the template asks for something
 * its own authors did not provide — the contract would be wrong, not the seed.
 * So seeds are validated here.
 *
 * A seed is validated the way `rfc submit` does it: the `# ` heading is the
 * title, everything after is the body.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { validateRfc } from "./rfc-lib.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const SEEDS = join(HERE, "..", "seeds")

/** Split a draft into `{ title, body }`, exactly as the CLI does. */
function readDraft(path) {
  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n")
  const lines = raw.split("\n")
  let title = ""
  let i = 0
  for (; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i]) && !/^##/.test(lines[i])) {
      title = lines[i].replace(/^#\s+/, "").trim()
      i++
      break
    }
  }
  return { title, body: lines.slice(i).join("\n").trim() }
}

test("seeds/ exists and holds the proposals", () => {
  assert.ok(existsSync(SEEDS), "seeds/ directory is missing")
  const files = readdirSync(SEEDS).filter((f) => f.endsWith(".md"))
  assert.ok(files.length >= 2, `expected the seed RFCs, found ${files.length}`)
})

for (const file of existsSync(SEEDS) ? readdirSync(SEEDS).filter((f) => f.endsWith(".md")) : []) {
  test(`seed ${file} satisfies the RFC contract`, () => {
    const { title, body } = readDraft(join(SEEDS, file))
    const r = validateRfc({ title, body })
    assert.deepEqual(
      r.errors,
      [],
      `${file} would be rejected by its own validator:\n  ${r.errors.join("\n  ")}`,
    )
  })

  test(`seed ${file} is substantial, not a stub`, () => {
    const { body } = readDraft(join(SEEDS, file))
    assert.ok(body.length > 2000, `${file} is only ${body.length} chars — looks like a stub`)
  })
}

test("seed proposals are honest about their costs", () => {
  // both seeds add real surface; an RFC without a Drawbacks section would be
  // hiding that
  for (const file of readdirSync(SEEDS).filter((f) => f.endsWith(".md"))) {
    const { body } = readDraft(join(SEEDS, file))
    assert.match(body, /^### Drawbacks$/m, `${file} has no Drawbacks section`)
  }
})

test("seeds do not use a reserved-word-only marker as syntax", () => {
  // the contract warns against it; the seeds must not violate the rule they cite
  for (const file of readdirSync(SEEDS).filter((f) => f.endsWith(".md"))) {
    const { body } = readDraft(join(SEEDS, file))
    // a dunder marker is the exact anti-pattern called out in the template
    assert.ok(
      !/@__[a-z]+__\s*:/.test(body.replace(/`[^`]*`/g, "")),
      `${file} proposes a dunder attribute outside code spans`,
    )
  }
})
