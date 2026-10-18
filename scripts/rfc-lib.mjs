/**
 * rfc-lib — the ONE source of truth for what an RFC is.
 *
 * Both the validation Action and the submit CLI import this module. If the two
 * ever validated differently, a CLI-submitted RFC would pass locally and fail
 * in CI (or worse, the reverse) — the same class of drift that made a stale
 * binary look like a live bug in the main repo. So the shared contract lives
 * here, and every entry point calls it.
 *
 * Design notes:
 *   - **The issue number IS the RFC id** (`RFC-42`). GitHub allocates it
 *     atomically on creation, never reuses it, and assigns it without any pull
 *     request — which is exactly why "submit without committing code" and
 *     "every id differs" can both hold. Nothing here invents a second counter;
 *     a second counter would race.
 *   - **Validation parses the issue BODY**, not form fields. Issue Forms render
 *     their fields into the body as `### <label>` sections, so a CLI-submitted
 *     issue (which builds the body directly) validates through the identical
 *     path. One parser, both submission routes.
 *   - **Stage lives in labels** — the labels ARE the database column. No side
 *     table to fall out of sync with issue state.
 *
 * Dependency-free (pure Node), so it runs unchanged in a runner and on a laptop.
 */

// ---------------------------------------------------------------------------
// schema: the RFC's required shape
// ---------------------------------------------------------------------------

/**
 * One canonical field. `label` is the heading Issue Forms emit and the CLI
 * writes, so it is the parse key for both.
 */
export const RFC_FIELDS = [
  {
    key: "summary",
    label: "Summary",
    required: true,
    min: 20,
    hint: "One paragraph: what changes, for whom.",
  },
  {
    key: "motivation",
    label: "Motivation",
    required: true,
    min: 20,
    hint: "The problem, and what breaks today without this.",
  },
  {
    key: "shapeRationale",
    label: "Shape rationale",
    required: true,
    min: 20,
    hint:
      "For a syntax or API addition: what SHAPE it has, and why that shape " +
      "is recognisable without a name lookup. A construct whose only marker " +
      "is a reserved word is a convention, not syntax — say which this is.",
  },
  {
    key: "proposal",
    label: "Proposal",
    required: true,
    min: 20,
    hint: "The design itself: syntax, behaviour, errors, edge cases.",
  },
  {
    key: "alternatives",
    label: "Alternatives considered",
    required: false,
    hint: "What else was tried or rejected, and why.",
  },
  {
    key: "drawbacks",
    label: "Drawbacks",
    required: false,
    hint: "Real costs: complexity, migration, maintenance.",
  },
  {
    key: "unresolved",
    label: "Unresolved questions",
    required: false,
    hint: "Open decisions the RFC does not settle.",
  },
]

/** Heading label → field, for body parsing. */
const FIELD_BY_LABEL = new Map(
  RFC_FIELDS.map((f) => [normaliseHeading(f.label), f]),
)

/** What GitHub puts in an untouched Issue Form field. */
const NO_RESPONSE = "_No response_"

// ---------------------------------------------------------------------------
// stage: the state machine (labels are the storage)
// ---------------------------------------------------------------------------

/** The single stage label prefix. */
export const STAGE_PREFIX = "stage:"

/** Every legal stage, in rough lifecycle order. */
export const STAGES = [
  "draft",
  "review",
  "accepted",
  "rejected",
  "withdrawn",
  "superseded",
]

/**
 * Legal transitions. `draft → accepted` is deliberately absent: a proposal has
 * to be reviewed first, and letting it jump would make `stage:review`
 * meaningless.
 */
export const TRANSITIONS = {
  draft: ["review", "withdrawn"],
  review: ["accepted", "rejected", "withdrawn", "draft"],
  accepted: ["superseded", "withdrawn"],
  rejected: [],
  withdrawn: [],
  superseded: [],
}

