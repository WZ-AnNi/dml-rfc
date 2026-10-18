# dml-rfc

Proposals for **DML / TSDML**. An RFC is a GitHub issue in this repository — not
a pull request, not a file in the main repo.

The point: **filing a proposal must not require touching code.** No clone, no
branch, no PR review pipeline. An author without write access to the main repo
can still file an RFC, because this repository has no code to protect.

---

## Why the id is a GitHub issue number

RFC ids are `<issue number>` — `RFC-42`.

That choice is the whole design, so it is worth stating plainly:

- GitHub **allocates the number atomically** when the issue is created. Two
  people filing in the same second get two different ids, with no lock and no
  coordination.
- Numbers are **never reused**, not even after deletion, so an id stays a stable
  reference forever.
- There is **no second counter anywhere in this repo**. A second counter would
  race, and a race is what makes "every id differs" false.

Sequential file numbering (`0001-…`) cannot satisfy the first requirement: the
number would only be assigned at merge time, which is exactly the thing we are
trying to avoid.

**Corollary:** this repository must contain no code that could be a pull request.
GitHub issues and PRs share one numbering space. If a PR appeared here, the ids
would still be unique but no longer all RFCs — and the "id = issue number"
identity would become confusing. Only tooling and generated exports live here;
the tooling is committed directly, not proposed through a PR.

---

## Filing an RFC

### From the browser (no install)

