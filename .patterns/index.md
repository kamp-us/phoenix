# Phoenix patterns

This is the shared task-to-pattern map for apps, packages, infrastructure and agent
tooling. Choose the section and Read when rows that match the change. A row routes
you to its owning guide; it does not copy that guide’s rules. Read the owner’s local
`AGENTS.md` and representative code/tests alongside the guide.

## Effect code

Shared Effect concepts apply across consumers. Match API examples to the owning manifest and resolved dependency; worker-specific rows say `apps/web`.

| Pattern | Topic / scope | Read when |
|---|---|---|
| [effect-context-service.md](./effect-context-service.md) | Effect consumers | Defining a new service or layer |
| [feature-services.md](./feature-services.md) | apps/web worker | Adding a feature service, writing service methods |
| [effect-layer-composition.md](./effect-layer-composition.md) | apps/web worker | Wiring services into the worker, adding a feature Layer, guarding one member of an existing service |
| [effect-errors.md](./effect-errors.md) | Web wire errors | Designing a new error or feature's error set |
| [error-copy-law.md](./error-copy-law.md) | apps/web | Authoring a user-facing error `message`, or a `WIRE_MESSAGES` entry |
| [backend-exception-translation.md](./backend-exception-translation.md) | Tuval backends | Catching a dependency's exception in an `apps/tuval` backend adapter |
| [effect-error-operators.md](./effect-error-operators.md) | Effect consumers | Catching, recovering, or inspecting failures at a boundary |
| [effect-fn-tracing.md](./effect-fn-tracing.md) | Effect consumers | Writing or naming a service method |
| [effect-platform-access.md](./effect-platform-access.md) | Effect consumers | Reading/writing files, building paths, or minting ids in Effect code ([#3461](https://github.com/kamp-us/phoenix/issues/3461)), or migrating a directory walk ([#3922](https://github.com/kamp-us/phoenix/issues/3922)) |
| [effect-testing.md](./effect-testing.md) | Web test setup; shared Effect coordination | Choosing a web test tier or storage substitute, or coordinating fibers and bounding waits in Effect tests |
| [effect-schema-validation.md](./effect-schema-validation.md) | Effect consumers | Validating untyped input (`HttpApi` payloads, external responses, persisted JSON) |
| [effect-sse-externally-driven.md](./effect-sse-externally-driven.md) | Web SSE | Building an SSE response written to from another component (e.g. the `LiveDO` topic `deliver` RPC) |
| [effect-socket-session.md](./effect-socket-session.md) | Effect consumers | Writing a per-connection socket handler, or a socket that opens and then goes silent |
| [authz-capability-as-effect.md](./authz-capability-as-effect.md) | Web / authz package | Gating a privileged op, adding a capability/right/relation, or touching `packages/authz` ([ADR 0107](../.decisions/0107-capability-authz-framework.md)) |
| [caylak-content-containment.md](./caylak-content-containment.md) | apps/web | Adding any çaylak-reachable write path — decide if it needs the sandbox seam |
| [telemetry.md](./telemetry.md) | apps/web | Adding/instrumenting product-usage telemetry, or querying it ([ADR 0153](../.decisions/0153-analytics-engine-telemetry-seam.md)) |
| [sentry.md](./sentry.md) | apps/web | Wiring or changing Sentry capture on either tier ([ADR 0118](../.decisions/0118-error-crash-monitoring-sentry-saas.md)) |

## Web and fate protocol

For `apps/web/worker` and `packages/fate-effect`. Read interpreter internals when changing the interpreter, not for every feature operation.

| Pattern | Topic / scope | Read when |
|---|---|---|
| [fate-effect-wire-errors.md](./fate-effect-wire-errors.md) | Web / fate-effect | Declaring a domain error |
| [fate-effect-data-views.md](./fate-effect-data-views.md) | Web / fate-effect | Declaring an entity view |
| [fate-effect-sources.md](./fate-effect-sources.md) | Web / fate-effect | Declaring a source / wiring a view's reads to a service |
| [fate-effect-operations.md](./fate-effect-operations.md) | Web / fate-effect | Declaring a query/list/mutation, or writing a mutation |
| [fate-effect-server.md](./fate-effect-server.md) | Web / fate-effect | Composing the fate server / discharging domain layers |
| [fate-effect-compiler.md](./fate-effect-compiler.md) | Web / fate-effect | Touching `Executor.ts`/`Codegen.ts`/`Compiled.ts`/`RequestContext.ts`, the oracle baseline, or `schema.ts` codegen |
| [fate-effect-interpreter.md](./fate-effect-interpreter.md) | Web / fate-effect | Touching `Protocol.ts`/`Interpreter.ts`/`Walk.ts`/`Connection.ts`, or the oracle corpus |
| [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) | Web / fate-effect | Wiring fate in `apps/web/worker`; the fate↔domain seam |
| [fate-data-views.md](./fate-data-views.md) | Web / fate-effect | Modeling an entity type |
| [fate-connections.md](./fate-connections.md) | Web / fate-effect | Writing a paginated list |
| [per-feature-fate-aggregators.md](./per-feature-fate-aggregators.md) | Web / fate-effect | Adding/moving a fate fragment, or scaffolding a feature module ([ADR 0036](../.decisions/0036-features-as-any-named-app-grouping.md)) |

## Web fate client

For `apps/web/src` consumers of fate. Client setup is needed when changing the app shell or provider wiring.

| Pattern | Topic / scope | Read when |
|---|---|---|
| [fate-client-setup.md](./fate-client-setup.md) | apps/web | Wiring the client / app shell |
| [fate-views-and-requests.md](./fate-views-and-requests.md) | apps/web | Reading data in a component |
| [fate-mutations-client.md](./fate-mutations-client.md) | apps/web | Writing data from the UI |
| [fate-hydration.md](./fate-hydration.md) | apps/web | Persisting/restoring the client cache ([#2316](https://github.com/kamp-us/phoenix/issues/2316)) or an SSR-style boot-time cache transfer |
| [fate-live-views.md](./fate-live-views.md) | apps/web | Looking up the live hooks, the publish API, or how the `LiveDO` transport works |
| [fate-live-publishing.md](./fate-live-publishing.md) | apps/web | Writing or changing a mutation over a live-subscribed entity (`Post`/`Comment`/`Definition`) |
| [fate-live-consistency.md](./fate-live-consistency.md) | apps/web | Reasoning about live staleness, or the publish invariant's *why* |
| [fate-async-react.md](./fate-async-react.md) | apps/web | Building a screen's loading/pending path — before a spinner, a hard-swapping fallback, or a `defer` on a nested connection (#2161) |
| [fate-page-queries.md](./fate-page-queries.md) | apps/web | Composing a page's data — how many fate requests, where a nested connection rides, or whether to add a second query |

## Shared design and components

For rendered UI in both apps and `packages/design`. Read the root [design manifest](../design-system-manifest.md) before generating UI. Rows naming atölye, moderation or a web component apply to those consumers.

| Pattern | Topic / scope | Read when |
|---|---|---|
| [manti-accessibility.md](./manti-accessibility.md) | Shared UI | Adding or labelling an interactive control, or reaching for an `aria-label` |
| [decorative-generated-content.md](./decorative-generated-content.md) | Shared UI | Writing any `content:` declaration, or reviewing a CSS glyph on a named element ([ADR 0166](../.decisions/0166-canonical-icon-idiom.md) §8) |
| [property-based-a11y.md](./property-based-a11y.md) | Shared UI | Adding an `@kampus/design` primitive, promoting an a11y warning, or extending the harness ([ADR 0162](../.decisions/0162-four-pillars-design-law.md)) |
| [design-sync-authority.md](./design-sync-authority.md) | Shared UI | Before any design round-trip, or when changing an entry-row primitive's behavior vs its paint ([ADR 0162](../.decisions/0162-four-pillars-design-law.md)) |
| [moderation-admin-shared-components.md](./moderation-admin-shared-components.md) | apps/web | Building or extending any moderation/admin UI — before forking a user-list / action-row ([ADR 0147](../.decisions/0147-shared-moderation-admin-component-layer.md) / [0138](../.decisions/0138-divan-actor-centric-spine.md)) |
| [reachability-journey-e2e.md](./reachability-journey-e2e.md) | apps/web | Authoring a reachability/journey e2e for a dark-ship flag, or a zero-CLS first-paint proof ([ADR 0173](../.decisions/0173-vertical-completeness-gate.md) / [0179](../.decisions/0179-edge-resolved-shell-state-boot-contract.md)) |
| [atolye-exhibit-harness.md](./atolye-exhibit-harness.md) | apps/web | Adding an atölye exhibit or building against the harness seam (epic #2473) |
| [command-palette.md](./command-palette.md) | Shared UI | Using or changing `CommandPalette`, or folding a search surface into the `⌘K` contract (ADR 0186) |
| [agent-chat-pi-rpc.md](./agent-chat-pi-rpc.md) | Shared UI | Adding a Pi-backed agent-chat capability, or changing the local-only broker seam |
| [agent-chat-compound-parts.md](./agent-chat-compound-parts.md) | Shared UI | Assembling the composer by hand in a host, or adding a part to it (epic [#8668](https://github.com/kamp-us/phoenix/issues/8668)) |
| [component-metadata-jsdoc.md](./component-metadata-jsdoc.md) | Shared UI | Annotating an `@kampus/design` primitive with metadata, or building the doc extractor ([ADR 0194](../.decisions/0194-design-law-jsdoc-firewall.md)) |
| [markdown-async-block.md](./markdown-async-block.md) | Shared UI | Adding a second async block to `Markdown`, or handing design tokens to a library that paints its own colours ([#8128](https://github.com/kamp-us/phoenix/issues/8128)) |
| [i18n-catalog.md](./i18n-catalog.md) | apps/web | Adding user-facing copy, migrating a surface to `useT`, or adding a catalog key ([ADR 0347](../.decisions/0347-web-copy-behind-i18n-catalog.md)) |
| [zag-machine-interaction-tests.md](./zag-machine-interaction-tests.md) | Shared UI | Writing or reviewing any `*.test.tsx` that drives a Manti/Zag primitive through an interaction ([#6495](https://github.com/kamp-us/phoenix/issues/6495)) |

## Web routing and copy

For `apps/web/src`. Tuval has its own shell and English interface copy.

| Pattern | Topic / scope | Read when |
|---|---|---|
| [frontend-routing.md](./frontend-routing.md) | apps/web | Adding a route, mounting a prototype under `/lab/*`, or deciding a route's production visibility |
| [flag-dark-page-gate.md](./flag-dark-page-gate.md) | apps/web | Gating a whole page behind a flag, or touching an existing gated page's gate ([#6459](https://github.com/kamp-us/phoenix/issues/6459)) |

## Web and standalone infrastructure

For deployed apps and `infra/` stacks. Tuval has no alchemy stack.

| Pattern | Topic / scope | Read when |
|---|---|---|
| [alchemy-overview.md](./alchemy-overview.md) | Web / infra | Learning how this repository declares and hosts its Cloudflare stacks |
| [alchemy-worker.md](./alchemy-worker.md) | Web / infra | Defining/editing the worker entry |
| [alchemy-bindings.md](./alchemy-bindings.md) | Web / infra | Reaching a Cloudflare resource |
| [alchemy-http-router.md](./alchemy-http-router.md) | Web / infra | Adding/moving an HTTP route |
| [worker-http-transport-layout.md](./worker-http-transport-layout.md) | apps/web worker | Moving/adding an HTTP route, or the http/ vs features/ split ([ADR 0036](../.decisions/0036-features-as-any-named-app-grouping.md)) |
| [worker-environment-pattern.md](./worker-environment-pattern.md) | apps/web worker | Reading `ENVIRONMENT` (or any binding) in worker code ([ADR 0031](../.decisions/0031-local-first-dev-state.md)) |
| [cloudflare-deploy-time-iac.md](./cloudflare-deploy-time-iac.md) | Web / infra | Deriving a worker prop from `Stage`, or provisioning a domain/cert/email subdomain ([ADR 0101](../.decisions/0101-cloudflare-email-service-transactional-email.md)) |
| [alchemy-durable-objects.md](./alchemy-durable-objects.md) | Web / infra | Working on the live DO ([ADR 0037](../.decisions/0037-unified-void-aligned-live-do.md)) |
| [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md) | Web / infra | Wiring the DB or migrations |
| [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) | Web / infra | Declaring resources, deploying, or touching a stage/state store |
| [alchemy-ci-cd.md](./alchemy-ci-cd.md) | Web / infra | Wiring or debugging CI deploys, rotating the CI token |
| [alchemy-test-harness.md](./alchemy-test-harness.md) | Web integration tests | Writing integration tests against the deployed worker ([ADR 0082](../.decisions/0082-two-test-tiers-unit-integration.md)) |
| [ci-legible-integration-tests.md](./ci-legible-integration-tests.md) | Web integration tests | Writing or reviewing a web integration test that waits on SSE or delivery |
| [better-auth-with-plugins-on-d1.md](./better-auth-with-plugins-on-d1.md) | apps/web | Adding/editing better-auth plugins or wiring an auth consumer |
| [feature-flags.md](./feature-flags.md) | apps/web | First stop for using a flag — declaring, reading, or flipping one ([ADR 0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md)) |
| [feature-flags-targeting.md](./feature-flags-targeting.md) | apps/web | Adding a targeting/rollout flag, or extending the eval context ([ADR 0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md)) |
| [feature-flags-schema-lifecycle.md](./feature-flags-schema-lifecycle.md) | apps/web | Naming a flag, deciding its value type, or planning its lifecycle ([ADR 0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md)) |
| [feature-flags-agent-workflow.md](./feature-flags-agent-workflow.md) | apps/web | Shipping a feature dark behind a flag, draining the release queue, or verifying a flag is live in prod ([ADRs 0081](../.decisions/0081-feature-flag-substrate-cloudflare-flagship.md) / [0083](../.decisions/0083-agents-deploy-humans-release.md) / [0053](../.decisions/0053-control-plane-boundary.md)) |

## Repository lint and type checks

Select the rule or check the change touches.

| Pattern | Topic / scope | Read when |
|---|---|---|
| [biome-custom-gritql-rules.md](./biome-custom-gritql-rules.md) | Repository | Adding/editing a custom biome lint rule, or suppressing one |
| [unconditional-test-assertions.md](./unconditional-test-assertions.md) | Repository | Writing a test that branches around an `expect`, hitting the `no-expect-in-if` gate, or asserting a claim about types |
| [serial-read-baseline.md](./serial-read-baseline.md) | Repository | Writing an `Effect.all`/`forEach`/`validate`, or hit by the concurrency lint warning ([#3190](https://github.com/kamp-us/phoenix/issues/3190)) |
| [typecheck-two-step.md](./typecheck-two-step.md) | Repository | Adding a workspace package, changing a `typecheck` script, or wondering where Effect diagnostics come from |
| [erasable-typescript-syntax.md](./erasable-typescript-syntax.md) | Repository | Writing worker/`alchemy.run.ts` code, or hitting the strip-only deploy error ([#916](https://github.com/kamp-us/phoenix/issues/916)) |

## CLI, workflows and agent tooling

For operational packages, workflow steps, hooks and Fabrika. Read the owning package or plugin contract as well as the applicable pattern.

| Pattern | Topic / scope | Read when |
|---|---|---|
| [golden-real-payload-fixtures.md](./golden-real-payload-fixtures.md) | Node tooling / CI | Building/testing a hook or harness-event handler whose contract the runtime emits |
| [subprocess-test-budget.md](./subprocess-test-budget.md) | Node tooling / CI | Writing a CLI test that spawns a real bin, hook or git process |
| [skill-derived-guards.md](./skill-derived-guards.md) | Node tooling / CI | Writing a test or guard over logic that lives in a skill's fenced block or step list ([#4054](https://github.com/kamp-us/phoenix/issues/4054)) |
| [skill-script-shell-shape.md](./skill-script-shell-shape.md) | Repository shell | Writing or editing any repo shell — a workflow step, a hook body, a new script ([#4479](https://github.com/kamp-us/phoenix/issues/4479)) |
| [skill-script-io-contract.md](./skill-script-io-contract.md) | Repository shell | Writing shell a caller consumes, or wiring that caller ([#4510](https://github.com/kamp-us/phoenix/issues/4510)) |
| [liveness-probe-outcomes.md](./liveness-probe-outcomes.md) | Node tooling / CI | Writing or reviewing a probe of an external surface's health, or deciding a can't-run polarity ([ADR 0250](../.decisions/0250-fabrika-hook-cannot-run-fails-open.md), [#3411](https://github.com/kamp-us/phoenix/issues/3411)) |
| [crabbox-run-evidence.md](./crabbox-run-evidence.md) | Node tooling / CI | Touching the run-evidence producer/adapter/manifest, or a gate that reads the bundle |
| [effect-process-cli-shell.md](./effect-process-cli-shell.md) | Node tooling / CI | Calling an external CLI from Effect code; Fabrika GitHub calls use its HTTP client |
| [effect-rpc.md](./effect-rpc.md) | Node tooling / CI | Defining an RPC catalog or standing up an RPC server/client over a socket transport ([#3058](https://github.com/kamp-us/phoenix/issues/3058)) |
| [fabrika-config-key-groups.md](./fabrika-config-key-groups.md) | Node tooling / CI | Adding or changing a `.fabrika.jsonc` key, or reading one from a fabrika verb (epic [#5631](https://github.com/kamp-us/phoenix/issues/5631)) |
| [dependency-patch-behavior-pins.md](./dependency-patch-behavior-pins.md) | Node tooling / CI | Adding/bumping/removing a `pnpm patch`, writing a behavior pin, or touching the `patch-guard` tool |
| [worktree-agent-constraints.md](./worktree-agent-constraints.md) | Node tooling / CI | Doing file work as a worktree subagent, or hitting a self-mod denial on a non-control-plane file |
| [release-path.md](./release-path.md) | Node tooling / CI | Touching `release-please.yml` / `publish.yml` / the release-please config or manifest, publishing a new `@kampus/*` package, or diagnosing a red publish run ([#4805](https://github.com/kamp-us/phoenix/issues/4805)) |
| [plan-format-enrichment-proposals.md](./plan-format-enrichment-proposals.md) | Node tooling / CI | Evaluating the proposed plan-format additions; this is not an active convention |
| [repo-wide-gates-run-on-main.md](./repo-wide-gates-run-on-main.md) | Node tooling / CI | Adding a CI workflow, or changing an existing one's triggers ([#5085](https://github.com/kamp-us/phoenix/issues/5085)) |
| [verb-output-pin-surfaces.md](./verb-output-pin-surfaces.md) | Node tooling / CI | Changing what a fabrika verb prints, or checking whether a documented output grammar is still true |
| [package-readme-shape.md](./package-readme-shape.md) | Workspace packages | Writing or restructuring a `packages/*/README.md` |
| [fabrika-hook-records.md](./fabrika-hook-records.md) | Node tooling / CI | Asking why a fabrika hook is (or is not) declared here, or what guarantee a retired v1 hook took with it |
| [fabrika-verb-shape.md](./fabrika-verb-shape.md) | Node tooling / CI | Adding or changing a fabrika verb, or writing a test that substitutes its services |
| [pi-project-package-install.md](./pi-project-package-install.md) | Node tooling / CI | Editing `.pi/settings.json`, or diagnosing a pi child that failed during its project-package refresh |

## Tuval

For `apps/tuval`. Its local integration tests use real sessions and sockets, not D1; start with the app’s Vitest projects and the existing test for the changed behavior.

| Pattern | Topic / scope | Read when |
|---|---|---|
| [layout-tree-with-resizable-panels.md](./layout-tree-with-resizable-panels.md) | apps/tuval | Touching `apps/tuval/src/shell/ui/LayoutView.tsx`, adding a layout Msg, or bumping the `react-resizable-panels` pin |
| [tuval-shell-assembly.md](./tuval-shell-assembly.md) | apps/tuval | Touching `apps/tuval/src/shell/host/`, `apps/tuval/src/shell/desk/`, `apps/tuval/src/page/`, `apps/tuval/src/bin.ts`, `apps/tuval/tsconfig.browser.json` or a `browser.ts` barrel, the launch/spawn services seam, giving a program row a renderer, or writing a proof that drives the whole app |
| [tuval-spells.md](./tuval-spells.md) | apps/tuval | Writing a spell or a shell command row, wiring the registry, or touching anything under `apps/tuval/src/commands/`, `apps/tuval/src/protocol/` or `apps/tuval/src/shell/commands/` (ADR [0348](../.decisions/0348-tuval-command-framework-spell-registry-versioned-protocol.md)) |
| [strict-wire-schema-projection.md](./strict-wire-schema-projection.md) | apps/tuval | Encoding a dependency's own value onto a wire schema you do not own ([#7567](https://github.com/kamp-us/phoenix/issues/7567)) |
| [owned-wire-vocabulary.md](./owned-wire-vocabulary.md) | apps/tuval | Putting a dependency-owned wire behind a seam before a redesign lands on the other side of its pin ([#8549](https://github.com/kamp-us/phoenix/issues/8549)) |
| [snapshot-authoritative-to-delta-events.md](./snapshot-authoritative-to-delta-events.md) | apps/tuval | Writing a `TuvalAiAgent` layer over a snapshot-pushing agent, or any consumer of an authoritative-whole-state push ([#7602](https://github.com/kamp-us/phoenix/issues/7602)) |
| [promise-sdk-subprocess-layer.md](./promise-sdk-subprocess-layer.md) | apps/tuval | Writing a `TuvalAiAgent` layer over an agent SDK, or any Effect layer over a Promise-shaped dependency that owns a subprocess ([#7621](https://github.com/kamp-us/phoenix/issues/7621)) |
| [agent-layer-phase-contract.md](./agent-layer-phase-contract.md) | apps/tuval | Writing or reviewing a `TuvalAiAgent` layer, or touching anything that carries its events to the core ([#7963](https://github.com/kamp-us/phoenix/issues/7963), [#7897](https://github.com/kamp-us/phoenix/issues/7897), [#8724](https://github.com/kamp-us/phoenix/issues/8724)) |
| [tuval-codex.md](./tuval-codex.md) | apps/tuval | Changing `apps/tuval/src/codex/` |
| [tuval-detached-child-tail.md](./tuval-detached-child-tail.md) | apps/tuval | A Tuval AI-agent layer whose subagent rows come from a child process rather than the session stream |
| [tuval-program-row-effects.md](./tuval-program-row-effects.md) | apps/tuval | Writing a Tuval program row, or giving one a service, a resource or an out-port emission ([#7603](https://github.com/kamp-us/phoenix/issues/7603)) |
| [tuval-history-cursor-join.md](./tuval-history-cursor-join.md) | apps/tuval | A Tuval AI-agent layer whose history read keys rows differently from its live stream, or a `cursor-not-found` on `Load earlier messages` |
| [tuval-authored-programs.md](./tuval-authored-programs.md) | apps/tuval | Writing or reviewing an authored Tuval program, giving one a `resume` or a `configChanged`, or wiring one into a config graph ([#8735](https://github.com/kamp-us/phoenix/issues/8735)) |
| [window-renderer-admission.md](./window-renderer-admission.md) | apps/tuval | Adding a renderer to a page's table, giving a program a window, or touching `apps/tuval/src/page/readable-state.tsx` or `apps/tuval/src/shell/ui/WindowView.tsx` ([#8157](https://github.com/kamp-us/phoenix/issues/8157)) |
| [node-listener-total-boundary.md](./node-listener-total-boundary.md) | apps/tuval | Registering a listener that reads a value an unauthenticated client controls, or touching the Pi server's `upgrade`/`message` boundary ([#7567](https://github.com/kamp-us/phoenix/issues/7567)) |

## Documentation and skills

For instructions, package documentation and reusable patterns.

- Creating or editing AGENTS.md or skills: apply [writing-for-agents](../claude-plugins/fabrika/skills/writing-for-agents/SKILL.md).
- Changing a Fabrika skill, trigger, invocation or contract: read [skill conventions](../claude-plugins/fabrika/docs/skill-conventions.md).
- Choosing or checking a documentation page’s purpose: apply [Diátaxis](../claude-plugins/fabrika/skills/diataxis/SKILL.md).

| Pattern | Topic / scope | Read when |
|---|---|---|
| [Codex lane dispatch](./codex-lane-dispatch.md) | Agent instructions | Dispatching a Codex lane with its assigned instructions and worktree |

## When to add a new pattern doc here

A pattern may enter through either source-backed path:

- **Current shape:** in-repo source and tests demonstrate a reusable shape that future agents need.
  Cite representative paths and state where the shape stops applying; no fixed call-site count is an
  admission prerequisite.
- **Prospective shape:** a cited binding decision names the technology or shape before its first
  implementation, and authoritative dependency source or docs ground every rule. State the intended
  scope without inventing current call sites.

Both paths must also clear the same two bars:

- The pattern is **non-obvious** — it codifies a choice rather than narrating code or generic
  framework guidance.
- A future agent would otherwise **invent a foreseeable worse version**.

Don't add obvious descriptions, generic framework advice, speculative or undocumented conventions,
intuition-only rules, one-off implementation details, or migration steps. Every claim must trace to
the cited current source/tests or authoritative dependency source/docs; if that evidence is unusable,
decline rather than fall back to intuition. Migration steps belong in vault grill/RFC artifacts, not
here.