/** The stage a label set currently declares, plus any conflict. */
export function readStage(labels = []) {
  const found = labels
    .filter((l) => typeof l === "string" && l.startsWith(STAGE_PREFIX))
    .map((l) => l.slice(STAGE_PREFIX.length))
  const unknown = found.filter((s) => !STAGES.includes(s))
  const known = found.filter((s) => STAGES.includes(s))
  return {
    stage: known.length === 1 ? known[0] : null,
    conflict: known.length > 1 ? known : null,
    unknown,
  }
}

/** May `from` move to `to`? A missing/absent stage counts as `draft`. */
export function canTransition(from, to) {
  const f = from ?? "draft"
  if (f === to) return true
  return (TRANSITIONS[f] ?? []).includes(to)
}

// ---------------------------------------------------------------------------
// body parsing
// ---------------------------------------------------------------------------

/** Headings match regardless of case, surrounding space or trailing `:`. */
function normaliseHeading(s) {
  return s.trim().toLowerCase().replace(/:\s*$/, "")
}

/** Strip HTML comments — Issue Forms leave instructions inside them. */
function stripComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, "")
}

/**
 * Split a markdown body into `{ heading → content }` on `###` headings.
 *
 * Two robustness rules, both learned the hard way:
 *
 *   - **First occurrence wins.** Issue Forms emit each section once, so a later
 *     duplicate can only come from content that itself contains `### …`. Taking
 *     the first keeps the canonical field intact instead of letting a stray line
 *     inside another section overwrite it.
 *   - **Fenced code blocks are not section boundaries.** A `### ` line inside
 *     ``` is sample text (an RFC about markup will contain exactly that), so
 *     fences are tracked and their contents passed through verbatim.
 */
export function splitSections(body) {
  const text = stripComments(body ?? "").replace(/\r\n/g, "\n")
  const out = new Map()
  const lines = text.split("\n")
  let current = null
  let buf = []
  let fence = null
  const flush = () => {
    if (current !== null && !out.has(current)) out.set(current, buf.join("\n").trim())
    buf = []
  }
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      if (current !== null) buf.push(line)
      continue
    }
    if (fence === null) {
      const m = /^###\s+(.+?)\s*$/.exec(line)
      if (m) {
        flush()
        current = normaliseHeading(m[1])
        continue
      }
    }
    if (current !== null) buf.push(line)
  }
  flush()
  return out
}

/** Is this section effectively empty? */
function isEmptySection(content) {
  if (content == null) return true
  const t = content.trim()
  return t === "" || t === NO_RESPONSE
}

/** Extract every canonical field from an issue body. */
export function parseIssueBody(body) {
  const sections = splitSections(body)
  const fields = {}
  for (const f of RFC_FIELDS) {
    const raw = sections.get(normaliseHeading(f.label))
    fields[f.key] = isEmptySection(raw) ? "" : raw
  }
  return fields
}

// ---------------------------------------------------------------------------
// secrets: an RFC is public the moment it is posted
// ---------------------------------------------------------------------------

/**
 * High-confidence credential shapes. An RFC body is world-readable, so a pasted
 * key is a disclosure — but an RFC *about* auth may quote a fake key, so these
 * are reported, not silently fatal (see `severity`).
 */
const SECRET_PATTERNS = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a private key block", severity: "error" },
  { re: /\bghp_[A-Za-z0-9]{36}\b/, what: "a GitHub personal access token", severity: "error" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, what: "a GitHub fine-grained token", severity: "error" },
  { re: /\b(?:gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/, what: "a GitHub token", severity: "error" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, what: "an Anthropic API key", severity: "error" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: "an AWS access key id", severity: "error" },
  { re: /\bsk-[A-Za-z0-9]{32,}\b/, what: "an API key", severity: "warn" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, what: "a Slack token", severity: "warn" },
]

/** Scan text for credential-shaped strings. */
export function scanSecrets(text) {
  const hits = []
  for (const { re, what, severity } of SECRET_PATTERNS) {
    const m = re.exec(text ?? "")
    if (m) hits.push({ what, severity, sample: redact(m[0]) })
  }
  return hits
}

