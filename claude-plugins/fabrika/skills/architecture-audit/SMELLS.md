# Smell catalog

The finite list of code-shape smells the audit checks explicitly. It runs as a **coverage gate**
after the lens passes ([SKILL.md](SKILL.md) step 5): each smell gets one row carrying `✓ checked`,
`— N/A` or `✗ found`. What each status commits you to, and the table's shape, are the contract's:

```bash
fabrika wire doc-section --heading "The coverage gate" < <skill-base>/contract.md
```

The gate converts open-ended audit output into a **covered surface**. Two runs that surface
different findings can still be honestly compared, because they checked the same finite list. **The
catalog is the durable artifact; the candidate set is not.**

## Why a catalog at all

Every smell below is a **qualitative predicate**, never a numeric threshold: a reader who cannot
count tokens precisely will invent a count that clears whatever bar you set, so the bar is a shape
you can see rather than a number you have to measure.

## Why these smells

They are language-neutral, and each one names friction in the architecture vocabulary the repo's own
`.glossary/LANGUAGE.md` defines — depth, seam, locality, leverage. **The register is where those
terms are defined**, read at run time; this file points at it and holds no copy.

The shipped list is a starter, not a ceiling. A repo adds its own in the same table shape through
the `auditCatalogs` config key, and the gate emits those rows after the shipped ones. The extension
is add-only: nothing a repo declares can remove or replace a smell below.

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

Run the gate as a table, then promote any `✗ found` smell the lens passes missed into the finding
set before the table goes back to the human.

Two runs over the same code may surface different findings, and **their rows should still match** —
that is what the gate buys. A Status column that moves between runs is itself worth looking at.

**Count the rows at run time**, one per smell defined above, in order.
