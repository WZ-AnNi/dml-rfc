#!/usr/bin/env node
/**
 * rfc — the RFC submission CLI.
 *
 * The reason this exists: submitting an RFC must not require touching the code
 * repository. An RFC is a proposal, not a patch, and an author without write
 * access (or who simply does not want a branch) still needs to file one. So
 * `submit` talks to the GitHub API and creates an ISSUE — no clone, no branch,
 * no pull request, no commit.
 *
 *   rfc new [slug]           scaffold a local draft
 *   rfc check <file>         validate locally (same code CI runs)
 *   rfc submit <file>        create the issue  ← the point of this tool
 *   rfc list                 list RFCs with stage / id
 *   rfc show <id>            full body + metadata
 *   rfc status <id> <stage>  move a stage (needs permission)
 *   rfc sync                 refresh ./rfc/index.json from the API
 *
 * Authentication is delegated entirely to `gh auth login` (or a GITHUB_TOKEN the
 * user sets themselves). This program NEVER accepts a token argument, never
 * prints one, and never writes one to disk — handling credentials is the caller's
 * business, not a CLI's.
 *
 * Issue bodies are DATA. Nothing here executes, evals or interpolates them.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  RFC_FIELDS,
  STAGES,
  STAGE_PREFIX,
  canTransition,
  normaliseTitle,
  parseIssueBody,
  readStage,
  renderRfcBody,
  renderScaffold,
  rfcId,
  validateRfc,
} from "./rfc-lib.mjs"

// ---------------------------------------------------------------------------
// repo target: resolved from git remote, overridable by env
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")

/** `OWNER/NAME` of the RFC repo. */
function repoSlug() {
  if (process.env.RFC_REPO) return process.env.RFC_REPO
  // the repo this CLI ships in owns the issues
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // git prints "not a git repository" on stderr when there is no remote;
      // that is an expected probe outcome, not something to show the user.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url)
    if (m) return m[1]
  } catch {
    /* no git or no remote — callers report the remedy */
  }
  return null
}

/** Run `gh` and parse its JSON. Never passes a token. */
function gh(args, { json = true, allowFail = false } = {}) {
  try {
    const out = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return json ? JSON.parse(out) : out
  } catch (e) {
    if (allowFail) return null
    const msg = (e.stderr ?? e.message ?? "").toString().trim()
    die(msg || `gh ${args.join(" ")} failed`)
  }
}

function die(msg, code = 1) {
  console.error(`rfc: ${msg}`)
  process.exit(code)
}

