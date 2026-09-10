# Smell catalog

The finite list of code-shape smells the audit checks explicitly. It runs as a **coverage gate**
after the lens passes ([SKILL.md](SKILL.md) step 4). Every smell gets an evidence row using
`fabrika wire doc-section --heading "The coverage gate" < <skill-base>/contract.md`,
including an explicit gap when it was not examined. The list is stable; each run's inspected reach and conclusions may differ. Comparing them
requires both, not an assertion that searching a folder inspected every file inside it.

## Why a catalog at all

The catalog checks questions organic exploration can miss. Each entry is a qualitative shape to
investigate, not a score or an automatic defect. A confirmed shape still needs evidence of friction:
a compatibility reader can be necessary, and a small module can hide a valuable invariant.

## Why these ten

They are language-neutral, and each one names friction in the architecture vocabulary the repo's own
`.glossary/LANGUAGE.md` defines — depth, seam, locality, leverage. **This file does not define those
terms and must not**: it points at the register, and the audit reads the register at run time.

The ten are a starter, not a ceiling. A repo adds its own in the same table shape through the
`auditCatalogs` config key, and the gate emits those rows after the shipped ones. The extension is
add-only: nothing a repo declares can remove or replace a smell below.

## The smells

### 1. Shallow module
Interface nearly as complex as the implementation. A caller learns N parameters or types to invoke a
thin wrapper. Fails the deletion test: removing the module would concentrate no real complexity.

### 2. Pass-through layer
The module adds a name and nothing structural. It calls one function, returns its result, maybe
renames a parameter. Deletion test: every caller would simply inline the inner call.

### 3. Duplicated contract
One algorithm, invariant, or data shape lives in two or more places with no shared source of truth,
so a fix in one drifts from the other. Symptoms: identical helpers, parallel constant tables,
mirrored validation rules.

### 4. Magic-string seam
A module's interface routes or holds state on untyped string keys where a typed set would close the
silent-typo channel. Symptoms: a state name compared as a literal, untyped event names, a convention
documented only in a comment.

### 5. Stale module
Code declares itself temporary, legacy, deprecated or pending removal — in a docstring, a file
header, a comment — and is still in the live dependency graph. Symptoms: "remove after the
migration", "legacy adapter, do not extend", "phase one only".

### 6. Test surface mismatch
Tests assert against private helpers, intermediate state, or implementation details rather than the
module's external interface. The interface is the test surface; a violation here means a refactor
breaks tests that had nothing to say about behaviour.

### 7. Hidden global state
Module behaviour depends on imported globals, environment variables, module-level mutables or
singletons that are invisible at the call site. A caller cannot reason about the module without
reading its imports.

### 8. Shotgun surgery hotspot
Changing one concept — a domain term, a config field, a protocol string, a label — requires touching
three or more unrelated files. Symptom: renaming one thing means editing N places.

### 9. Stale duplicate test
A test file's coverage is a strict subset of another canonical test file for the same module. The
duplicate survives every migration because nobody is sure it is safe to delete. Symptom: two test
files for one module with overlapping fixtures.

### 10. Convention-over-code drift
A rule documented in prose — a repo contract file, a pattern doc, a comment, a pull-request template
— is enforced by humans and by nothing else. The next person to violate it will not know it exists.
Symptom: "always do X" in docs, with no lint rule, type, or runtime check behind it.

## Reporting the gate

The gate is accounting on the initial grilling session, not a separate backlog issue. Only selected
scopes become actionable reports. Account for every row after exploration. A newly
noticed shape gets the same evidence check as a lens candidate; preserve its uncertainty or rejection
reason. Keep the table available and summarize meaningful limits in the selection conversation:

```markdown
| Smell | Status | Notes |
|---|---|---|
| 1. Shallow module | ✗ found | finding 2 (`adapt-payload`) |
| 2. Pass-through layer | ✓ checked | traced the three request adapters; each owns error translation |
| 3. Duplicated contract | ✗ found | finding 1 |
| 4. Magic-string seam | ✗ found | finding 4 |
| 5. Stale module | ✓ checked | traced request-adapter exports to current callers |
| 6. Test surface mismatch | ✗ found | finding 3 |
| 7. Hidden global state | ✓ checked | request adapters receive configuration explicitly |
| 8. Shotgun surgery hotspot | ✓ checked | traced timeout-policy changes across the request adapters |
| 9. Stale duplicate test | ? unexamined | test suite ownership was not inspected |
| 10. Convention-over-code drift | — N/A | no convention claims in scope |
```

Two runs must account for the same catalog rows; their statuses need not match. Different inspected
reach or new evidence can explain a changed answer. Do not claim complete coverage while a row is
unexamined, or present a negative check as an exhaustive proof.

**Never hardcode the row count.** Emit one row per smell defined above, in order, then one per smell
in each declared repo catalog, in the order the `auditCatalogs` key lists them.
