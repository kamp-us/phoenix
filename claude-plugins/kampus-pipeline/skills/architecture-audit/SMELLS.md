# Smell catalog

A finite list of code-shape smells the audit must explicitly check. Used as a
**coverage gate** after the lens passes (see [SKILL.md](SKILL.md) step 4). For each
smell, the audit reports one of:

- **✓ checked** — looked, didn't find
- **— N/A** — smell doesn't apply to this code shape
- **✗ found** — present, with file/symbol reference (and which numbered finding covers it, if any)

The catalog converts open-ended audit output into a *covered surface*: two runs that
disagree on which findings they surface can still be honestly compared, because they
checked the same finite list. The catalog is the durable, transferable artifact — the
candidate set is not.

## Why a catalog at all

This is the load-bearing transferable artifact from pre-LLM refactoring research (SBSE /
Marinescu detection strategies / DECOR). The *search algorithms* didn't ship, but the
*smell catalogs* are the durable knowledge. We borrow the list, not the metrics — LLMs are
bad at counting tokens precisely, so smells are stated as qualitative predicates, not
metric thresholds.

## Why these specific smells

These ten are language-relatively-neutral and map directly onto the architecture vocabulary
in `.glossary/LANGUAGE.md` (depth, seam, locality, leverage). They cover the main failure
modes this audit is designed to find. The catalog is a starter — extend it as patterns recur
in this codebase (e.g. props-drilling for React-heavy code, provider-soup for context-heavy
code, layer-as-config for skill/plugin repos). When you extend it, the coverage gate emits
the new rows automatically — never hardcode the row count.

## The smells

### 1. Shallow module
Interface nearly as complex as the implementation. Caller has to learn N parameters or types
to invoke a thin wrapper. Fails the deletion test: removing the module would concentrate no
real complexity.

### 2. Pass-through layer
Module adds nothing structurally but a name. Calls one function, returns its result, maybe
renames a parameter. Deletion test: every caller would just inline the inner call.

### 3. Duplicated contract
The same algorithm, invariant, or data shape exists in ≥2 places without a shared source of
truth. Bugs fixed in one drift to the other. Symptom: identical helper functions, parallel
constant tables, mirrored validation rules.

### 4. Magic-string seam
A module's interface uses untyped string keys or values to do routing or state work where a
typed enum would close the silent-typo channel. Symptom: `"state=tripped"` as a magic value,
untyped event names, conventions documented only in prose comments.

### 5. Stale module
Code carries a docstring, file header, or comment declaring itself temporary, legacy,
deprecated, or pending removal — and is still in the live dependency graph. Symptom:
`// TODO: remove after migration`, `Legacy adapter — do not extend`, `// Phase 1 only`.

### 6. Test surface mismatch
Tests assert against private helpers, intermediate state, or implementation details rather
than the module's external interface. The interface is the test surface (a `.glossary/LANGUAGE.md`
principle); a violation here means refactors break tests that have nothing to say about behaviour.

### 7. Hidden global state
Module behaviour depends on imported globals, env vars, module-level mutables, or singletons
that aren't visible at the call site. Callers can't reason about the module without reading its
imports.

### 8. Shotgun surgery hotspot
Changes to one concept (a domain term, a config field, a protocol string, a UI label) require
touching ≥3 unrelated files. Symptom: renaming one thing involves N places.

### 9. Stale duplicate test
A test file's coverage is a strict subset of another canonical test file in the same module. The
duplicate survives migrations because nobody is sure it's safe to delete. Symptom: two test files
for the same module with overlapping fixtures.

### 10. Convention-over-code drift
A rule documented in prose (`CLAUDE.md`, a `.patterns/` doc, an inline comment, a PR template) is
enforced only by humans, not by the code. The next person to violate the rule won't know it
exists. Symptom: "always do X" in docs with no lint rule, type, or runtime check.

## Reporting in the coverage gate

The coverage gate is an internal accounting step, **not** a filed artifact (this skill files one
GitHub issue per consolidated finding — see [SKILL.md](SKILL.md) step 5, ADR 0099 — it does not
write an audit doc). Run the gate as a table to verify the lens passes covered the canonical
surface, then promote any `✗ found` smell the lenses missed into the finding set before filing:

```markdown
| Smell | Status | Notes |
|---|---|---|
| 1. Shallow module | ✗ found | finding 2 (`adapt-payload`) |
| 2. Pass-through layer | ✓ checked | none |
| 3. Duplicated contract | ✗ found | finding 1 |
| 4. Magic-string seam | ✗ found | finding 4 |
| 5. Stale module | ✓ checked | none |
| 6. Test surface mismatch | ✗ found | finding 3 |
| 7. Hidden global state | — N/A | no shared mutable state in scope |
| 8. Shotgun surgery hotspot | ✓ checked | none in this scope |
| 9. Stale duplicate test | ✓ checked | none |
| 10. Convention-over-code drift | — N/A | no convention claims in scope |
```

Two runs of the audit on the same code might surface different findings, but the **rows of
this table should match** — that's the point of the gate. Divergence in the Status column
across runs is itself a flag worth investigating. **Do not hardcode the row count** — emit one
row per smell defined above, in order.
