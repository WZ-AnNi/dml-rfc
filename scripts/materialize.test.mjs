/**
 * materialize.test.mjs — drive action-materialize.mjs against a mock API.
 *
 * The exporter is the one script whose real input (a GitHub API) does not exist
 * locally, so it is verified against a stub that speaks the same shape. This
 * catches the failure modes a workflow run would only reveal after the repo is
 * live: bad pagination, a missing header, a stale file left behind, and — the
 * one that matters most — treating an issue body as anything other than text.
 *
 * The stub is injected by replacing global fetch, so the exporter runs unmodified.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, "action-materialize.mjs")

/** A fake issue, shaped like the REST payload. */
function issue(n, title, body, labels = ["stage:draft", "rfc"], state = "open") {
  return {
    number: n,
    title,
    body,
    state,
    labels: labels.map((name) => ({ name })),
    html_url: `https://github.com/o/r/issues/${n}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  }
}

/**
 * Set up a temp "repo": copies the exporter + library into `<tmp>/scripts`, so
 * the exporter's own `../rfc` resolves inside the temp dir. Returns the dir and
 * a helper that runs the exporter with a stubbed fetch.
 */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "rfc-mat-"))
  const scripts = join(dir, "scripts")
  mkdirSync(scripts, { recursive: true })
  for (const f of ["action-materialize.mjs", "rfc-lib.mjs"]) {
    writeFileSync(join(scripts, f), readFileSync(join(HERE, f)))
  }

  /** Run the exporter with `issues` served by a stub API. */
  function run(issues, { pages = 1 } = {}) {
    const driver = join(dir, "driver.mjs")
    writeFileSync(
      driver,
      `
      const ISSUES = ${JSON.stringify(issues)};
      const PAGES = ${pages};
      globalThis.fetch = async (url) => {
        const u = new URL(String(url));
        const page = Number(u.searchParams.get("page") ?? "1");
        const per = Number(u.searchParams.get("per_page") ?? "100");
        const batch = page <= PAGES
          ? ISSUES.slice((page - 1) * per, page * per)
          : [];
        return { ok: true, status: 200, json: async () => batch };
      };
      process.env.GITHUB_TOKEN = "x";
      process.env.GITHUB_REPOSITORY = "o/r";
      await import(${JSON.stringify("./scripts/action-materialize.mjs")});
      `,
    )
    let stdout = ""
    let failed = false
    try {
      stdout = execFileSync("node", [driver], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      failed = true
      stdout = String(e.stdout ?? "") + String(e.stderr ?? "")
    }
    return { stdout, failed, dir }
  }

  const index = () => JSON.parse(readFileSync(join(dir, "rfc", "index.json"), "utf8"))
  const md = () => readdirSync(join(dir, "rfc")).filter((f) => f.endsWith(".md")).sort()
  const file = (name) => readFileSync(join(dir, "rfc", name), "utf8")

  return { dir, run, index, md, file }
}

test("exports one file per issue, numbered and slugged", () => {
  const s = makeSandbox()
  const { stdout, failed } = s.run([
    issue(42, "Static markup emission", "### Summary\n\nhello\n"),
    issue(7, "XAML backend", "### Summary\n\nworld\n"),
  ])
  assert.equal(failed, false, stdout)
  assert.deepEqual(s.md(), ["0007-xaml-backend.md", "0042-static-markup-emission.md"])
  assert.match(stdout, /wrote 2 RFC file/)
})

test("the generated file carries the id, stage and a do-not-edit header", () => {
  const s = makeSandbox()
  s.run([issue(42, "Static markup emission", "### Summary\n\nhello\n")])
  const text = s.file("0042-static-markup-emission.md")
  assert.match(text, /GENERATED FILE — do not edit/)
  assert.match(text, /# RFC-42 — Static markup emission/)
  assert.match(text, /stage:draft/)
  assert.match(text, /issues\/42/)
  assert.match(text, /### Summary/)
})

test("index.json is sorted by number and carries every field", () => {
  const s = makeSandbox()
  s.run([issue(42, "Second", "### Summary\n\nb\n"), issue(7, "First", "### Summary\n\na\n")])
  const idx = s.index()
  assert.equal(idx.count, 2)
  assert.deepEqual(idx.rfc.map((r) => r.id), ["RFC-7", "RFC-42"])
  assert.equal(idx.rfc[0].file, "0007-first.md")
  assert.equal(idx.rfc[0].stage, "draft")
  assert.ok(idx.generatedAt)
})

test("pull requests are excluded — they share the issue number space", () => {
  const s = makeSandbox()
  const withPr = [issue(1, "A real rfc", "### Summary\n\nx\n")]
  withPr.push({ ...issue(2, "A pull request", "no"), pull_request: { url: "x" } })
  s.run(withPr)
  const idx = s.index()
  assert.equal(idx.count, 1, "the PR must not be exported")
  assert.equal(idx.rfc[0].id, "RFC-1")
})

test("an issue body is written as text, including markup-looking content", () => {
  const s = makeSandbox()
  // an RFC about HTML quoting will contain exactly this; it must survive verbatim
  const body = '### Proposal\n\n```html\n<script>alert("x")</script>\n```\n### Summary\n\ny\n'
  s.run([issue(3, "Quoting", body)])
  const text = s.file("0003-quoting.md")
  assert.ok(text.includes('<script>alert("x")</script>'), "body must be copied, not escaped or run")
})

test("CRLF line endings in a body are normalised", () => {
  const s = makeSandbox()
  s.run([issue(4, "Crlf", "### Summary\r\n\r\nx\r\n")])
  assert.ok(!s.file("0004-crlf.md").includes("\r"), "CRLF should be normalised to LF")
})

test("a removed issue leaves no orphan file", () => {
  const s = makeSandbox()
  s.run([issue(1, "One", "### Summary\n\na\n")])
  assert.deepEqual(s.md(), ["0001-one.md"])
  // export a different issue into the SAME output dir
  s.run([issue(2, "Two", "### Summary\n\nb\n")])
  assert.deepEqual(s.md(), ["0002-two.md"], "stale export should be removed")
})

test("pagination is followed until a short page", () => {
  const s = makeSandbox()
  const many = Array.from({ length: 150 }, (_, i) => issue(i + 1, `Rfc ${i + 1}`, `### Summary\n\nx${i}\n`))
  const { stdout, failed } = s.run(many, { pages: 2 })
  assert.equal(failed, false, stdout)
  assert.match(stdout, /fetched 150 issue/)
  assert.equal(s.index().count, 150)
})

test("missing credentials fail loudly rather than writing a partial export", () => {
  let stderr = ""
  let failed = false
  try {
    execFileSync("node", [SCRIPT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GITHUB_TOKEN: "", GITHUB_REPOSITORY: "" },
    })
  } catch (e) {
    failed = true
    stderr = String(e.stderr ?? "")
  }
  assert.ok(failed, "expected a non-zero exit without credentials")
  assert.match(stderr, /GITHUB_TOKEN is not set/)
})

test("an issue with no stage is recorded as null, not silently as draft", () => {
  const s = makeSandbox()
  s.run([issue(5, "No stage yet", "### Summary\n\nx\n", [])])
  assert.equal(s.index().rfc[0].stage, null)
})
