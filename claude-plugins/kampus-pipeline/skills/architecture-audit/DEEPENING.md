# Deepening

How to deepen a cluster of shallow modules safely, given its dependencies. Assumes the
architecture vocabulary in `.glossary/LANGUAGE.md` — **module**, **interface**, **seam**,
**adapter**. This is the four-category dependency taxonomy a finding's *suggested next step*
uses when proposing how to deepen something; it is method, not vocabulary.

## Dependency categories

When assessing a finding for deepening, classify its dependencies. The category determines
how the deepened module is tested across its seam.

### 1. In-process

Pure computation, in-memory state, no I/O. Always deepenable — merge the modules and test
through the new interface directly. No adapter needed.

### 2. Local-substitutable

Dependencies that have local test stand-ins (an in-memory D1/SQLite for the bound database,
an in-memory filesystem, a workerd test harness). Deepenable if the stand-in exists. The
deepened module is tested with the stand-in running in the test suite. The seam is internal;
no port at the module's external interface.

### 3. Remote but owned (Ports & Adapters)

Your own services across a network or isolate boundary (a Durable Object, an internal API,
another worker). Define a **port** (interface) at the seam. The deep module owns the logic;
the transport is injected as an **adapter**. Tests use an in-memory adapter. Production uses
the real DO/HTTP/queue adapter.

Recommendation shape: *"Define a port at the seam, implement a DO/HTTP adapter for production
and an in-memory adapter for testing, so the logic sits in one deep module even though it's
deployed across an isolate boundary."*

### 4. True external (Mock)

Third-party services (a payment provider, an external auth issuer, a mail API) you don't
control. The deepened module takes the external dependency as an injected port; tests provide
a mock adapter.

## Seam discipline

- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a
  port unless at least two adapters are justified (typically production + test). A
  single-adapter seam is just indirection.
- **Internal seams vs external seams.** A deep module can have internal seams (private to its
  implementation, used by its own tests) as well as the external seam at its interface. Don't
  expose internal seams through the interface just because tests use them.

## Testing strategy: replace, don't layer

- Old unit tests on shallow modules become waste once tests at the deepened module's interface
  exist — delete them.
- Write new tests at the deepened module's interface. The **interface is the test surface**.
- Tests assert on observable outcomes through the interface, not internal state.
- Tests should survive internal refactors — they describe behaviour, not implementation. If a
  test has to change when the implementation changes, it's testing past the interface.

This taxonomy feeds a filed finding's **Suggested next step (non-binding)** section: name the
dependency category so the eventual implementer knows the test seam before opening the work,
without re-deriving it. It is a non-binding hint, exactly as `report`'s template requires — the
audit never mandates a fix.
