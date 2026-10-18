# Document schema: declared types, project awareness, dynamic value sources

### Summary

Add an optional schema that describes what a DML document is *allowed to contain*,
and use it to drive structure validation and string-level completion. The schema
goes beyond JSON Schema in one specific way: a type may be **derived from a
sibling value and resolved against the outside world** (the filesystem, a
`package.json`, a registry), so the completion for `vite: "^` can offer real
published versions.

### Motivation

DML documents are currently untyped. `dml.config.dml` is a document like any
other, but nothing knows that `dependencies` maps package names to version
ranges, so a typo is caught only when the tool that consumes the config fails —
often much later.

JSON Schema can express structure, but it has two ceilings:

- **Types cannot depend on sibling values.** A key can be constrained, but a
  *value* cannot be typed by its own key.
- **Types cannot reference the outside world.** Every type is one of six JSON
  kinds.

The second is the one worth fixing, and it is also the one that is easy to get
wrong.

### Shape rationale

The schema is **declared in an external metadata file**, not in the user's
document. A user's `dml.config.dml` stays pure data:

```
dml.config.dml          the document — no metadata, no reserved names
dml.config.schema.dml   the schema — declares which documents it governs
```

Two reasons this is a shape decision, not a convenience:

1. **No reserved name enters the user document.** A `@__schema__:`-style marker is
   a convention: it parses as an ordinary attribute, is recognised only because a
   lookup table skips it, and starts silently eating the key for users. Its
   "small implementation cost" is exactly the symptom of not being syntax.
2. **A schema-sized concept belongs at schema scale.** Metadata that can govern
   several documents cannot live inside one of them.

If an explicit in-document pointer is needed later, the shape must be
recognisable without a name lookup — `@schema("path")`, reusing the existing
`@name(...)` construct — never a bare reserved attribute.

**Types are written as TypeScript expressions.** `string`, `Semver`,
`map<PackageName, string>`, `"monorepo" | "single"` are all valid TS, which the
value-position parser already accepts via oxc. So this RFC adds **no type syntax**:
the existing value grammar is the type grammar.

### Proposal

**Declaration.** A schema declares its targets (`@target: "**/dml.config.dml"`) or
is referenced explicitly. Inline schemas, if supported, use `@schema { … }`.

**Schema document shape** mirrors the document it describes, with values replaced
by types:

```dml
Schema {
  node project {
    name: string
    version: Semver
    type: "monorepo" | "single"
    registry { aliases: map<PackageName, string> }
  }
}
```

**Sibling binding.** A type may name a value from its context — `key`, `value`,
`parent`, `doc`, `root` — which is what makes the type *dependent*:

```dml
dependencies {
  @value: VersionRange(package)   // `package` is this entry's key
}
```

JSON Schema has no equivalent. This is the substance of "more complex than JSON
Schema".

**Layered validation, with the dynamic layer never blocking.** This is the part
that has to be right from the start, because it is the part that makes the
feature annoying if wrong:

| layer | content | when | on failure |
| --- | --- | --- | --- |
| syntax | brackets, quotes, expression legality | every keystroke (Rust, exists) | error |
| structure | unknown keys, missing required, type mismatch, enum | every keystroke, cached schema | error |
| static types | TS checks the type expression | TS service | error |
| **dynamic** | resolved from filesystem / network | async, debounced, cached | **mark pending, never error** |

Offline must show "not verified", never a red squiggle. A validator that turns
into a false-alarm generator whenever the network is down gets switched off, and
then it protects nothing.

**Resolution order, cheapest first.**

1. **Filesystem** — `include: ["packages/*"]` validated against real directories;
   `aliases` package names checked against real workspace packages.
2. **Project files** — `package.json`, workspace config.
3. **Network** — registry lookups, gated.

The first two need no HTTP and are deterministic, so they carry most of the value
at none of the risk. **They should ship before any network source.**

**Network sources need all four of these, in the first version:**

- **Cache + debounce + minimum prefix** (never issue a lookup for a 1-character
  prefix).
- **A lock file** (`dml.lock`) recording resolved dynamic values, so CI is
  deterministic and a resolution can be reviewed as a diff.
- **Trust model** — remote schemas pinned and hashed; local resolvers explicitly
  trusted. Dhall's remote imports have had a real security incident; that is the
  precedent to design against, not a theoretical risk.
- **Privacy** — only the minimum fragment leaves the machine, and it is switchable.

**Resolvers** are registered, typed and async:

```ts
export const VersionRange = defineType<string, [pkg: string]>({
  async complete({ prefix, args }) {
    const d = await registry(args.pkg)
    return Object.keys(d.versions).map((v) => ({
      label: v,
      detail: d.versions[v].deprecated ? "deprecated" : "",
    }))
  },
})
```

### Alternatives considered

**Plain TypeScript types.** If the document is pure data, `const cfg: Config = {…}`
gives type checking for free and needs no new engine. This is the strongest
alternative and it wins whenever the document is an object. Schema only earns its
place when (a) the document is a **tree** of elements/attributes, which TS object
types express poorly, (b) completion must be **positional**, or (c) a type needs
an **external source**. `dml.config.dml` is (a); a template is (a) and (b).

**Extending JSON Schema with a custom keyword.** Rejected: the dynamic behaviour
is not a validation keyword, it is a resolution protocol with caching, locking and
trust. JSON Schema has no place to put that.

**A new type syntax.** Rejected — reusing TS expressions means no new grammar and
keeps one type oracle.

**Putting the schema inside the document via a reserved dunder attribute.**
Rejected on shape grounds; see Shape rationale.

### Drawbacks

- **A network resolver in an editor** is latency, offline failure and a privacy
  decision all at once. The mitigation list above is not optional.
- **Executing TS resolvers is a supply-chain surface** comparable to
  `postinstall`. Local-only trust plus schema pinning is the minimum.
- **Complexity budget**: the project already has four Rust crates and three TS
  packages, and maintaining nine binary consumer locations needed a whole build
  script. A schema engine adds several new failure surfaces, so it must ship in
  layers rather than at once.
- **Two readings, two audiences.** Only the config reading benefits from a schema;
  the template reading gets its types from TS and components. The RFC should state
  which reading it governs (config), or it will be read as governing both.

### Unresolved questions

1. Reserved **attribute** vs a new `Member::SchemaDecl` variant? The variant is
   clearer semantically; the attribute is nearly free. Given the shape rule, the
   variant is preferred even at higher cost.
2. Is the binding vocabulary `key` / `value` / `parent` / `doc` / `root`
   sufficient? What is missing?
3. Can a schema document itself be `.tsdml`, so it can reference existing TS
   types?
4. Priority between multiple schemas (project-level, inline, inherited)?
5. How do resolver results travel between the LSP and the TS plugin? Today only
   the typed IR flows one way; this is the one genuinely new protocol.
6. Is committing `dml.lock` acceptable, or do dynamic values stay out of version
   control?