/** Show enough to locate it, never enough to use it. */
function redact(s) {
  if (s.length <= 8) return "*".repeat(s.length)
  return `${s.slice(0, 4)}…${"*".repeat(Math.max(4, s.length - 8))}…${s.slice(-4)}`
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/** Titles must describe the RFC, not be a placeholder. */
const TITLE_MIN = 10
const TITLE_PLACEHOLDER = /^(rfc|untitled|todo|tbd|wip|draft)\b/i

/**
 * Validate one RFC submission.
 *
 * @param {{ title?: string, body?: string, labels?: string[] }} input
 * @returns {{ ok: boolean, errors: string[], warnings: string[],
 *             fields: Record<string,string>, stage: string|null }}
 */
export function validateRfc({ title = "", body = "", labels = [] } = {}) {
  const errors = []
  const warnings = []
  const fields = parseIssueBody(body)

  // --- title ---
  const t = title.trim()
  if (t.length < TITLE_MIN) {
    errors.push(`Title is too short (${t.length} chars, need ${TITLE_MIN}). Describe the change, e.g. "Static markup emission".`)
  }
  if (TITLE_PLACEHOLDER.test(t)) {
    errors.push(`Title "${t}" is a placeholder — name the actual proposal.`)
  }

  // --- required sections ---
  for (const f of RFC_FIELDS) {
    const v = fields[f.key] ?? ""
    if (f.required && v.length === 0) {
      errors.push(`Missing required section "### ${f.label}".`)
      continue
    }
    if (v.length > 0 && f.min && v.length < f.min) {
      const level = f.required ? errors : warnings
      level.push(`Section "### ${f.label}" is thin (${v.length} chars, aim for ${f.min}+).`)
    }
  }

  // --- stage ---
  const stageInfo = readStage(labels)
  if (stageInfo.conflict) {
    errors.push(
      `Conflicting stage labels: ${stageInfo.conflict.map((s) => STAGE_PREFIX + s).join(", ")}. Exactly one stage may apply.`,
    )
  }
  if (stageInfo.unknown.length) {
    errors.push(`Unknown stage label(s): ${stageInfo.unknown.map((s) => STAGE_PREFIX + s).join(", ")}.`)
  }

  // --- secrets ---
  for (const hit of scanSecrets(`${title}\n${body}`)) {
    const line = `Body looks like it contains ${hit.what} (${hit.sample}). Issues are public.`
    if (hit.severity === "error") errors.push(line)
    else warnings.push(line)
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    fields,
    stage: stageInfo.stage,
  }
}

// ---------------------------------------------------------------------------
// rendering & ids
// ---------------------------------------------------------------------------

/** Title → a stable, readable filename component. */
export function slugify(title, max = 60) {
  const s = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "")
  return s || "rfc"
}

/** Issue number → the canonical id (`42` → `RFC-42`). */
export function rfcId(issueNumber) {
  const n = Number(issueNumber)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`rfcId: expected a positive issue number, got ${issueNumber}`)
  }
  return `RFC-${n}`
}

/** Issue number → the materialized filename (`42` → `0042-slug`). */
export function rfcFilename(issueNumber, title) {
  return `${String(issueNumber).padStart(4, "0")}-${slugify(title)}.md`
}

/** The canonical body the CLI writes and the Action expects. */
export function renderRfcBody(fields = {}) {
  return RFC_FIELDS.map((f) => {
    const v = (fields[f.key] ?? "").trim() || (f.required ? "" : NO_RESPONSE)
    return `### ${f.label}\n\n${v}`
  }).join("\n\n")
}

/**
 * The scaffold `rfc new` writes: a title placeholder plus every section.
 *
 * Derived from RFC_FIELDS rather than spelled out, so the tool can never emit a
 * draft its own `check` would reject for a missing section.
 */
export function renderScaffold() {
  const body = RFC_FIELDS.map((f) => {
    const tag = f.required ? "" : " (optional)"
    return `### ${f.label}${tag}\n\n<!-- ${f.hint} -->\n`
  }).join("\n")
  return `# <title>\n\n${body}`
}

/** A title that keeps the RFC list readable. */
export function normaliseTitle(title) {
  return title.trim().replace(/\s+/g, " ")
}
