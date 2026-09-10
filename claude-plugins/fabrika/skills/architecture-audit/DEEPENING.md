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

Pure computation, in-memory state, no I/O. Always deepenable: merge the modules and test through the
new interface directly. No adapter.

### 2. Local-substitutable

Dependencies with a local test stand-in — an in-memory database, an in-memory filesystem, a local
runtime harness. Deepenable if the stand-in exists. The deepened module is tested with the stand-in
running in the suite; the seam stays internal, and no port appears at the module's external
interface.

### 3. Remote but owned

Your own services across a network or isolate boundary. Define a **port** at the seam: the deep
module owns the logic and the transport is injected as an **adapter** — an in-memory one for tests,
the real one in production.

Recommendation shape: *"define a port at the seam, implement a transport adapter for production and
an in-memory adapter for tests, so the logic sits in one deep module even though it is deployed
across a boundary."*

### 4. True external

Third-party services you do not control. The deepened module takes the dependency as an injected
port; tests supply a mock adapter.

## Seam discipline

- **One adapter is a hypothetical seam; two is a real one.** Do not introduce a port until two
  adapters are justified — typically production plus test. A single-adapter seam is indirection
  wearing a design pattern.
- **Internal seams are not external seams.** A deep module may have internal seams its own tests use.
  Do not expose one through the interface just because a test wants it.

## Testing strategy: replace, don't layer

- Old unit tests on the shallow modules become waste once tests exist at the deepened module's
  interface. Delete them.
- Write the new tests at that interface. The interface is the test surface.
- Assert observable outcomes through it, never internal state. A test that has to change when the
  implementation changes is testing past the interface.

## What this feeds

The category name goes into the finding's **suggested next step**, so whoever eventually opens the
work knows the test seam without re-deriving it. It is a non-binding hint, exactly as the intake
template requires — **the audit never mandates a fix**, and a category is not a verdict on whether
the work is worth doing.
