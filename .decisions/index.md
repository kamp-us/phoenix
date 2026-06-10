# Decisions

One row per ADR. Read the file for the why.

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](0001-no-export-default.md) | No `export default` | accepted | 2026-05-09 |
| [0002](0002-disable-exact-optional-for-spa.md) | Disable `exactOptionalPropertyTypes` for the SPA tsconfig only | accepted | 2026-05-09 |
| [0003](0003-pasaport-singleton-do.md) | Pasaport runs as a singleton Durable Object | superseded by [0009](0009-d1-direct-defer-dos-and-workflows.md) | 2026-05-16 |
| [0004](0004-product-dos-bootstrap-as-singletons.md) | Product DOs bootstrap as singletons; refactor to per-atom shards on demand | superseded | 2026-05-09 |
| [0005](0005-product-dos-shard-by-coordination-atom.md) | Product DOs shard by coordination atom from day one | superseded by [0009](0009-d1-direct-defer-dos-and-workflows.md) | 2026-05-16 |
| [0006](0006-product-dos-extend-cloudflare-agent.md) | Product DOs extend Cloudflare's Agent base class | superseded by [0009](0009-d1-direct-defer-dos-and-workflows.md) | 2026-05-16 |
| [0007](0007-view-layer-outbox-workflows-d1.md) | View layer — outbox + Workflows + single D1, triggered inline | accepted | 2026-05-09 |
| [0008](0008-mutations-as-workflows.md) | Mutations route through workflows; DOs are pure state-keepers | superseded by [0009](0009-d1-direct-defer-dos-and-workflows.md) | 2026-05-16 |
| [0009](0009-d1-direct-defer-dos-and-workflows.md) | D1-direct; defer DOs, projection, and workflows | accepted | 2026-05-16 |
| [0010](0010-effect-context-service-backend.md) | Effect Context.Service architecture for resolver-down backend code | accepted | 2026-05-17 |
| [0011](0011-drizzle-context-service.md) | Drizzle access via `Context.Service` with `run`/`batch` callbacks | superseded-in-part by [0014](0014-drizzle-run-batch-as-service-methods.md) | 2026-05-17 |
| [0012](0012-admin-parallel-services.md) | Admin operations as parallel `<Feature>Admin` services with a separate runtime | retired (PR #12) | 2026-05-17 |
| [0013](0013-validation-in-service-methods.md) | Input validation lives in service methods, not the resolver layer | accepted | 2026-05-17 |
| [0014](0014-drizzle-run-batch-as-service-methods.md) | Drizzle service exposes `run`/`batch` as bound methods on the service value | accepted | 2026-05-17 |
| [0015](0015-adopt-fate-native-protocol.md) | Adopt fate's native protocol as the data layer | accepted | 2026-05-23 |
| [0016](0016-fate-pure-transport-effect-services-domain.md) | fate is pure transport; Effect services stay the domain | accepted | 2026-05-23 |
| [0017](0017-hono-route-owns-fate-runtime.md) | The Hono route owns and disposes the per-request fate runtime | superseded by [0029](0029-worker-runtime-servicemap.md) | 2026-05-23 |
| [0018](0018-data-views-drop-global-ids.md) | Data views are the schema; drop global IDs and the Node interface | accepted | 2026-05-23 |
| [0019](0019-connection-pagination-strategy.md) | Connection pagination — custom list resolvers for roots, source connection for nested | accepted | 2026-05-23 |
| [0020](0020-fate-mutation-conventions.md) | fate mutation conventions | accepted | 2026-05-23 |
| [0021](0021-frontend-on-react-fate.md) | Frontend on react-fate — batched per-screen requests, declarative mutations | accepted | 2026-05-23 |
| [0022](0022-server-types-single-source-of-truth.md) | Server types are the single source of truth; fate codegen replaces relay-compiler | accepted | 2026-05-23 |
| [0023](0023-live-views-sse-livedo.md) | Live views over SSE, fanned out by the LiveDO Durable Object | amended-in-part by [0025](0025-split-livedo-connection-topic.md), [0028](0028-effect-durable-object-model.md), [0037](0037-unified-void-aligned-live-do.md) | 2026-05-23 |
| [0024](0024-delete-semantics-and-karma.md) | Entity-delete semantics and karma treatment | proposed | 2026-05-24 |
| [0025](0025-split-livedo-connection-topic.md) | Split LiveDO into ConnectionDO and TopicDO | superseded by [0037](0037-unified-void-aligned-live-do.md) | 2026-05-24 |
| [0026](0026-adopt-alchemy-effect-infra.md) | Adopt alchemy-effect as the infrastructure layer | accepted | 2026-05-25 |
| [0027](0027-http-router-drop-hono.md) | Drop Hono; HTTP via Effect HttpRouter and HttpApiBuilder | accepted | 2026-05-25 |
| [0028](0028-effect-durable-object-model.md) | Port Durable Objects to alchemy's Effect DO model | amended-in-part by [0032](0032-alchemy-beta45-and-dev-model.md) | 2026-05-25 |
| [0029](0029-worker-runtime-servicemap.md) | Dissolve the per-request runtime; worker-level layers and a captured ServiceMap | superseded-in-part by [0041](0041-fate-bridge-worker-managed-runtime.md) | 2026-05-25 |
| [0030](0030-single-worker-vite-dev.md) | Single worker via Worker+assets, with a two-process HMR dev loop | accepted | 2026-05-25 |
| [0031](0031-local-first-dev-state.md) | Local-first state for dev; remote state for CI and deploy | amended-in-part by [0032](0032-alchemy-beta45-and-dev-model.md) | 2026-05-25 |
| [0032](0032-alchemy-beta45-and-dev-model.md) | Upgrade to alchemy@2.0.0-beta.45 + effect@4.0.0-beta.74; accept deploy-infra-to-cloud as the dev model | accepted | 2026-05-29 |
| [0033](0033-mutual-do-layer-cycle-per-call-resolution.md) | Co-hosted mutual DOs cannot Init-bind each other — use per-call sibling resolution | retired by [0037](0037-unified-void-aligned-live-do.md) | 2026-05-29 |
| [0034](0034-fate-native-sse-protocol.md) | Stay on fate's native SSE + POST protocol; do not redesign to WebSocket | accepted | 2026-05-29 |
| [0035](0035-cli-conventions.md) | CLI conventions — small focused tools, name mirrors bin (no catch-all `cli`) | accepted | 2026-05-31 |
| [0036](0036-features-as-any-named-app-grouping.md) | features/ is any named app-level grouping, not just product domains | accepted | 2026-05-30 |
| [0037](0037-unified-void-aligned-live-do.md) | Unified void-aligned LiveDO — one class, two roles, KV storage | accepted | 2026-05-30 |
| [0038](0038-dependency-patches-local-only.md) | Dependency patches are local-only — no fork/git/unmerged-PR sources; local `pnpm patch` if unavoidable | accepted | 2026-05-31 |
| [0039](0039-livebus-context-service.md) | LiveBus Context.Service replaces the AsyncLocalStorage publisher bridge | amended-in-part by [0042](0042-fate-effect-v1-architecture.md) | 2026-05-31 |
| [0040](0040-testing-taxonomy-and-seam-graduation.md) | Testing taxonomy and test-seam graduation | accepted | 2026-06-07 |
| [0041](0041-fate-bridge-worker-managed-runtime.md) | fate↔Effect bridge — one worker-level ManagedRuntime (F4) | amended-in-part by [0042](0042-fate-effect-v1-architecture.md) | 2026-06-07 |
| [0042](0042-fate-effect-v1-architecture.md) | fate-effect v1 — the Effect-native fate integration; the bridge is deleted | accepted | 2026-06-10 |