/** Ensure auth before any API call, with a clear remedy. */
function requireAuth() {
  const r = (() => {
    try {
      execFileSync("gh", ["auth", "status"], { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  })()
  if (!r) {
    die(
      "not authenticated with GitHub.\n" +
        "  Run:  gh auth login\n" +
        "  (or export GITHUB_TOKEN yourself — this tool will not handle it for you)",
    )
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function cmdNew(args) {
  const slug = args[0] ?? "untitled"
  // RFC_DRAFTS_DIR lets a draft live outside the repo (and lets tests use a
  // temp dir). Default: ./drafts next to this tool.
  const dir = process.env.RFC_DRAFTS_DIR
    ? resolve(process.env.RFC_DRAFTS_DIR)
    : join(REPO_ROOT, "drafts")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${slug.replace(/[^a-zA-Z0-9_-]/g, "-")}.md`)
  if (existsSync(file)) die(`${file} already exists`)
  writeFileSync(file, renderScaffold())
  console.log(file)
  console.log("\nFill in the sections, then:\n  rfc check <file>\n  rfc submit <file>")
}

/** The first `# ` heading is the title; the rest is the body. */
function readDraft(path) {
  if (!existsSync(path)) die(`no such file: ${path}`)
  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n")
  const lines = raw.split("\n")
  let title = ""
  let i = 0
  for (; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i])
    // skip a leading `##`-level heading: only a single `#` is the title
    if (m && !/^##/.test(lines[i])) {
      title = m[1]
      i++
      break
    }
  }
  const body = lines.slice(i).join("\n").trim()
  return { title: normaliseTitle(title), body }
}

function cmdCheck(args) {
  const path = args[0]
  if (!path) die("usage: rfc check <file>")
  const { title, body } = readDraft(path)
  const res = validateRfc({ title, body })
  report(res)
  process.exit(res.ok ? 0 : 1)
}

function report(res) {
  for (const w of res.warnings) console.warn(`  warning: ${w}`)
  for (const e of res.errors) console.error(`  error: ${e}`)
  if (res.ok) console.log("ok — RFC is well-formed")
}

function cmdSubmit(args) {
  const path = args[0]
  if (!path) die("usage: rfc submit <file>")
  const dryRun = args.includes("--dry-run")
  const { title, body } = readDraft(path)

  const res = validateRfc({ title, body })
  if (!res.ok) {
    console.error(`refusing to submit — fix these first:`)
    report(res)
    process.exit(1)
  }
  for (const w of res.warnings) console.warn(`  warning: ${w}`)

  if (dryRun) {
    console.log("--dry-run: nothing submitted.\n")
    console.log(`title: ${title}`)
    console.log(`labels: ${STAGE_PREFIX}draft`)
    console.log(`body:\n${body}`)
    return
  }

  const repo = repoSlug()
  if (!repo) die("cannot determine the RFC repo. Set RFC_REPO=owner/name.")
  requireAuth()

  // draft is the only legal starting stage
  const issue = gh([
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
    "--label",
    `${STAGE_PREFIX}draft`,
  ], { json: false })

  const url = issue.trim().split("\n").pop()
  const num = /\/issues\/(\d+)/.exec(url)
  const id = num ? rfcId(num[1]) : "RFC-?"
  console.log(`${id}\n${url}`)
  console.log("\nThe id is final: GitHub allocated it atomically and never reuses it.")
}

function cmdList(args) {
  const repo = repoSlug()
  if (!repo) die("cannot determine the RFC repo. Set RFC_REPO=owner/name.")
  requireAuth()
  const wantStage = args.includes("--stage") ? args[args.indexOf("--stage") + 1] : null

  const issues = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--limit",
    "500",
    "--json",
    "number,title,labels,state,url",
  ])

  const rows = issues
    .map((i) => {
      const { stage } = readStage(i.labels.map((l) => l.name))
      return {
        id: rfcId(i.number),
        n: i.number,
        title: i.title,
        stage: stage ?? "—",
        state: i.state,
        url: i.url,
      }
    })
    .filter((r) => !wantStage || r.stage === wantStage)
    .sort((a, b) => a.n - b.n)

  if (!rows.length) {
    console.log(wantStage ? `no RFCs at stage:${wantStage}` : "no RFCs yet")
    return
  }
  const w = Math.max(...rows.map((r) => r.id.length))
  for (const r of rows) {
    console.log(`${r.id.padEnd(w)}  ${r.stage.padEnd(11)}  ${r.title}`)
  }
  console.log(`\n${rows.length} RFC(s)`)
}

function cmdShow(args) {
  const id = args[0]
  if (!id) die("usage: rfc show <RFC-N>")
  const n = parseId(id)
  const repo = repoSlug()
  if (!repo) die("cannot determine the RFC repo. Set RFC_REPO=owner/name.")
  requireAuth()
  const issue = gh([
    "issue",
    "view",
    String(n),
    "--repo",
    repo,
    "--json",
    "number,title,body,labels,state,url,createdAt",
  ])
  const { stage } = readStage(issue.labels.map((l) => l.name))
  console.log(`${rfcId(issue.number)}  [${stage ?? "no stage"}]  (${issue.state})`)
  console.log(issue.title)
  console.log(issue.url)
  console.log(`opened ${issue.createdAt}\n`)
  console.log(issue.body)
}

function parseId(s) {
  const m = /(?:RFC-)?(\d+)/i.exec(String(s))
  if (!m) die(`not an RFC id: ${s}`)
  return Number(m[1])
}

function cmdStatus(args) {
  const [id, to] = args
  if (!id || !to) die(`usage: rfc status <RFC-N> <${STAGES.join("|")}>`)
  if (!STAGES.includes(to)) die(`unknown stage "${to}". Valid: ${STAGES.join(", ")}`)
  const n = parseId(id)
  const repo = repoSlug()
  if (!repo) die("cannot determine the RFC repo. Set RFC_REPO=owner/name.")
  requireAuth()

  const issue = gh([
    "issue", "view", String(n), "--repo", repo, "--json", "labels,title",
  ])
  const from = readStage(issue.labels.map((l) => l.name)).stage
  if (!canTransition(from, to)) {
    die(`illegal transition ${from ?? "draft"} → ${to}`)
  }

  // remove exactly the old stage label(s), add the new one
  const stale = issue.labels
    .map((l) => l.name)
    .filter((name) => name.startsWith(STAGE_PREFIX) && name !== STAGE_PREFIX + to)
  for (const label of stale) {
    gh(["issue", "edit", String(n), "--repo", repo, "--remove-label", label], { json: false })
  }
  gh(["issue", "edit", String(n), "--repo", repo, "--add-label", `${STAGE_PREFIX}${to}`], { json: false })
  console.log(`${rfcId(n)}: ${from ?? "draft"} → ${to}`)
}

function cmdSync() {
  const repo = repoSlug()
  if (!repo) die("cannot determine the RFC repo. Set RFC_REPO=owner/name.")
  requireAuth()
  const issues = gh([
    "issue", "list", "--repo", repo, "--state", "all", "--limit", "500",
    "--json", "number,title,labels,state,url,createdAt",
  ])
  const rfc = issues
    .map((i) => {
      const { stage } = readStage(i.labels.map((l) => l.name))
      return {
        id: rfcId(i.number),
        number: i.number,
        title: i.title,
        stage: stage ?? null,
        state: i.state,
        url: i.url,
        createdAt: i.createdAt,
      }
    })
    .sort((a, b) => a.number - b.number)

  const out = join(REPO_ROOT, "rfc", "index.json")
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ repo, syncedAt: new Date().toISOString(), rfc }, null, 2) + "\n")
  console.log(`${out}\n${rfc.length} RFC(s)`)
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2)
const COMMANDS = {
  new: cmdNew,
  check: cmdCheck,
  submit: cmdSubmit,
  list: cmdList,
  show: cmdShow,
  status: cmdStatus,
  sync: cmdSync,
}

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`rfc — file an RFC without touching the code repository

usage: rfc <command> [args]

  new [slug]            scaffold a local draft
  check <file>          validate (the same code CI runs)
  submit <file>         create the issue; --dry-run prints it instead
  list [--stage S]      list RFCs
  show <RFC-N>          print one RFC
  status <RFC-N> S      move its stage
  sync                  refresh rfc/index.json

  RFC_REPO=owner/name   override the target repo (default: this repo's origin)
`)
  process.exit(0)
}

if (!COMMANDS[cmd]) die(`unknown command "${cmd}" (try: rfc help)`)
COMMANDS[cmd](args)
