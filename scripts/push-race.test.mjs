/**
 * push-race.test.mjs — the export's push-retry logic, proven against a real race.
 *
 * The workflow's "commit if changed" step is the only place this system writes
 * to git, and it runs concurrently by nature: one issue event can spawn several
 * materialize runs, and a local `git push` races them. A plain `git push` fails
 * whenever anything reached main first.
 *
 * This is a test rather than a comment because the obvious fix is wrong and the
 * obvious fix's direction is also wrong:
 *
 *   - `git rebase origin/main` STOPS on the conflict. The export changes the
 *     same file (index.json) every time, so both sides always conflict. That
 *     leaves the run stuck — a worse outcome than the original failure.
 *   - `git merge -X theirs` merges the STALE export over the fresh one, because
 *     in a merge "ours" is the current branch, not the incoming one. The
 *     direction is counter-intuitive and was measured, not assumed.
 *
 * Two real clones of a bare repo, driven through the actual command sequence.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Run git; never throws, so a rejected push is a return value. */
function git(cwd, args) {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd, encoding: "utf8" }).trim(), err: "" }
  } catch (e) {
    return {
      ok: false,
      out: String(e.stdout ?? "").trim(),
      err: String(e.stderr ?? e.message).trim(),
    }
  }
}

/**
 * Build the race: two clones from one origin, A pushes, then B pushes the same
 * file. `strategy` selects the retry behaviour under test.
 */
function race(strategy) {
  const origin = mkdtempSync(join(tmpdir(), "rfc-origin-"))
  const runA = mkdtempSync(join(tmpdir(), "rfc-a-"))
  const runB = mkdtempSync(join(tmpdir(), "rfc-b-"))
  const cleanup = () => {
    for (const d of [origin, runA, runB]) rmSync(d, { recursive: true, force: true })
  }

  git(origin, ["init", "--bare", "-q", "--initial-branch=main"])

  git(runA, ["init", "-q", "--initial-branch=main"])
  git(runA, ["config", "user.email", "bot@b"])
  git(runA, ["config", "user.name", "bot"])
  git(runA, ["commit", "-q", "--allow-empty", "-m", "init"])
  git(runA, ["remote", "add", "origin", origin])
  git(runA, ["push", "-q", "origin", "main"])

  git(runB, ["clone", "-q", origin, "."])
  git(runB, ["config", "user.email", "bot@b"])
  git(runB, ["config", "user.name", "bot"])

  // A exports and pushes first
  mkdirSync(join(runA, "rfc"), { recursive: true })
  writeFileSync(join(runA, "rfc", "index.json"), '{"count":1}\n')
  git(runA, ["add", "rfc"])
  git(runA, ["commit", "-q", "-m", "export A"])
  const pushA = git(runA, ["push", "-q", "origin", "main"])
  assert.ok(pushA.ok, `setup: A's push should succeed: ${pushA.err}`)

  // B exports the SAME file, but B's clone is now behind
  mkdirSync(join(runB, "rfc"), { recursive: true })
  writeFileSync(join(runB, "rfc", "index.json"), '{"count":2}\n')
  git(runB, ["add", "rfc"])
  git(runB, ["commit", "-q", "-m", "export B"])

  // The retry loop, mirroring the workflow step
  let pushed = false
  let attempts = 0
  let stuck = false
  for (let attempt = 1; attempt <= 3; attempt++) {
    attempts = attempt
    if (git(runB, ["push", "-q", "origin", "main"]).ok) {
      pushed = true
      break
    }
    git(runB, ["fetch", "-q", "origin", "main"])
    if (strategy === "rebase") {
      const r = git(runB, ["rebase", "origin/main"])
      if (!r.ok) {
        stuck = true
        break
      }
    } else if (strategy === "merge-theirs") {
      const m = git(runB, ["merge", "-X", "theirs", "--no-edit", "origin/main"])
      if (!m.ok) {
        stuck = true
        break
      }
    } else {
      const m = git(runB, ["merge", "-X", "ours", "--no-edit", "origin/main"])
      if (!m.ok) {
        stuck = true
        break
      }
    }
  }

  const finalIndex = git(origin, ["show", "main:rfc/index.json"]).out
  const log = git(origin, ["log", "--oneline", "main"]).out.split("\n")
  return { pushed, attempts, stuck, finalIndex, log, cleanup }
}

test("a plain push loses the race — the reason the retry exists", () => {
  const origin = mkdtempSync(join(tmpdir(), "rfc-origin-"))
  const a = mkdtempSync(join(tmpdir(), "rfc-a-"))
  const b = mkdtempSync(join(tmpdir(), "rfc-b-"))
  try {
    git(origin, ["init", "--bare", "-q", "--initial-branch=main"])
    git(a, ["init", "-q", "--initial-branch=main"])
    git(a, ["config", "user.email", "t@t"])
    git(a, ["config", "user.name", "t"])
    git(a, ["commit", "-q", "--allow-empty", "-m", "init"])
    git(a, ["remote", "add", "origin", origin])
    git(a, ["push", "-q", "origin", "main"])
    git(b, ["clone", "-q", origin, "."])
    git(b, ["config", "user.email", "t@t"])
    git(b, ["config", "user.name", "t"])

    for (const [d, n] of [[a, 1], [b, 2]]) {
      mkdirSync(join(d, "rfc"), { recursive: true })
      writeFileSync(join(d, "rfc", "index.json"), `{"count":${n}}\n`)
      git(d, ["add", "rfc"])
      git(d, ["commit", "-q", "-m", `export ${n}`])
    }
    assert.ok(git(a, ["push", "-q", "origin", "main"]).ok)
    const second = git(b, ["push", "-q", "origin", "main"])
    assert.equal(second.ok, false, "the second push must be rejected")
    assert.match(second.err, /rejected|fetch first/, second.err)
  } finally {
    for (const d of [origin, a, b]) rmSync(d, { recursive: true, force: true })
  }
})

test("rebase is the WRONG fix: it stops on the same-file conflict", () => {
  const r = race("rebase")
  try {
    assert.equal(r.stuck, true, "rebase must be shown to get stuck")
    assert.equal(r.pushed, false, "rebase does not get the export pushed")
  } finally {
    r.cleanup()
  }
})

test("merge -X theirs is the WRONG direction: it keeps the stale export", () => {
  const r = race("merge-theirs")
  try {
    assert.equal(r.pushed, true, "the merge itself succeeds")
    // the direction that looks right keeps the OLD value
    assert.ok(
      r.finalIndex.includes('"count":1'),
      `expected the stale export to win with -X theirs, got ${r.finalIndex}`,
    )
  } finally {
    r.cleanup()
  }
})

test("merge -X ours is correct: the freshest export wins and both are kept", () => {
  const r = race("merge-ours")
  try {
    assert.equal(r.pushed, true, "the retry must eventually push")
    assert.ok(r.attempts >= 2, "the first attempt must fail, the second succeed")
    assert.ok(r.attempts <= 3, "within the workflow's retry budget")
    assert.equal(r.stuck, false, "the merge must not stop on a conflict")
    assert.ok(
      r.finalIndex.includes('"count":2'),
      `the newest export must win, got ${r.finalIndex}`,
    )
    assert.ok(
      r.log.some((l) => l.includes("Merge")),
      "history should record a merge, not silently drop a commit",
    )
  } finally {
    r.cleanup()
  }
})
