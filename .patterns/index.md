# Phoenix patterns

Reusable patterns for writing phoenix code — the backend and the frontend's data layer. The `effect-*`, `fate-*`, and `alchemy-*` docs are **evergreen**: they describe how the codebase is structured, not how to migrate to it — the load-bearing references when adding features, fixing bugs, or onboarding. The `alchemy-*` docs cover the infra layer ([alchemy-overview.md](./alchemy-overview.md)).

Start with [effect-context-service.md](./effect-context-service.md) and [feature-services.md](./feature-services.md). The rest fill in.

## Three layers

- **Effect domain layer** (the `effect-*` docs) — services, errors, layer composition, tracing, testing, validation. Transport-agnostic: domain logic knows nothing about how data reaches the client.
- **fate protocol layer** (the server-side `fate-*` docs) — how the backend serves data: data views as the schema, `@kampus/fate-effect` composing the `Fate.*` config into `FateServer`, `Fate.source` loaders backing each view. Served by [fate](https://github.com/usirin/fate)'s native protocol on the request fiber (ADR 0043). No tRPC/GraphQL adapter; no Hono.
- **fate client layer** (the client-side `fate-*` docs) — how the SPA consumes data: components declare views, one batched `useRequest` per screen, declarative mutations, live views over SSE. Built on `react-fate`.

The protocol and client layers share one view/type model — the server's `Entity<>` types are the client's types, generated. The `@kampus/fate-effect` package ([fate-effect-server.md](./fate-effect-server.md) + [fate-effect-interpreter.md](./fate-effect-interpreter.md)) is the domain↔protocol seam; read those first when working server-side.

## Index — Effect domain layer

| Doc | Topic | Read when |
|---|---|---|
| [effect-context-service.md](./effect-context-service.md) | Effect v4 `Context.Service` (not v3 `Context.Tag`), class-form services, layer shapes, service-method shape | Defining a new service or layer |
| [feature-services.md](./feature-services.md) | One service per feature folder, `Drizzle` capability service, `Drizzle.run`/`Drizzle.batch` | Adding a feature service, writing service methods |
| [effect-layer-composition.md](./effect-layer-composition.md) | `Layer.mergeAll`/`Layer.provide`/`provideMerge`, parameterized Layer factories, the worker-level layer set (ADR 0029) | Wiring services into the worker, adding a feature Layer |
| [effect-errors.md](./effect-errors.md) | `Schema.TaggedErrorClass` modeling, domain vs infra split, the `FateWireCode` annotation | Designing a new error or feature's error set |
| [error-copy-law.md](./error-copy-law.md) | The voice-and-clarity law for an error `message`'s English source copy; subordinate to the `wireMessages` registry + no-leak codec; i18n out of scope ([#3378](https://github.com/kamp-us/phoenix/issues/3378)) | Authoring a user-facing error `message`, or a `WIRE_MESSAGES` entry |
| [effect-error-operators.md](./effect-error-operators.md) | `Effect.catchTag`/`Tags`/`All`, `Effect.exit`, `Cause`/`Exit` inspection | Catching, recovering, or inspecting failures at a boundary |
| [effect-fn-tracing.md](./effect-fn-tracing.md) | `Effect.fn` for service methods, span-naming conventions | Writing or naming a service method |
| [effect-platform-access.md](./effect-platform-access.md) | The host platform through Effect services — `FileSystem`/`Path`/`Crypto` (v4 `@effect/platform-node` `NodeServices.layer`, not v3) over raw `node:*`; the swappable-`FileSystem` test seam; when raw `node:*` is still correct | Reading/writing files, building paths, or minting ids in Effect code ([#3461](https://github.com/kamp-us/phoenix/issues/3461)) |
| [effect-testing.md](./effect-testing.md) | The two-tier model — `unit` (no DB) / `integration` (real remote D1) ([ADR 0082](../.decisions/0082-two-test-tiers-unit-integration.md)); the `node:sqlite`/`makeSqliteTestDb` ban; the `Drizzle`-seam substitution; the `layerTest`/`layerStub`/`layerNoop` naming; `@effect/vitest` | First stop before any test — pick the tier, then the seam |
| [effect-schema-validation.md](./effect-schema-validation.md) | `Schema.Class` for trust-boundary input validation | Validating untyped input (`HttpApi` payloads, external responses, persisted JSON) |
| [effect-sse-externally-driven.md](./effect-sse-externally-driven.md) | `Stream.fromQueue` + `Stream.merge(keep-alive)` + `HttpServerResponse.stream`; deliver offers onto the queue | Building an SSE response written to from another component (e.g. the `LiveDO` topic `deliver` RPC) |
| [authz-capability-as-effect.md](./authz-capability-as-effect.md) | The `@kampus/authz` capability-as-Effect mechanism: builder → discharge verb → sealed `Grant` → `.provide`; "forgot-to-check is a compile error"; ports adapted in `features/kunye` | Gating a privileged op, adding a capability/right/relation, or touching `packages/authz` ([ADR 0107](../.decisions/0107-capability-authz-framework.md)) |
| [caylak-content-containment.md](./caylak-content-containment.md) | The çaylak-sandbox seam across write paths: `sandboxedAtForAuthor`, the `decidePublish` viewer-blind gate, sandbox-aware read predicates; the per-path containment map + the two known gaps | Adding any çaylak-reachable write path — decide if it needs the sandbox seam |
| [telemetry.md](./telemetry.md) | The product-usage telemetry seam: the `Telemetry` Tag + `emit`, `TelemetryLive`, the positional AE event-schema in `toDataPoint`, the S4 fail-safe, the add-an-instrument recipe, the sampling-correct read contract | Adding/instrumenting product-usage telemetry, or querying it ([ADR 0153](../.decisions/0153-analytics-engine-telemetry-seam.md)) |
| [sentry.md](./sentry.md) | The Sentry error/crash monitoring seam (worker + SPA): the `dataCollection` options, the `sentryEnabled` inert-without-DSN invariant, the worker `wrapRequestHandler` init + `captureUnhandled` (the effect-layer capture gap), the PII posture | Wiring or changing Sentry capture on either tier ([ADR 0118](../.decisions/0118-error-crash-monitoring-sentry-saas.md)) |

## Index — fate protocol layer

Read [fate-effect-server.md](./fate-effect-server.md) + [fate-effect-interpreter.md](./fate-effect-interpreter.md) first — they're the seam everything else hangs off.

| Doc | Topic | Read when |
|---|---|---|
| [fate-effect-wire-errors.md](./fate-effect-wire-errors.md) | The `@kampus/fate-effect` error contract: the `FateWireCode` annotation, `encodeWireError`, the no-registry/one-edit rule, the enumeration pin | Declaring a domain error |
| [fate-effect-data-views.md](./fate-effect-data-views.md) | View authoring: the `FateDataView<Row>()("Name")({fields})` class factory, `FateDataView.list` relations, `Entity<typeof View>` | Declaring an entity view |
| [fate-effect-sources.md](./fate-effect-sources.md) | Loader authoring + read conventions: `Fate.source(...)`, the loader contract (`byId`/`byIds`, silent reads, `E = never`), no `connection` handlers (ADR 0019), the view→service map | Declaring a source / wiring a view's reads to a service |
| [fate-effect-operations.md](./fate-effect-operations.md) | Resolver authoring + write conventions: `Fate.query`/`Fate.list`/`Fate.mutation` (pure-data def + `Effect.fn` handler), the decode-then-run wrapper, `entity.verb` naming, live publishes | Declaring a query/list/mutation, or writing a mutation |
| [fate-effect-server.md](./fate-effect-server.md) | The `@kampus/fate-effect` composite: `FateServer` tag + `config` + `layer`, the `CurrentUser`/`LivePublisher` per-request contract (+ `livePublisherFor`), init-time validation | Composing the fate server / discharging domain layers |
| [fate-effect-compiler.md](./fate-effect-compiler.md) | The compile step (`FateExecutor`) — post-v2-cutover (ADR 0043) the differential-oracle baseline + build-time codegen surface, not a serving path | Touching `Executor.ts`/`Codegen.ts`/`Compiled.ts`/`RequestContext.ts`, the oracle baseline, or `schema.ts` codegen |
| [fate-effect-interpreter.md](./fate-effect-interpreter.md) | The v2 native serving path (ADR 0043): the protocol Schema codecs + drift pin, the `handleRequest` dispatch loop, the batched selection walk, the connection plane, the oracle harness rules | Touching `Protocol.ts`/`Interpreter.ts`/`Walk.ts`/`Connection.ts`, or the oracle corpus |
| [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) | The worker-side composition: `fateConfig`, `PhoenixFateLive`, the init-only `ManagedRuntime`, the `/fate` route + abort wiring, `schema.ts` codegen | Wiring fate in `apps/web/worker`; the fate↔domain seam |
| [fate-data-views.md](./fate-data-views.md) | View modeling conventions: selection masking as the authorization surface, the Missing-`id` rules, discriminant feeds, raw per-type IDs | Modeling an entity type |
| [fate-connections.md](./fate-connections.md) | `ConnectionResult`, custom `lists` resolvers vs source `connection`, cursor ownership | Writing a paginated list |
| [per-feature-fate-aggregators.md](./per-feature-fate-aggregators.md) | Per-feature `queries.ts`/`lists.ts`/`views.ts`/`shapers.ts`/`sources.ts`/`mutations.ts` + a `fate-module.ts` manifest the root merges; SPA import surface preserved | Adding/moving a fate fragment, or scaffolding a feature module ([ADR 0036](../.decisions/0036-features-as-any-named-app-grouping.md)) |

## Index — fate client layer

Read [fate-client-setup.md](./fate-client-setup.md) first, then [fate-views-and-requests.md](./fate-views-and-requests.md).

| Doc | Topic | Read when |
|---|---|---|
| [fate-client-setup.md](./fate-client-setup.md) | `createFateClient`, `<FateClient>` provider, auth, generated client, Suspense/error rails | Wiring the client / app shell |
| [fate-views-and-requests.md](./fate-views-and-requests.md) | `view`/`useView`/`ViewRef`, masking, one batched `useRequest` per screen, `useListView` pagination | Reading data in a component |
| [fate-mutations-client.md](./fate-mutations-client.md) | `fate.mutations`/`actions`, optimistic updates, `insert`/`delete` membership, error routing | Writing data from the UI |
| [fate-hydration.md](./fate-hydration.md) | `dehydrate()`/`hydrate()` — the versioned JSON-safe cache snapshot, the hydrate-before-first-`useRequest` contract, `hydrationScope` rotation as invalidation, `HydrationLimits` | Persisting/restoring the client cache ([#2316](https://github.com/kamp-us/phoenix/issues/2316)) or an SSR-style boot-time cache transfer |
| [fate-live-views.md](./fate-live-views.md) | **Reference** — the live machinery: `useLiveView`/`useLiveListView`, the server `live.*` publish API, the SSE wire, the unified `LiveDO` | Looking up the live hooks, the publish API, or how the `LiveDO` transport works |
| [fate-live-publishing.md](./fate-live-publishing.md) | **How-to** — making a mutation publish its live invalidation: acquire the publisher + bind `live.ts`, publish-after-write by shape, the `broadcastIf` gate, recipient-scoped channel authorization | Writing or changing a mutation over a live-subscribed entity (`Post`/`Comment`/`Definition`) |
| [fate-live-consistency.md](./fate-live-consistency.md) | **Explanation** — why a live view goes stale and self-heals: the [invalidation invariant](./fate-live-consistency.md#invalidation-invariant), the app-lifetime live pin, the mutator's-own-view read-back | Reasoning about live staleness, or the publish invariant's *why* |
| [fate-async-react.md](./fate-async-react.md) | The "feels instant" defaults on fate + React 19 concurrency: the stable `<Suspense>` boundary, `useTransition`/`isPending`, height-matched skeletons (no CLS), and why `defer` can't reach nested connections | Building a screen's loading/pending path — before a spinner, a hard-swapping fallback, or a `defer` on a nested connection (#2161) |
| [fate-page-queries.md](./fate-page-queries.md) | The page-composition law: one root query per page (Relay-style), nested connections composed inline; a second query needs justification; `defer` blocked pending [#2188](https://github.com/kamp-us/phoenix/issues/2188); live subscribes are post-paint | Composing a page's data — how many fate requests, where a nested connection rides, or whether to add a second query |

## Index — UI / components layer

The frontend's component layer (above the fate client data layer). phoenix's UI primitives are
[Base UI](https://base-ui.com) (`@base-ui/react`), unstyled + accessible-by-default; the wrappers
live in `apps/web/src/components/ui/`.

| Doc | Topic | Read when |
|---|---|---|
| [base-ui-accessibility.md](./base-ui-accessibility.md) | What Base UI wires automatically (roles, disclosure/popup ARIA, focus, accessible name from content); the icon-only-name gap; no `aria-label` on a text-bearing control + the four legitimate hand-authored-label cases | Adding or labelling an interactive control, or reaching for an `aria-label` |
| [property-based-a11y.md](./property-based-a11y.md) | The property-based a11y gate over `ui/` (`fast-check` × `axe-core` in jsdom asserting the ADR 0162 pillar-4 invariants); the warning-to-enforced promotion loop; fail-closed auto-coverage; how to add/classify a primitive | Adding a `ui/` primitive, promoting an a11y warning, or extending the harness ([ADR 0162](../.decisions/0162-four-pillars-design-law.md)) |
| [design-sync-authority.md](./design-sync-authority.md) | The one-directional per-layer `/design-sync` authority: tokens/style → the visual tool is source; component logic + a11y → the repo primitive is source. Enforced by the property-based a11y loop + the entry-row spine lock | Before any design round-trip, or when changing an entry-row primitive's behavior vs its paint ([ADR 0162](../.decisions/0162-four-pillars-design-law.md)) |
| [moderation-admin-shared-components.md](./moderation-admin-shared-components.md) | The one shared moderation/admin component layer (`apps/web/src/components/moderation/`): the cross-surface primitives, the shared-primitive + thin-per-surface-wrapper shape, the reuse-don't-fork rule, extract-on-the-second-consumer | Building or extending any moderation/admin UI — before forking a user-list / action-row ([ADR 0147](../.decisions/0147-shared-moderation-admin-component-layer.md) / [0138](../.decisions/0138-divan-actor-centric-spine.md)) |
| [reachability-journey-e2e.md](./reachability-journey-e2e.md) | Writing a `@journey:<flag-key>` reachability e2e (ADR 0173 §2): force the edge payload at the network seam (`page.route`), strip/re-inject the `__BOOT__` tag, prove zero-CLS two ways, cover the absent-payload half; the `flows`-lane + signed-in-divergence gotcha | Authoring a reachability/journey e2e for a dark-ship flag, or a zero-CLS first-paint proof ([ADR 0173](../.decisions/0173-vertical-completeness-gate.md) / [0179](../.decisions/0179-edge-resolved-shell-state-boot-contract.md)) |
| [atolye-exhibit-harness.md](./atolye-exhibit-harness.md) | The atölye harness (`apps/web/src/lab/atolye/`): the typed prop-knobs primitive, the `Exhibit`/`defineExhibit` contract, the headless registry, how `ExhibitStage`/`useKnobs`/`PropKnobs` wire a knob change to a prop re-render | Adding an atölye exhibit or building against the harness seam (epic #2473) |
| [component-metadata-jsdoc.md](./component-metadata-jsdoc.md) | The per-component metadata JSDoc convention on `ui/` primitives (descriptive-only): the tag set (`@component`/`@whenToUse`/`@slot`/`@agent`, prop-level JSDoc), the descriptive/normative firewall, TS-compiler-API extractability | Annotating a `ui/` primitive with metadata, or building the doc extractor ([ADR 0194](../.decisions/0194-design-law-jsdoc-firewall.md)) |

## Index — frontend routing

The SPA's route tree (`apps/web/src/App.tsx`) and the visibility classes a route can take.

| Doc | Topic | Read when |
|---|---|---|
| [frontend-routing.md](./frontend-routing.md) | The react-router `<Routes>`/`<Route>` tree (one shared `<Layout />`, pages in `apps/web/src/pages/`); the two visibility classes (public vs dark flag-gated); the `/lab/*` PUBLIC-prototype convention + graduate-or-cull lifecycle | Adding a route, mounting a prototype under `/lab/*`, or deciding a route's production visibility |

## Index — alchemy infra layer

The infra layer beneath the domain and fate layers. phoenix runs on [alchemy-effect](https://github.com/usirin/alchemy-effect) — one Effect program for infra + runtime, in place of `wrangler.jsonc`, a Hono entry, manual binding access, and hand-written DO classes. Read [alchemy-overview.md](./alchemy-overview.md) first.

| Doc | Topic | Read when |
|---|---|---|
| [alchemy-overview.md](./alchemy-overview.md) | One program = infra + runtime; the two phases; how the layers stack (domain/fate over alchemy); reading order | First — the mental model |
| [alchemy-worker.md](./alchemy-worker.md) | The worker class Tag + `.make(props, body)` Layer, init vs runtime phase, props, providing binding Layers | Defining/editing the worker entry |
| [alchemy-bindings.md](./alchemy-bindings.md) | Capability services (`Cloudflare.D1.QueryDatabase(...)`) = deploy-bind + runtime-client; `yield*` DO vs capability call; the `…Binding`-layer convention | Reaching a Cloudflare resource |
| [alchemy-http-router.md](./alchemy-http-router.md) | `HttpApiBuilder` for typed JSON + imperative `HttpRouter` for raw-Request/SSE; `toHttpEffect`; assets/worker-first | Adding/moving an HTTP route |
| [worker-http-transport-layout.md](./worker-http-transport-layout.md) | `worker/http/` as a transport surface (not a feature); `app.ts` composition (`makeAppLive`); the `health.ts` typed-JSON group; per-feature route modules merged in | Moving/adding an HTTP route, or the http/ vs features/ split ([ADR 0036](../.decisions/0036-features-as-any-named-app-grouping.md)) |
| [worker-environment-pattern.md](./worker-environment-pattern.md) | Reading worker env through one `effect/Config` surface: each var a `Config` constant, binding names in `ENV_BINDINGS`; never raw `Cloudflare.WorkerEnvironment`, never cast | Reading `ENVIRONMENT` (or any binding) in worker code ([ADR 0031](../.decisions/0031-local-first-dev-state.md)) |
| [cloudflare-deploy-time-iac.md](./cloudflare-deploy-time-iac.md) | Reaching deploy-only CF resources (`Stage`, Custom Domain, email subdomain): the `ALCHEMY_PHASE === "plan"` gate, production-only IaC, the retry-tolerant teardown DELETE | Deriving a worker prop from `Stage`, or provisioning a domain/cert/email subdomain ([ADR 0101](../.decisions/0101-cloudflare-email-service-transactional-email.md)) |
| [alchemy-durable-objects.md](./alchemy-durable-objects.md) | The unified `LiveDO` — `.make()`, role dispatch via `resolveRole`, the beta.59 self-namespace yield (ADR 0124), KV storage, per-subscriber frame.id, the reap alarm | Working on the live DO ([ADR 0037](../.decisions/0037-unified-void-aligned-live-do.md)) |
| [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md) | `Cloudflare.D1.QueryDatabase` → the `Database` seam → `createDrizzle` (RQB v2 `defineRelations`); `Drizzle` as a worker-level singleton sharing one handle with better-auth; migrations hand-authored flat ([ADR 0108](../.decisions/0108-hand-authored-flat-d1-migrations.md)) | Wiring the DB or migrations |
| [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) | `alchemy.run.ts` + `Alchemy.Stack`, resource declarations, `wrangler.jsonc`→alchemy map, dev/deploy, stage lifecycle & state discipline (destroy-before-reset) | Declaring resources, deploying, or touching a stage/state store |
| [alchemy-ci-cd.md](./alchemy-ci-cd.md) | The deploy workflow (push→prod, PR→preview, close→destroy); `infra/ci-credentials/github.ts` self-provisioning a scoped CI token; the pnpm `exec` flag-forwarding gotcha | Wiring or debugging CI deploys, rotating the CI token |
| [alchemy-test-harness.md](./alchemy-test-harness.md) | `Test.make` deploying the real stack to remote Cloudflare — shared-stage default (`sharedStack()` + `nsToken`, [ADR 0104](../.decisions/0104-two-mode-integration-test-tier.md)), per-file isolated stages; `awaitEdgeReady` ([ADR 0127](../.decisions/0127-unified-edge-readiness-primitive.md)); black-box HTTP + D1 REST seam; best-effort teardown | Writing integration tests against the deployed worker ([ADR 0082](../.decisions/0082-two-test-tiers-unit-integration.md)) |
| [ci-legible-integration-tests.md](./ci-legible-integration-tests.md) | The fail-fast-and-name-the-cause discipline for the CI integration tier: assert the decisive precondition before any streaming wait, cap every wait with a distinct message, no worker-side `console` probes | Writing (or reviewing) any integration test — before you `await` on SSE/delivery ([ADR 0154](../.decisions/0154-integration-tier-is-ci-only.md) / [0082](../.decisions/0082-two-test-tiers-unit-integration.md)) |
| [better-auth-with-plugins-on-d1.md](./better-auth-with-plugins-on-d1.md) | Forked `CloudflareD1` Layer on phoenix's existing D1; `Random` for the session secret; threading the resolved `Auth` without leaking `RuntimeContext` | Adding/editing better-auth plugins or wiring an auth consumer |
| [feature-flags.md](./feature-flags.md) | **The how-to-use hub**: declare a flag (`FlagshipFlag` IaC), read server-side (`Flags.getBoolean`, safe-default), read in React (`useFlag`/`FlagGate`), flip + kill-switch, the default-=-safe-state invariant | First stop for using a flag — declaring, reading, or flipping one ([ADR 0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md)) |
| [feature-flags-targeting.md](./feature-flags-targeting.md) | The `FlagsContext`→`FlagshipEvaluationContext` mapping (`userId`→`targetingKey`, role flattening); the operator/grouping taxonomy; percentage rollout; the IaC-vs-dashboard split | Adding a targeting/rollout flag, or extending the eval context ([ADR 0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md)) |
| [feature-flags-schema-lifecycle.md](./feature-flags-schema-lifecycle.md) | The flag-key naming grammar (`<product>-<feature>-<purpose>`); value-type discipline; the default-=-safe-state invariant; the flag lifecycle (born-off → flipped → retired); IaC vs dashboard | Naming a flag, deciding its value type, or planning its lifecycle ([ADR 0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md)) |
| [feature-flags-agent-workflow.md](./feature-flags-agent-workflow.md) | The ship-behind-flag → release-queue (`status:awaiting-release`) → validate → flip → kill → retire workflow; deploy=agents/release=humans; the runtime-gate vs merge-time boundary; checking a flag's live prod serving state (`cf-utils flag get`) | Shipping a feature dark behind a flag, draining the release queue, or verifying a flag is live in prod ([ADRs 0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md) / [0083](../.decisions/0083-agents-deploy-humans-release.md) / [0053](../.decisions/0053-control-plane-boundary.md)) |

## Lint tooling

| Doc | Topic | Read when |
|---|---|---|
| [biome-custom-gritql-rules.md](./biome-custom-gritql-rules.md) | Authoring a project-specific lint rule as a biome GritQL plugin (`.grit` in `biome-plugins/`, registered in `biome.jsonc`); the shipped `no-type-assertions` rule; per-line `// biome-ignore lint/plugin:` suppression | Adding/editing a custom biome lint rule, or suppressing one |
| [unconditional-test-assertions.md](./unconditional-test-assertions.md) | Why a test whose only `expect(...)` is nested in an `if` is a silent pass, and how to fix it; the `no-expect-in-if` GritQL gate (test-scoped, `warn`); why it spares the narrow-after-assert `Result`/`Option` idiom | Writing a test that branches around an `expect`, or hitting the `no-expect-in-if` gate |
| [serial-read-baseline.md](./serial-read-baseline.md) | Why `Effect.all`/`forEach`/`validate` must pass an explicit `concurrency` (they default to sequential) — the `no-implicit-effect-concurrency` GritQL rule; the fix + `// biome-ignore` escape hatch | Writing an `Effect.all`/`forEach`/`validate`, or hit by the concurrency lint warning ([#3190](https://github.com/kamp-us/phoenix/issues/3190)) |
| [erasable-typescript-syntax.md](./erasable-typescript-syntax.md) | Why worker/stack code must use only **erasable** TS syntax (no parameter-properties / `enum` / runtime `namespace`): `alchemy deploy`'s strip-only loader; the root `erasableSyntaxOnly: true` guard | Writing worker/`alchemy.run.ts` code, or hitting the strip-only deploy error ([#916](https://github.com/kamp-us/phoenix/issues/916)) |

## CI / pipeline

| Doc | Topic | Read when |
|---|---|---|
| [golden-real-payload-fixtures.md](./golden-real-payload-fixtures.md) | The blocking golden-fixture seam for hook/harness handlers ([ADR 0180](../.decisions/0180-capture-real-runtime-artifact-before-coding.md)): capture the real runtime payload, commit `__fixtures__/<handler>.payload.golden.json`, load via `golden-fixture.ts`, wire blocking with the right `packages` path filter | Building/testing a hook or harness-event handler whose contract the runtime emits |
| [crabbox-run-evidence.md](./crabbox-run-evidence.md) | The produce → adapt → store → consume run-evidence flow: the `run-evidence.yml` producer, the `@kampus/crabbox-manifest` adapter (ADR 0054 §2), the `run-evidence` GH-artifact transport (ADR 0056), the `ship-it`/`review-code` consumers | Touching the run-evidence producer/adapter/manifest, or a gate that reads the bundle |
| [effect-process-cli-shell.md](./effect-process-cli-shell.md) | Shelling an external CLI (`gh`, `git`) as an Effect `Context.Service` over `effect/unstable/process`: `ChildProcess.make` + concurrent read, the `ChildProcessSpawner` layer, folding the spawn error, Schema-decode at the boundary, the spawner-substitution test seam | Writing/editing a pipeline tool that shells `gh`/`git` |
| [mcp-server-effect.md](./mcp-server-effect.md) | Building an MCP server on effect's `effect/unstable/ai` `McpServer` (the crew channel substrate, [`@kampus/pipeline-crew-mcp`](../packages/pipeline-crew-mcp)): the transports, toolkit/resource/prompt registration, the pin-surface caveat forcing the additive `pnpm` patch (ADR 0038), the in-memory test harness | Building or testing an MCP server on the `effect/unstable/ai` surface, or the `claude/channel` patch ([#3053](https://github.com/kamp-us/phoenix/issues/3053)) |
| [mcp-channel-contract.md](./mcp-channel-contract.md) | The MCP channel wire contract (`edge/`): the `claude/channel` capability + `notifications/claude/channel`, the wire constants, the last-mile-only constraint (channels are 1:1-per-session, no pub-sub/persistence/acks — `tracker/`+`peer/` carry cross-session semantics). A child of [mcp-server-effect.md](./mcp-server-effect.md) | Reasoning about or building the `claude/channel` delivery path ([#3061](https://github.com/kamp-us/phoenix/issues/3061)) |
| [effect-rpc.md](./effect-rpc.md) | Typed RPC on `effect/unstable/rpc` (the crew peer message plane, [`@kampus/pipeline-crew-mcp`](../packages/pipeline-crew-mcp)): the three pieces — one `RpcGroup` catalog, a server (`RpcServer.layer` over a unix socket), a client (`RpcClient.make`); the transport-pluggability seam (no `*-protocol` package) | Defining an RPC catalog or standing up an RPC server/client over a socket transport ([#3058](https://github.com/kamp-us/phoenix/issues/3058)) |
| [dependency-patch-behavior-pins.md](./dependency-patch-behavior-pins.md) | The patch behavior-pin discipline `patch-guard` enforces: each `pnpm patch` ([ADR 0038](../.decisions/0038-dependency-patches-local-only.md)) carries pnpm's version-keyed loud-fail + a behavior pin (`// @patch-pin: <name>@<version>`); the guard fails closed on an unpinned/stale pin or zero scope | Adding/bumping/removing a `pnpm patch`, writing a behavior pin, or touching the `patch-guard` tool |
| [worktree-agent-constraints.md](./worktree-agent-constraints.md) | The `.claude/worktrees/<id>/` hazards for an `isolation:worktree` agent: the self-mod classifier's `.claude/`-substring denial + the Bash-heredoc workaround; the Bash-cwd-reset pin (`worktree-guard`) | Doing file work as a worktree subagent, or hitting a self-mod denial on a non-control-plane file |
| [plugin-sessionstart-install.md](./plugin-sessionstart-install.md) | The `kampus-pipeline` plugin's portable guard surface: the `SessionStart` install into `${CLAUDE_PLUGIN_DATA}` (idempotent, always exit 0), the `${CLAUDE_PLUGIN_ROOT}` vs `${CLAUDE_PLUGIN_DATA}` split, the fail-open `guard.sh` dispatch wrapper (ADR 0103) | Touching the plugin's `hooks.json` / install / guard wiring |
| [right-sized-fan-out-trivial-tier.md](./right-sized-fan-out-trivial-tier.md) | The trivial-diff tier (shipped-but-dormant): a trivially-classified PR routes to `review-trivial` instead of full fan-out — the deterministic classifier (`pipeline-cli trivial-diff`), the fail-closed `review-trivial` gate, the `selectReviewTier` branch; off by default pending measurement | Understanding or touching the trivial-diff tier; how a PR is routed for review ([ADR 0120](../.decisions/0120-stage-right-sizing-trivial-diff-lighter-gate.md) / [0070](../.decisions/0070-investigation-trivial-fix-collapse.md) / [0112](../.decisions/0112-token-measurement-no-quality-compromise-methodology.md)) |
| [workflow-driving-auto-resume.md](./workflow-driving-auto-resume.md) | The capped, classified auto-resume discipline for the Workflow-driving session: on a `status: failed` event, `pipeline-cli resume-policy decide` resumes only a TRANSIENT crash under the K=2 per-run cap; LOGIC surfaces immediately; whole-process death out of scope | Driving dynamic Workflows / handling a crashed run ([ADR 0130](../.decisions/0130-auto-resume-main-loop-discipline.md), epic [#1751](https://github.com/kamp-us/phoenix/issues/1751)) |
| [plan-format-enrichment-proposals.md](./plan-format-enrichment-proposals.md) | **Proposal doc (not an active convention)** — three salvaged additions to the sub-issue task format from the closed `writing-plans` import survey (#3371): per-step verify commands, a first-class `### Out of scope` boundary, and STOP conditions; where each fits today's format + the §CP landing cost | Weighing whether to enrich the plan format with verify commands / scope boundaries / stop tripwires, or reviving the #3371 salvage |

## fate protocol conventions

- **fate is pure transport; Effect services are the domain.** Reads and writes go through service methods — fate never queries the database, and `createDrizzleSourceAdapter` is never used.
- **No `runtime.runPromise*` outside `@kampus/fate-effect`'s compile step.** Handlers and source loaders are `Effect.fn` generators paired with pure-data definitions (`Fate.query`/`Fate.list`/`Fate.mutation`/`Fate.source`); the package's single Effect→Promise conversion lives in `Executor.ts`, oracle-baseline-only ([fate-effect-interpreter.md](./fate-effect-interpreter.md)).
- **Validation lives in services** (ADR 0013). The definition's Schema `input`/`args` is thin shape-coercion at the trust boundary only (a rejection encodes as `VALIDATION_ERROR`).
- **The server is the single source of truth for types.** The client imports `Entity<>` types; codegen emits the client wiring. No schema artifact.
- **One batched request per screen.** A screen root declares its whole view tree in one `useRequest`; child `useView` calls read from cache — no waterfalls. Mutations are declarative (`optimistic`, `insert`/`delete`); no imperative cache updaters.
- **Live views run over SSE through the unified `LiveDO` Durable Object.** The built-in in-memory bus can't fan out across Worker isolates, so a publish-only `LiveEventBus` fires the topic-role `publish` RPC; a `topic:` instance owns the subscriber registry and fans out to `connection:` instances, which hold the SSE streams. One class plays both roles, keyed by instance name (ADR 0037, reunifying the 0025 split). This is the one Durable Object in phoenix.

## Conventions across these docs

- **All patterns are effect v4** (`effect@4.0.0-beta.*`). Earlier `@effect/sql-drizzle`-style examples don't apply directly.
- **Drizzle is the query builder.** Exposed as `DrizzleAccess` methods you destructure (`const {run, batch} = yield* Drizzle`) — feature code never writes `Effect.tryPromise` directly.
- **House rule: `Effect.tryPromise` always uses object notation** with an explicit `catch` producing a tagged error. The single-arg form is treated like `Effect.promise`.
- **Service methods always use `Effect.fn("Service.method")(function*(args) {...})`** — automatic spans, automatic stack frames. Reserve `Effect.fnUntraced` for genuinely hot internal helpers.
- **One service per feature folder.** Reads + writes coexist.
- **Testing strategy:** **two tiers** ([ADR 0082](../.decisions/0082-two-test-tiers-unit-integration.md)). `unit` — pure logic and Effect control flow with **no database**, substituting the `Drizzle` seam directly (`*.unit.test.ts`, offline in the `unit` Vitest project under `@effect/vitest`); `integration` — real behavior against **real remote D1** and the deployed worker (black-box HTTP, [alchemy-test-harness.md](./alchemy-test-harness.md)). `node:sqlite` / `makeSqliteTestDb` is **banned** as a backing. Litmus: *could this be wrong even if the DB behaved perfectly?* yes → `unit`, only-wrong-if-real-D1-differs → `integration`. See [effect-testing.md](./effect-testing.md).

## When to add a new pattern doc here

Add a doc when:

- A pattern is used in **2+ places** and future agents will need to know it.
- The pattern is **non-obvious from reading the codebase** — it codifies a design choice rather than describing existing structure.
- A future agent would otherwise **invent a worse version** if they didn't know about it.

Don't add a doc for:

- One-off implementation details.
- Things that are obvious from reading the code.
- Migration steps (those go in vault grill/RFC artifacts, not here).