[Open a new issue](https://github.com/WZ-AnNi/dml-rfc/issues/new/choose) and pick
the **RFC** form. Required sections are marked; the form will not submit without
them.

### From the command line

```bash
rfc new static-markup          # scaffold ./drafts/static-markup.md
$EDITOR drafts/static-markup.md
rfc check drafts/static-markup.md    # validate locally (same code CI runs)
rfc submit drafts/static-markup.md   # creates the issue
```

`rfc submit --dry-run` prints exactly what would be posted without contacting
GitHub — useful for reviewing a long proposal.

Both routes go through **the same validator** (`scripts/rfc-lib.mjs`), so a draft
that passes `rfc check` cannot fail in CI for a format reason.

### Authentication

The CLI delegates entirely to `gh auth login` (or a `GITHUB_TOKEN` you export
yourself). It **never** accepts a token argument, never prints one, and never
writes one to disk.

---

## Required sections

| Section | Required | Why |
| --- | --- | --- |
| Summary | yes | One paragraph a reader can act on |
| Motivation | yes | The problem; what breaks today |
| **Shape rationale** | **yes** | *How is this construct recognised?* |
| Proposal | yes | The design: syntax, behaviour, errors |
| Alternatives considered | no | What else was tried |
| Drawbacks | no | Real costs |
| Unresolved questions | no | What this does not settle |

The table above is a summary. **`RFC_FIELDS` in `scripts/rfc-lib.mjs` is the
single source of truth** — the browser form, the CLI scaffold and the validator
all derive from it, and `scripts/conformance.test.mjs` fails if any of the three
drifts out of step.

### Why "Shape rationale" is mandatory

A construct earns syntax only when its **shape** is recognisable on its own — you
can tell what it is without consulting a list of reserved words.

| | Recognisable by shape | Marker is only a name |
| --- | --- | --- |
| Syntax | `@if (cond) { … }`, `@slot("x") { … }` | — |
| Convention | — | `@key:`, `@__schema__` |

A convention is not automatically wrong. It is wrong when it is *presented as
syntax*: the name gets skipped by a lookup table, users lose the ability to use
that key, and every tool (highlight, complete, go-to-definition) hardcodes its own
copy of the list — which then drifts.

So the form asks which one you are proposing. "This adds no syntax" is a perfectly
good answer, and often the better proposal.

---

## Stages

Stages are **labels** — the labels are the database column, so no side table can
fall out of sync with issue state.

```
stage:draft → stage:review → stage:accepted
                           → stage:rejected
                accepted   → stage:superseded
      (any)                → stage:withdrawn
```

`draft → accepted` is deliberately **not** allowed: a proposal has to be reviewed
first, or `stage:review` would mean nothing.

```bash
rfc status RFC-42 review
```

Terminal stages (`rejected`, `withdrawn`, `superseded`) stay terminal. A rejected
RFC is not deleted — the record of *what was considered and declined* is worth
keeping.

---

## What lives here

```
.github/
  ISSUE_TEMPLATE/rfc.yml      the browser submission form
  workflows/validate.yml      validates issues, comments, sets stage:draft
  workflows/materialize.yml   exports issues -> rfc/, commits them
scripts/
  rfc-lib.mjs                 THE contract: fields, stage machine, validation
  rfc.mjs                     the CLI
  run-tests.mjs               discovers and runs every *.test.mjs
  action-validate.mjs         validation workflow entry point
  action-materialize.mjs      export workflow entry point
  *.test.mjs                  81 tests, no dependencies, no network
rfc/                          GENERATED export — never edit by hand
seeds/                        RFCs written before the repo existed, awaiting filing
drafts/                       local drafts, not committed
```

`rfc/` is generated: issue → `rfc/0042-static-markup-emission.md` plus
`rfc/index.json`. Every generated file says so at the top, because someone will
eventually try to edit one.

The **issue remains the source of truth**. The files exist so the RFC set can be
read offline and reviewed as an ordinary diff.

---

## Running the tests

```bash
npm test        # 81 tests, pure Node, no install step
```

There are no dependencies. The suite covers:

- `rfc-lib.test.mjs` — ids, body parsing, validation, stage machine, secret
  detection, and the fence/heading edge cases.
- `conformance.test.mjs` — the Issue Form, the CLI scaffold and the library must
  describe the *same* fields, or one submission route breaks.
- `workflows.test.mjs` — permissions are minimal, and untrusted event data never
  reaches a `run:` block (the `${{ }}` injection hole).
- `materialize.test.mjs` — the exporter against a stub API: pagination,
  PR exclusion, stale-file cleanup, and bodies written as *text*.
- `docs.test.mjs` — this file. The README's field table, stage list and file tree
  must match the code; a doc that contradicts `RFC_FIELDS` fails CI.
- `seeds.test.mjs` — the proposals in `seeds/` must pass the very contract they
  document, or the contract is wrong rather than the seed.
- `remote.test.mjs` — the target repo is read from the git remote **without**
  requiring the host to be `github.com` (SSH aliases are normal), and a local
  path is refused rather than guessed at.
- `push-race.test.mjs` — drives two real clones through a genuine push race and
  proves the retry must be `merge -X ours`: a rebase stops on the same-file
  conflict, and `-X theirs` keeps the stale export.

---

## Security

Two rules, both enforced by tests:

1. **An issue body is data.** It is parsed, stored and copied — never executed,
   never interpolated into a shell command. `workflows.test.mjs` asserts that no
   `${{ github.event.* }}` expression appears in any `run:` block.
2. **Nothing here handles credentials.** The CLI refuses token arguments; the
   workflows use the ephemeral `GITHUB_TOKEN` with the narrowest permissions that
   work (`validate.yml` cannot write contents at all).

A pasted credential is also caught at validation time — an issue is public the
moment it is posted, so a credential-shaped string in the body is reported (and
redacted in the report). It is a **hard error** for high-confidence shapes
(private keys, `ghp_…`, `AKIA…`) so the author is stopped before submitting.

---

## Repository setup (one-time, manual)

These steps need repository-admin rights and **cannot be automated from here**:

1. **Create the repository** with this name, and set its default branch to `main`.
2. **Enable Issues** (Settings → Features → Issues). Everything depends on it.
3. **Create the stage labels** — the Actions add them on demand, but pre-creating
   them keeps the UI legible:

   ```bash
   for s in draft review accepted rejected withdrawn superseded; do
     gh label create "stage:$s" --repo WZ-AnNi/dml-rfc --force
   done
   gh label create rfc --repo WZ-AnNi/dml-rfc --force
   ```

4. **Allow Actions to write** (Settings → Actions → General → Workflow
   permissions) so `materialize.yml` can commit its export.
5. **Protect `main`** against force-pushes, but *allow* the Actions bot to push —
   the export commits directly.

After that, the system is self-maintaining: a new issue is validated on creation,
and the export refreshes daily (03:17 UTC) or on any issue change.
