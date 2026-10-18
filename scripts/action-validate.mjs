/**
 * action-validate.mjs — the validation Action's entry point.
 *
 * Runs on `issues: opened/edited/labeled`. It validates the RFC against the
 * same library the CLI uses, enforces the stage state machine, and comments with
 * any problems so the author sees them where they wrote.
 *
 * Two rules shape everything here:
 *
 *   1. **The issue body is untrusted DATA.** It is read, parsed and quoted back
 *      as text. It is never executed, eval'd, or interpolated into a shell
 *      command. GitHub's own advice; also simple prudence.
 *   2. **A rejected RFC stays filed.** `stage:draft` is not a rejection — the
 *      issue remains the record. The Action comments and labels, but never
 *      closes or deletes anything, so a bad first draft can be edited in place
 *      and the same id carries it forward.
 *
 * Environment (set by the workflow): GITHUB_TOKEN, GITHUB_REPOSITORY,
 * ISSUE_NUMBER. The event payload arrives on stdin as JSON.
 */
import { readFileSync } from "node:fs"

import { STAGE_PREFIX, canTransition, readStage, rfcId, validateRfc } from "./rfc-lib.mjs"

const API = "https://api.github.com"
const TOKEN = process.env.GITHUB_TOKEN
const REPO = process.env.GITHUB_REPOSITORY
const ISSUE = process.env.ISSUE_NUMBER

/** A marker so re-runs replace their own comment instead of piling up. */
const MARKER = "<!-- rfc-validator -->"

function die(msg) {
  console.error(`action-validate: ${msg}`)
  process.exit(1)
}

if (!TOKEN) die("GITHUB_TOKEN is not set")
if (!REPO) die("GITHUB_REPOSITORY is not set")

/**
 * A minimal REST call. Uses fetch (Node 18+), no third-party action involved,
 * so the whole logic stays auditable in this file.
 */
async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.status === 204 ? null : res.json()
}

/** The event payload, read from stdin (never from argv). */
function readEvent() {
  try {
    const raw = readFileSync(0, "utf8")
    return raw.trim() ? JSON.parse(raw) : null
  } catch (e) {
    die(`could not read the event payload from stdin: ${e.message}`)
  }
}

const event = readEvent()
const eventName = process.env.GITHUB_EVENT_NAME ?? ""
const issue = event?.issue
const number = issue?.number ?? (ISSUE ? Number(ISSUE) : null)
if (!number) die("no issue number in the event payload or environment")

const labels = (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l.name))

// ---------------------------------------------------------------------------
// validate the RFC content
// ---------------------------------------------------------------------------

const res = validateRfc({ title: issue?.title ?? "", body: issue?.body ?? "" })

// ---------------------------------------------------------------------------
// enforce the stage machine
// ---------------------------------------------------------------------------

const stageInfo = readStage(labels)
const stageProblems = []
for (const e of res.errors) if (e.startsWith("Conflicting stage")) stageProblems.push(e)
for (const e of res.errors) if (e.startsWith("Unknown stage")) stageProblems.push(e)

// On a `labeled` event we can check the transition itself: the label that was
// just added versus the one that was there before.
if (eventName === "issues" && event?.action === "labeled" && event.label) {
  const added = event.label.name
  if (added.startsWith(STAGE_PREFIX)) {
    const to = added.slice(STAGE_PREFIX.length)
    const from = stageInfo.stage
    // `readStage` already includes the new label, so a conflict means the old
    // one was not removed. Only report a *missing* transition, not a conflict.
    if (!stageInfo.conflict && !canTransition(from === to ? from : null, to) && from !== to) {
      const prev = labels.filter(
        (l) => l.startsWith(STAGE_PREFIX) && l !== added,
      )
      if (prev.length === 0 && !canTransition(null, to)) {
        stageProblems.push(
          `Cannot move to \`${added}\` directly. A new RFC starts at \`${STAGE_PREFIX}draft\` ` +
            `and must pass through \`${STAGE_PREFIX}review\` before being accepted or rejected.`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// also require the rfc label and exactly one stage for tracked issues
// ---------------------------------------------------------------------------

const contentErrors = res.errors.filter((e) => !stageProblems.includes(e))
const problems = [...contentErrors, ...stageProblems]

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function buildComment() {
  const lines = []
  lines.push(MARKER)
  lines.push(`### RFC validation — ${rfcId(issue.number)}`)
  lines.push("")

  if (problems.length === 0 && res.warnings.length === 0) {
    lines.push(`✅ **Well-formed.** The id is \`${rfcId(issue.number)}\` — it is final, allocated from this issue number.`)
    lines.push("")
    lines.push(`Current stage: \`${STAGE_PREFIX}${stageInfo.stage ?? "draft"}\``)
    return lines.join("\n")
  }

  if (problems.length > 0) {
    lines.push(`❌ **${problems.length} problem${problems.length === 1 ? "" : "s"} to fix:**`)
    lines.push("")
    for (const p of problems) lines.push(`- ${p}`)
    lines.push("")
    lines.push("Edit the issue body above and the check re-runs automatically.")
  }

  if (res.warnings.length > 0) {
    if (problems.length > 0) lines.push("")
    lines.push(`⚠️ **${res.warnings.length} warning${res.warnings.length === 1 ? "" : "s"}:**`)
    lines.push("")
    for (const w of res.warnings) lines.push(`- ${w}`)
  }

  return lines.join("\n")
}

/** Find this Action's previous comment, so it is edited not duplicated. */
async function existingCommentId() {
  const comments = await api(`/repos/${REPO}/issues/${number}/comments?per_page=100`)
  const mine = comments.find((c) => (c.body ?? "").includes(MARKER))
  return mine?.id ?? null
}

async function upsertComment(body) {
  const id = await existingCommentId()
  if (id) {
    await api(`/repos/${REPO}/issues/comments/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    })
    console.log(`updated comment ${id}`)
    return
  }
  await api(`/repos/${REPO}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  })
  console.log("posted a new comment")
}

// ---------------------------------------------------------------------------
// labels: keep the stage well-formed without inventing a stage
// ---------------------------------------------------------------------------

async function normaliseStageLabels() {
  // Exactly one stage label, and `stage:draft` for a fresh issue. The Action
  // never advances a stage on its own — only a human decides review→accepted.
  if (stageInfo.conflict) {
    // destructive guesses are worse than leaving it flagged; the comment says so
    return
  }
  if (!stageInfo.stage) {
    await api(`/repos/${REPO}/issues/${number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [`${STAGE_PREFIX}draft`] }),
    })
    console.log(`added ${STAGE_PREFIX}draft`)
  }
  if (!labels.includes("rfc")) {
    await api(`/repos/${REPO}/issues/${number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: ["rfc"] }),
    })
    console.log("added rfc")
  }
}

// ---------------------------------------------------------------------------

await upsertComment(buildComment())
if (eventName === "issues" && (event?.action === "opened" || event?.action === "labeled")) {
  await normaliseStageLabels()
}

// A failed validation is a red check on the workflow run, but the issue stays
// open by design: the record matters more than a tidy queue.
if (problems.length > 0) {
  console.log(`${problems.length} validation problem(s) reported`)
  process.exit(1)
}
console.log("RFC is well-formed")
