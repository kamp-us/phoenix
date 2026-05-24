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
| [0012](0012-admin-parallel-services.md) | Admin operations as parallel `<Feature>Admin` services with a separate runtime | accepted | 2026-05-17 |
| [0013](0013-validation-in-service-methods.md) | Input validation lives in service methods, not the resolver layer | accepted | 2026-05-17 |
| [0014](0014-drizzle-run-batch-as-service-methods.md) | Drizzle service exposes `run`/`batch` as bound methods on the service value | accepted | 2026-05-17 |
