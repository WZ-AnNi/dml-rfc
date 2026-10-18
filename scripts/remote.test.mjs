/**
 * remote.test.mjs — remote-URL parsing.
 *
 * This exists because the first version of `repoSlug()` only accepted
 * `github.com`, so a repository whose SSH config aliases the host
 * (`git@github-wz:owner/name.git`) resolved to `null` — the CLI's default path
 * was broken on the very machine it was written for, while `RFC_REPO=<slug>`
 * masked it. The host is not the reliable part; the path is.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { repoFromRemoteUrl } from "./rfc.mjs"

test("scp-like SSH URLs, including an aliased host", () => {
  assert.equal(repoFromRemoteUrl("git@github.com:owner/name.git"), "owner/name")
  // the real-world case that broke: a host alias in ~/.ssh/config
  assert.equal(repoFromRemoteUrl("git@github-wz:WZ-AnNi/dml-rfc.git"), "WZ-AnNi/dml-rfc")
  // no .git suffix
  assert.equal(repoFromRemoteUrl("git@github.com:owner/name"), "owner/name")
})

test("URL-style remotes are host-agnostic too", () => {
  assert.equal(repoFromRemoteUrl("ssh://git@github.com/owner/name.git"), "owner/name")
  assert.equal(repoFromRemoteUrl("https://github.com/owner/name.git"), "owner/name")
  assert.equal(repoFromRemoteUrl("https://github.com/owner/name"), "owner/name")
  assert.equal(repoFromRemoteUrl("https://user@host/owner/name.git"), "owner/name")
  // GitHub Enterprise or any other host
  assert.equal(repoFromRemoteUrl("https://git.corp.example/team/proj.git"), "team/proj")
})

test("nested groups keep the last two path segments", () => {
  // some hosts nest: /group/subgroup/project
  assert.equal(repoFromRemoteUrl("https://example.com/a/b/c.git"), "b/c")
})

test("a local path or a bare host is not a remote slug", () => {
  assert.equal(repoFromRemoteUrl(""), null)
  assert.equal(repoFromRemoteUrl(null), null)
  assert.equal(repoFromRemoteUrl(undefined), null)
  assert.equal(repoFromRemoteUrl("/home/me/repo"), null)
  assert.equal(repoFromRemoteUrl("C:/Users/me/repo"), null)
  assert.equal(repoFromRemoteUrl("../sibling"), null)
  // a path with only one segment cannot be owner/name
  assert.equal(repoFromRemoteUrl("git@github.com:onlyname.git"), null)
  assert.equal(repoFromRemoteUrl("https://github.com/onlyname"), null)
})

test("whitespace from the git command is tolerated", () => {
  assert.equal(repoFromRemoteUrl("  git@github-wz:o/n.git\n"), "o/n")
})
