# Deepening

How to deepen a shallow module safely, given what it depends on. This is the four-category
dependency taxonomy a finding's **suggested next step** uses when it proposes a direction. It is
audit method, not vocabulary: the structural terms it leans on — module, interface, seam, adapter —
are defined in the repo's own `.glossary/LANGUAGE.md`, read at run time, and are deliberately not
redefined here.

## Dependency categories

Classify a finding's dependencies. The category decides how the deepened module is tested across its
seam.

### 1. In-process

Pure computation or in-memory state without I/O. Test behavior through the proposed interface
directly. Consolidation is useful when it concentrates a responsibility callers currently share;
purity alone is no reason to merge modules or delete a useful interface.

### 2. Local-substitutable

Dependencies whose relevant behavior a local substitute can faithfully exercise, such as filesystem
operations or a runtime harness. Use the repo's established substitution seam. A stand-in proves
only the behavior it preserves; it cannot establish a real platform's storage or runtime semantics.
Read the repo's test-tier decisions before proposing a substitute.

### 3. Remote but owned

Your own modules across a network or isolate boundary. Consider a port at the seam so the deep
module owns the logic and the transport is supplied as an adapter. Reuse an existing service or
transport interface when it already owns this responsibility; the category alone does not justify
a new abstraction. A local adapter can test control flow, while cross-runtime behavior may require
an integration test.

### 4. True external

Third-party services you do not control. Identify what the existing dependency interface owns and
what still leaks to callers. A substitute can exercise local behavior through that seam; it does
not establish the third party's contract. Propose an owned port only where the responsibility and
actual variation justify one.

## Seam discipline

- Justify a proposed port with the policy it hides or concrete substitution callers need. Production
  and test adapters can demonstrate that need; creating a second adapter merely to satisfy a count
  adds no evidence. Check the repo's existing service pattern before proposing another boundary.
- **Internal seams are not external seams.** A deep module may have internal seams its own tests use.
  Do not expose one through the interface just because a test wants it.

## Testing through the interface

- Replace old tests only when the new interface tests preserve their behavioral claims. Keep tests
  for contracts that still vary or require a different fidelity; duplication is demonstrated by
  covered behavior, not by two files mentioning the same module.
- Write the new tests at that interface. The interface is the test surface.
- Assert observable outcomes through it, never internal state. A test that has to change when the
  implementation changes is testing past the interface.

## What this feeds

The category name goes into the finding's **suggested next step**, so whoever eventually opens the
work knows the test seam without re-deriving it. It is a non-binding hint, exactly as the intake
template requires — **the audit never mandates a fix**, and a category is not a verdict on whether
the work is worth doing.
