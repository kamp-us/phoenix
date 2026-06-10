# fate-effect interpreter — `FateInterpreter` + the protocol codecs + the differential oracle

The v2 native plane of `@phoenix/fate-effect` (PRD story 16; ADR 0042 "What v2 changes"): fate's `handleRequest` reimplemented as an Effect program, developed **against the v1 compiled server as a differential oracle** — identical operations through both backends must produce byte-equal wire output. Status: query/mutation/custom-list dispatch is oracle-green; `byId` rides the selection walk (task 15), connections complete the corpus (task 16), and the `route()` cutover that actually serves `/fate` from the interpreter is task 17. Until then **nothing worker-side changes** — the interpreter is exercised only by the oracle suite.

## The protocol codecs (`Protocol.ts`)

Two codec surfaces, split the way fate itself splits them:

- **The canonical schemas** — `ProtocolOperation`, `ProtocolRequest`, `ProtocolError`, `ProtocolSuccessResult`/`ProtocolFailureResult`/`ProtocolOperationResult`, `ProtocolResponse` — are fate's exported protocol types in Effect Schema form, field for field. Response structs declare fields in **fate's serialization order** (`{data, id, ok}` / `{error, id, ok}` / `{code, issues, message}`); Schema encode emits keys in declaration order, which is what makes byte-equality achievable.
- **`decodeProtocolRequest`** is fate's `assertProtocolRequest` as a **staged** Schema decode (envelope → per-operation base → kind-conditional fields), each stage failing with fate's own `FateRequestError("BAD_REQUEST", <fate's exact message>)`. The staging preserves fate's **leniency** as much as its strictness: fate checks `ids`/`type` only for `byId` and `name` only for named kinds, so junk in kind-unchecked fields must pass — the canonical schema is *stricter* than fate's runtime gate and is therefore not the dispatch gate. The decoded result is a discriminated union (`ProtocolByIdOperation | ProtocolNamedOperation`), so dispatch cannot see an unvalidated state.

**The drift pin** (`Protocol.unit.test.ts`): type-level `toEqualTypeOf` pins of the schemas' `Type` against `@nkzw/fate`'s exported `FateOperation`/`FateProtocolRequest`/`FateProtocolResponse` (+ result/error members derived from them), under a `Wire<>` normalizer that erases **mutability only** (fate types mutable arrays; Schema types `ReadonlyArray` — indistinguishable on the wire). Keys, optionality, and value types stay exact, so a fate upgrade that moves the protocol fails `tsgo` before any runtime test runs. The wire `code` is deliberately `string` (phoenix's annotated codes are wider than fate's closed union — [fate-effect-wire-errors.md](./fate-effect-wire-errors.md)); the pin substitutes fate's union back in and demands exact equality on everything else.

## The dispatch loop (`Interpreter.ts`)

`FateInterpreter.handleRequest(request, context): Effect<Response, never, FateServer>` — decode → run concurrently → encode:

- Operations dispatch via `Effect.forEach(…, {concurrency: "unbounded"})` (the order-preserving collector; fate's own loop is `Promise.all`).
- Each operation runs the entry's `resolve` with the per-request pair provided as VALUES off the `FateRequestContext` and the captured build-time services beneath — the v1 compiler's provision pipeline verbatim, minus the Promise hop: **no runtime is owned here**. The caller runs the program (the oracle's test `ManagedRuntime` today; the platform layer at cutover), so the package's single Effect→Promise conversion point stays in `Executor.ts`.
- Failures map through `encodeWireError` — the **one annotation codec both backends share** — then onto the protocol error shape; request-level failures (malformed JSON/protocol) serialize as fate's single `id: "request"` result with the error's own status. Pending planes (`byId`, raw legacy records) fail **closed**: an un-annotated defect, i.e. the fixed internal wire error, no detail leak.
- Lookups guard with `Object.hasOwn` — fate indexes the raw record and would trip over prototype names (`"constructor"`); a prototype name is not a registered operation. Deliberate, documented divergence; everything else is byte-faithful.

## The differential oracle (`Interpreter.test.ts`)

The harness runs every corpus step through **both** backends — v1 (`FateExecutor.toFetchHandler` over a `ManagedRuntime`) and v2 (`FateInterpreter.handleRequest` through its own runtime) — each over its **own fresh in-memory database** (the `Executor.test.ts` harness shape, sozluk-flavored), and asserts equality of status, content-type, body **text** (bytes, not parsed shape), and the recorded `LivePublisher` calls. Mutations run through both worlds in lockstep, so later reads prove **state parity**, not just response parity.

Corpus rules learned here:

- **No intra-batch read-after-write.** fate's `Promise.all` and Effect's fiber scheduling interleave differently; neither backend guarantees write-then-read ordering inside one protocol request. Only cross-request reads are deterministic — the oracle only pins deterministic output.
- Error cases are corpus citizens: annotated codes, `UNAUTHORIZED`, `VALIDATION_ERROR` (same Schema renders the same message on both sides), `NOT_FOUND`, defects (fixed internal message), died-`FateRequestError` passthrough with `issues`, dispatch-time `BAD_REQUEST` (empty name), and every malformed-protocol rejection with its 400 status.
- fate's acceptance **leniency** is itself a corpus case (junk in kind-unchecked fields must succeed on both sides).

When the walk (task 15) and connections (task 16) land, they extend this corpus — byId/nested-ref/connection steps — until the full operation surface is byte-equal and task 17 swaps `makeHandleFate` to the interpreter.
