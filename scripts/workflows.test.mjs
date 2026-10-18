/**
 * workflows.test.mjs — checks on the CI plumbing itself.
 *
 * Workflows are the one part of this repo that only runs on GitHub, so a mistake
 * there is invisible locally and shows up as a failed run (or, worse, a security
 * hole). These are static checks: they read the YAML as text and assert the
 * properties that matter, with no YAML parser and no network.
 *
 * The most important assertion here is the injection check: an untrusted issue
 * body must never reach a `run:` block through `${{ }}` — GitHub substitutes
 * that text into the script before the shell sees it, which turns an RFC about
 * shell quoting into remote code execution on the runner.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const WF_DIR = join(ROOT, ".github", "workflows")

/** Read every workflow, keyed by filename. */
function workflows() {
  const out = {}
  for (const f of readdirSync(WF_DIR)) {
    if (f.endsWith(".yml") || f.endsWith(".yaml")) out[f] = readFileSync(join(WF_DIR, f), "utf8")
  }
  return out
}

test("the workflows exist", () => {
  assert.ok(existsSync(join(WF_DIR, "validate.yml")))
  assert.ok(existsSync(join(WF_DIR, "materialize.yml")))
})

test("every workflow declares an explicit permissions block", () => {
  // an omitted block inherits the repository default, which may be write-all
  for (const [name, yml] of Object.entries(workflows())) {
    assert.match(yml, /^permissions:/m, `${name} has no permissions: block`)
  }
})

test("no workflow grants more than it needs", () => {
  const wf = workflows()
  // validate only comments and labels
  assert.match(wf["validate.yml"], /issues: write/)
  assert.match(wf["validate.yml"], /contents: read/)
  assert.ok(!/contents: write/.test(wf["validate.yml"]), "validate must not write contents")
  // materialize commits, so it may write contents
  assert.match(wf["materialize.yml"], /contents: write/)
})

test("untrusted event data never reaches a run: block (injection guard)", () => {
  for (const [name, yml] of Object.entries(workflows())) {
    // Find every `run:` block (literal or folded) and inspect its lines.
    const lines = yml.split("\n")
    let inRun = false
    let runIndent = 0
    for (const line of lines) {
      const m = /^(\s*)(?:-\s+)?run:\s*(\||>)?\s*(.*)$/.exec(line)
      if (m) {
        inRun = true
        runIndent = m[1].length
        // a single-line `run:` is itself a script
        if (m[3] && /\$\{\{/.test(m[3])) {
          assert.ok(
            !/github\.event\.|inputs\./.test(m[3]),
            `${name}: untrusted value interpolated directly in a run: line → ${m[3].trim()}`,
          )
        }
        continue
      }
      if (!inRun) continue
      // a run block ends when a line has smaller indentation and is not blank
      if (line.trim() && line.search(/\S/) <= runIndent) {
        inRun = false
        continue
      }
      if (/\$\{\{/.test(line)) {
        assert.ok(
          !/github\.event\.|inputs\./.test(line),
          `${name}: untrusted value interpolated into a run: block → ${line.trim()}`,
        )
      }
    }
  }
})

test("the validation workflow consumes the event payload as data, not via a shell", () => {
  const yml = workflows()["validate.yml"]
  // the payload path is passed through the environment / stdin, never expanded
  assert.match(yml, /GITHUB_EVENT_PATH/, "expected the payload to be read via GITHUB_EVENT_PATH")
  assert.ok(
    /<\s*"\$GITHUB_EVENT_PATH"/.test(yml),
    "expected the payload redirected into node on stdin",
  )
})

test("both workflows run the shared validator's self-test first", () => {
  for (const [name, yml] of Object.entries(workflows())) {
    // one collector knows every test file, so CI and `npm test` cannot diverge
    assert.match(
      yml,
      /run: node scripts\/run-tests\.mjs/,
      `${name} does not run the shared test collector`,
    )
  }
})

test("the test collector discovers the test files itself", () => {
  const yml = workflows()["validate.yml"]
  // no workflow may hard-code the file list: a new test file would silently
  // stop running in CI
  assert.ok(
    !/run: node --test scripts\//.test(yml),
    "validate.yml hard-codes the test file list",
  )
})

test("materialize guards its commit against an empty diff", () => {
  // otherwise every scheduled run would make an empty commit
  const yml = workflows()["materialize.yml"]
  assert.match(yml, /git diff --cached --quiet/)
})

test("concurrency is declared so runs cannot race on comments or commits", () => {
  for (const [name, yml] of Object.entries(workflows())) {
    assert.match(yml, /^concurrency:/m, `${name} has no concurrency group`)
  }
})

test("the bot commit is attributed and skips CI", () => {
  const yml = workflows()["materialize.yml"]
  assert.match(yml, /github-actions\[bot\]/, "commit should be attributed to the bot")
  assert.match(yml, /\[skip ci\]/, "generated commits should not re-trigger CI")
})
