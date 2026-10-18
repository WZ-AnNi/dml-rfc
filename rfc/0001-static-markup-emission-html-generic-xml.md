<!-- GENERATED FILE — do not edit.
     Source of truth: https://github.com/WZ-AnNi/dml-rfc/issues/1
     Regenerate with .github/workflows/materialize.yml -->

# RFC-1 — Static markup emission (HTML / generic XML)

- **Id:** RFC-1 (issue #1; the number is the id and is never reused)
- **Stage:** stage:review
- **State:** open
- **Issue:** https://github.com/WZ-AnNi/dml-rfc/issues/1
- **Updated:** 2026-10-18T01:08:54Z

---

### Summary

Compile a DML template into static HTML and generic XML markup, so a consumer
that speaks XML can be fed from DML. The template reading of a document already
builds a tree; an emitter turns that tree back into a file, with no runtime
involved.

### Motivation

Today a template can only be rendered through the live runtime. A consumer that
wants a *file* — a static site, an SVG asset, a platform resource — has no path
from DML at all, which means any XML-consuming toolchain forces the author to
leave the language.

The data already exists: the optimizing backend hoists the static structure into a
literal `shape` array (`_$template(["div",{"class":"x"},[…]])`). That array is
discarded after serialization today. Emitting markup from it needs no new parser,
no new runtime, and no new syntax.

### Shape rationale

**This adds no syntax at all.** It is a subcommand of the existing CLI —
`dml emit --to html` — so it introduces zero reserved words into the language.

That is the point, not a side effect: an emission target is a *tool*, and a tool
that claimed a reserved name would be exactly the convention-as-syntax mistake
this project's RFC template warns about. Nothing here needs a marker in the
document.

### Proposal

Walk the hoisted shape array and serialize it.

**Static output only, in v1.** A template containing any dynamic construct
(`{ expr }`, `@if`, `@for`, a component call, a slot) is **rejected with an
explicit error**, not silently snapped. Snapshotting would require an evaluation
environment and would turn a serializer into a small interpreter — a much larger,
much less predictable surface. Rejection is honest and can be relaxed later with
evidence.

**Prop → attribute policy**, stated explicitly because several runtime props have
no static form:

| DML prop | markup |
| --- | --- |
| `class`, `id`, `title`, `data-*`, `aria-*` | attribute, passed through |
| `on*` (e.g. `onClick`) | **discarded**, reported as a warning — no static form exists |
| `ref` | discarded; meaningless without a live document |
| `$ServerOnly` | emitted normally; it is a server-emission marker |
| `classList` (object) | **rejected** in v1: needs evaluation |
| `style` (object) | **rejected** in v1: needs evaluation |
| `style` (string) | attribute, passed through |

**Dialect differences** are a flag, not a separate backend:

| | HTML | generic XML |
| --- | --- | --- |
| void elements (`img`, `br`, `input`) | no closing tag | self-closing `<img/>` |
| boolean attributes (`disabled`) | `disabled` | `disabled="disabled"` |
| raw-text elements (`script`, `style`) | contents not escaped | escaped |
| non-ASCII | as-is | as-is (UTF-8) |

**Escaping** must be exact: `&` and `<` in text, `"` in attribute values. This is
the one place a bug becomes a security bug, so it is table-driven and tested
per character rather than by regex.

### Alternatives considered

**A second runtime host implementing `RendererOptions`.** Rejected: serialization
has no reactivity, so the whole insert/patch machinery would be dead weight
carried for one static pass. `runtime-test` proves the host abstraction works, but
"it is possible" is not a reason to route a pure function through it.

**Emitting from the typed IR (`__dml_e` calls) instead of the shape array.**
Rejected: that IR exists for the type-checker and its byproduct is an expression
tree, not data. The shape array is already flat, ordered and literal.

**Snapshotting dynamic bindings with a provided scope.** Deferred, not rejected —
see Unresolved questions.

### Drawbacks

- The prop policy table must be maintained as runtime props are added; a new prop
  with no static form will silently fall into whatever the default case does.
  Mitigation: the default must be *reject and warn*, never *drop silently*.
- A rejection error for a dynamic template is a worse experience than emitting
  something. The message must say **why** (a static file cannot be reactive), or
  users will read it as a limitation rather than a boundary.
- Two dialects share one code path, so a dialect bug can appear in only one of
  them. The per-dialect table above exists to make that testable.

### Unresolved questions

1. Should a later version snapshot `@if` / `@for` against a caller-provided
   scope, or is rejection the permanent contract?
2. Where does `emit` live — `dml-cli` (already has `convert` / `compile` / `parse`)
   or a new package? The CLI is the obvious home; confirm it does not bloat the
   `dml` umbrella.
3. For SVG output, is the input `.tsdml` template content or a `.dml` document?
   Only the template reading produces a tree suitable for markup; the config
   reading produces an object. This must be nailed down before implementation, or
   the feature will be asked to do something nonsensical for config files.
