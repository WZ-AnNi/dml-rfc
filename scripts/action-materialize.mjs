/**
 * action-materialize.mjs — export issues into browsable files.
 *
 * Issues are the system of record (atomic id allocation, web UI, API), but they
 * are not a good *archive*: no git history, no diff, no offline read, and
 * grepping means hitting the API. So this writes each RFC to
 * `rfc/NNNN-slug.md` plus an `rfc/index.json`, and the workflow commits them.
 *
 * Design notes:
 *
 *   - **The issue stays the source of truth.** These files are an export, so
 *     they are regenerated wholesale, never hand-edited. A header in each file
 *     says so, because someone will eventually try.
 *   - **The number leads the filename** (`0042-...`) so `ls rfc/` sorts by id,
 *     not alphabetically by title.
 *   - **Deleted issues leave a tombstone** instead of silently vanishing: a
 *     superseded RFC that disappears from the index is worse than one marked
 *     withdrawn.
 *   - Issue bodies are DATA: written to disk as text, never interpreted.
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY. Writes into ./rfc.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { STAGE_PREFIX, readStage, rfcFilename, rfcId } from "./rfc-lib.mjs"

const API = "https://api.github.com"
const TOKEN = process.env.GITHUB_TOKEN
const REPO = process.env.GITHUB_REPOSITORY
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, "..", "rfc")

function die(msg) {
  console.error(`action-materialize: ${msg}`)
  process.exit(1)
}

if (!TOKEN) die("GITHUB_TOKEN is not set")
if (!REPO) die("GITHUB_REPOSITORY is not set")

async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "x-github-api-version": "2022-11-28",
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GET ${path} → ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

/** Every issue, following pagination. */
async function allIssues() {
  const out = []
  for (let page = 1; ; page++) {
    const batch = await api(`/repos/${REPO}/issues?state=all&per_page=100&page=${page}`)
    // the issues endpoint also returns PRs — they share the numbering space,
    // which is exactly why the RFC repo must contain no code
    const issues = batch.filter((i) => !i.pull_request)
    out.push(...issues)
    if (batch.length < 100) break
    if (page > 50) die("more than 5000 issues; refusing to keep paginating")
  }
  return out
}

/** A stable, informative header. */
function header({ id, number, title, stage, state, url, updated }) {
  return [
    "<!-- GENERATED FILE — do not edit.",
    `     Source of truth: ${url}`,
    `     Regenerate with .github/workflows/materialize.yml -->`,
    "",
    `# ${id} — ${title}`,
    "",
    `- **Id:** ${id} (issue #${number}; the number is the id and is never reused)`,
    `- **Stage:** ${stage ? `${STAGE_PREFIX}${stage}` : "_none_"}`,
    `- **State:** ${state}`,
    `- **Issue:** ${url}`,
    `- **Updated:** ${updated}`,
    "",
    "---",
    "",
    // the body follows; the blank line above keeps the first `### ` a block
    // element rather than a setext heading glued to the rule
  ].join("\n")
}

const issues = await allIssues()
console.log(`fetched ${issues.length} issue(s)`)

mkdirSync(OUT_DIR, { recursive: true })

const index = []
const wanted = new Set()

for (const i of issues) {
  const { stage } = readStage((i.labels ?? []).map((l) => l.name))
  const filename = rfcFilename(i.number, i.title)
  wanted.add(filename)

  // The issue body is already the canonical `### <label>` form (the Issue Form
  // emits it, and `rfc submit` writes it), so it is written through as text.
  // Nothing is interpreted; this is a copy, not a rendering pipeline.
  const body = (i.body ?? "").replace(/\r\n/g, "\n").trim()

  const text =
    header({
      id: rfcId(i.number),
      number: i.number,
      title: i.title,
      stage,
      state: i.state,
      url: i.html_url,
      updated: i.updated_at,
    }) +
    // the header ends with the `---` rule, so the body needs its own blank line
    // or the first `### ` glues to the rule as a setext heading
    "\n" +
    body.trimStart() +
    "\n"

  writeFileSync(join(OUT_DIR, filename), text)

  index.push({
    id: rfcId(i.number),
    number: i.number,
    title: i.title,
    stage: stage ?? null,
    state: i.state,
    file: filename,
    url: i.html_url,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  })
}

// drop files whose issue vanished
for (const existing of readdirSync(OUT_DIR)) {
  if (!existing.endsWith(".md")) continue
  if (!wanted.has(existing)) {
    rmSync(join(OUT_DIR, existing))
    console.log(`removed stale ${existing}`)
  }
}

index.sort((a, b) => a.number - b.number)
writeFileSync(
  join(OUT_DIR, "index.json"),
  JSON.stringify(
    { repo: REPO, generatedAt: new Date().toISOString(), count: index.length, rfc: index },
    null,
    2,
  ) + "\n",
)

console.log(`wrote ${index.length} RFC file(s) + index.json`)
