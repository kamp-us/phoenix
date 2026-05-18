---
id: 0008
title: Mutations route through workflows; DOs are pure state-keepers
status: superseded
superseded_by: 0009
superseded_date: 2026-05-16
date: 2026-05-10
tags: [architecture, durable-objects, workflows, mutations, agents-sdk]
---

# 0008 — Mutations route through workflows; DOs are pure state-keepers

> **Superseded (2026-05-16):** Workflows-as-mutation-coordinators is retired by [ADR 0009](0009-d1-direct-defer-dos-and-workflows.md). Resolvers write D1 directly; there are no per-mutation workflow classes, no `PHOENIX_MUTATIONS` binding. The cross-DO atomicity problem this ADR solved disappears once there are no DOs. Re-adopt scoped to the cross-aggregate set (e.g. Künye v2 invite-spend) when that pressure returns.

## Context

Supersedes [0007](0007-view-layer-outbox-workflows-d1.md).

[ADR 0007](0007-view-layer-outbox-workflows-d1.md) landed yesterday: producer DO
does its mutation + outbox row inside `transactionSync`, then `this.queue`
dispatches a flush callback that creates a projection workflow. The outbox
closes the durability gap between mutation-committed and event-dispatched.

Designing the Künye achievement system surfaced an architectural wrinkle ADR
0007's pattern doesn't address:
**cross-DO mutations**. Two concrete scenarios — invite-spending (mutates
sponsor's Künye + Pasaport + invitee's Künye + D1) and tree-pruning ban
(walks the invite tree, touching N Künye DOs + Pasaport + D1) — can't be made
atomic in any single DO's `transactionSync`.

Walking the design space (saga / lead-DO / compensating) made clear that the
"right" answer for cross-DO writes is a coordinator workflow. Once that's
accepted, the next observation is: **the coordinator workflow's durability
subsumes the outbox's**. The outbox exists specifically to close the gap
between "mutation in DO committed" and "projection workflow dispatched". If
the workflow is created _before_ the mutation, and the mutation is a
`step.do` inside the workflow, there is no gap — both live inside the same
durable workflow execution. The outbox row, `flushOutbox` callback,
`reconcileOutbox` walk, and `scheduleEvery('reconcile-outbox')` safety net
all stop being load-bearing.

The user has run this pattern in production on another Cloudflare Workers
project (with their brother) and reports:

- Workflow creation latency is not perceptible to end users.
- `step.do` semantics are straightforward; DO RPC inside `step.do` behaves cleanly.
- Workflow classes written by hand (no codegen, no shared base) until a real pattern emerges.
- Local development of Workflows is fine. **CF Queues local dev story still bites.**
- Cost at observed scale is negligible.

The design space comparison ran three coordination shapes (saga / lead-DO /
compensating) across two concrete scenarios (invite-spending, tree-pruning
ban), then compared outbox-in-DO vs. workflow-as-coordinator across ten
dimensions (atomicity, latency, retry semantics, fanout cost, testability,
observability, per-DO boilerplate, local-dev story, vendor coupling, cost
per mutation).

Workflow-as-coordinator wins on multi-DO mutations, fanout to new consumers,
observability (one `workflow_id` per mutation), testability (step-by-step
with mocked DOs), and per-DO boilerplate. Outbox-in-DO wins on raw mutation
latency, cost-per-mutation, and "we have started writing it." Of those, only
latency would bite end users, and production experience says it doesn't.
Migration cost is bounded because nothing has shipped to production yet.

## Decision

### Every mutation is a workflow

Every state-changing operation in Phoenix routes through a Cloudflare
Workflow instance. Workflow classes map **1:1 with GraphQL mutation
fields**, named in `PascalCase + "Workflow"`:

| GraphQL mutation | Workflow class |
|---|---|
| `addPost` | `AddPostWorkflow` |
| `voteOnPost` | `VoteOnPostWorkflow` |
| `editPost` | `EditPostWorkflow` |
| `deletePost` | `DeletePostWorkflow` |
| `addComment` | `AddCommentWorkflow` |
| `voteOnComment` | `VoteOnCommentWorkflow` |
| `editComment` | `EditCommentWorkflow` |
| `deleteComment` | `DeleteCommentWorkflow` |
| `addDefinition` | `AddDefinitionWorkflow` |
| `voteOnDefinition` | `VoteOnDefinitionWorkflow` |
| `inviteUser` | `InviteUserWorkflow` |
| `banUser` | `BanUserWorkflow` |
| `revokeInvitePrivilege` | `RevokeInvitePrivilegeWorkflow` |
| `registerAgent` | `RegisterAgentWorkflow` |

The resolver receives the GraphQL request, validates input, derives a
`workflow_id` from the request (forge ULID), and calls
`env.PHOENIX_MUTATIONS.create({id, params})`. The workflow_id is the
idempotency key for the entire mutation.

### Workflow shape

A mutation workflow is a `WorkflowEntrypoint` with sequential `step.do`
calls. Each step is one of:

1. **DO RPC** — call a `@callable()` method on a sharded product DO
   (`PanoPost`, `SozlukTerm`, `Künye`). The DO enforces invariants and
   updates its own state in `transactionSync`. The DO accepts a step-derived
   event id (or the workflow_id) and treats repeated calls with the same id
   as no-ops.
2. **Pasaport RPC** — calls into the auth-realm singleton for identity-layer
   writes (user creation, status updates, invite-disabled flag).
3. **D1 projection** — `INSERT … ON CONFLICT … DO UPDATE` into a read-view
   table in `PHOENIX_DB`, guarded by `last_event_id < excluded.last_event_id`
   for out-of-order safety (carried forward from ADR 0007).

Example skeleton (illustrative; exact shape per workflow):

```ts
// apps/web/worker/features/pano/workflows/VoteOnPostWorkflow.ts
export class VoteOnPostWorkflow extends WorkflowEntrypoint<Env, VoteOnPostParams> {
  async run(event: WorkflowEvent<VoteOnPostParams>, step: WorkflowStep) {
    const {postId, voterId, value, eventId} = event.payload;

    const {authorId, newScore} = await step.do("apply-vote", async () => {
      return this.env.PANO_POST.get(this.env.PANO_POST.idFromName(postId))
        .applyVote({eventId, voterId, value});
    });

    await step.do("update-author-rep", async () => {
      return this.env.KUNYE.get(this.env.KUNYE.idFromName(authorId))
        .applyVoteDelta({eventId, delta: value === 1 ? +1 : -1});
    });

    await step.do("project-post-summary", async () => {
      return projectPostScore(this.env.PHOENIX_DB, {postId, newScore, eventId});
    });

    await step.do("project-user-vote", async () => {
      return projectUserVote(this.env.PHOENIX_DB, {voterId, postId, value, eventId});
    });
  }
}
```

### DOs become pure state-keepers

Product DOs (`PanoPost`, `SozlukTerm`, `Künye`) own:

- Domain state in their own sqlite, mutated atomically in `transactionSync`.
- Invariant enforcement (rep can't decrement below banned-floor, vote
  toggles are coherent, agent count cap respected, etc.).
- Idempotency: every mutating `@callable()` accepts an event id and stores
  it in a `processed_event(event_id PRIMARY KEY)` table inside the DO's
  sqlite. The mutation method checks-and-inserts the id inside
  `transactionSync`; a duplicate id makes the entire call a no-op.

DOs **do not** own:

- Outbox rows. Drop the `outbox` table from every product DO.
- `flushOutbox`, `reconcileOutbox`, `onStart` reconciliation,
  `scheduleEvery('reconcile-outbox', 300)`. All removed.
- Workflow creation. DOs never call `env.WORKFLOW.create(...)` directly.
- Projection emission. DOs never write to `PHOENIX_DB`. D1 writes happen
  exclusively in workflow `step.do` blocks.

### Wrangler configuration

```jsonc
"workflows": [
  { "name": "phoenix-mutations", "binding": "PHOENIX_MUTATIONS",
    "class_name": "PhoenixMutations" }
]
```

`PhoenixMutations` is a registry/router that delegates to the per-mutation
workflow class based on payload kind. (Or each mutation class gets its own
binding — exact shape decided during execution; the principle is that
the resolver→workflow handoff is by name and the workflow class corresponds
1:1 to the GraphQL mutation.)

The `PHOENIX_PROJECTION` binding from ADR 0007 is **removed**; its work moves
into the per-mutation workflow's projection steps. `PHOENIX_DB` (the D1
binding) is retained — only the producer changes.

### Multi-consumer fanout for v1

When a mutation needs to update multiple read-view tables, multiple DOs, or
trigger downstream side effects (notifications, search index, analytics),
**each is a separate `step.do` in the same mutation workflow.** Adding a
future consumer means appending a `step.do` to the relevant workflow, not
touching the producer DO.

The longer-term destination — `workflow → queue → router`, where the
workflow publishes one event to a queue and N independent router workers
consume it — is captured separately as a future ADR. It is **not**
implemented in v1 because Cloudflare Queues' local-development story is
materially worse than Workflows' at the time of writing.

### Workflow classes written by hand

No codegen. No `BaseMutationWorkflow` abstract class. No shared step
helpers until the same shape appears in three or more workflows. Each
workflow is a small, hand-written class. We invent abstractions only after
the duplication is concrete.

## Consequences

### Refactor sequencing

This is a pre-launch refactor — no live user data, no production migration.

1. **Sozluk.** Per-term `SozlukTerm` DO already exists. Outbox table
   scaffolding and reconciliation skeleton are present; **mutations have
   not been wired yet** (per the in-file comment, "mutation methods land in
   later tasks T4–T6"). Migration: drop the `outbox` table from the schema
   and the `flushOutbox`/`reconcileOutbox`/`scheduleEvery` scaffolding from
   `SozlukTerm` before wiring mutations. Then build mutation paths as
   workflow classes (`AddDefinitionWorkflow`, `VoteOnDefinitionWorkflow`,
   `EditDefinitionWorkflow`, `DeleteDefinitionWorkflow`,
   `RetractDefinitionVoteWorkflow`).
2. **Pano.** Per-post `PanoPost` DO already exists. Mutations have shipped
   on the outbox-in-DO pattern (`addPost`, `voteOnPost`, `retractPostVote`,
   `editPost`, `deletePost`, `addComment`, `voteOnComment`,
   `retractCommentVote`, `editComment`, `deleteComment`). Migration:
   rewrite each as a workflow class with the DO's mutation method
   refactored to pure-state-keeper shape. Drop the `outbox` table,
   `flushOutbox`, `reconcileOutbox`, and the reconcile schedule from
   `PanoPost`. Move projection logic from the projection workflow's
   `case` branches into the per-mutation workflows' steps.
3. **Künye** (new per-user DO from the achievement system) lands natively
   on this pattern — no migration concern.

Sozluk is the cheaper migration (no mutation code to rewrite, only
scaffolding to drop). Pano is the heavier one (~8 mutation methods to
restructure). Both are bounded — the unit of work is "rewrite this
mutation as a workflow class" and each is ~half a day.

### Failure modes

| Failure | Recovery |
|---|---|
| Worker dies mid-workflow | Workflow infrastructure resumes from last completed `step.do`. Idempotency keys make retries safe. |
| DO RPC inside `step.do` throws | `step.do` retries with backoff. After max attempts, workflow instance is marked `failed` in CF Workflows dashboard. |
| DO mutation succeeds but workflow worker dies before `step.do` returns | The DO's `processed_event` row prevents double-application on retry; the step's result is recomputed (or fetched) and the workflow continues. |
| D1 projection write fails | Same `step.do` retry; convergent overwrite guarded by `last_event_id` keeps the read view eventually consistent. |
| Out-of-order projection delivery | `WHERE last_event_id < excluded.last_event_id` makes stale events no-ops. (Carried forward from ADR 0007.) |
| Duplicate workflow created with same id | CF Workflows treats `id` as idempotency key — the second `create` is a no-op. |

### Banned

- **Outbox tables in product DOs.** No DO maintains an `outbox`, `flushOutbox`, `reconcileOutbox`, or `scheduleEvery('reconcile-outbox', ...)`.
- **DOs creating workflows directly.** Producers do not call `env.WORKFLOW.create(...)`. Mutation entry is through the resolver → workflow path.
- **DOs writing to D1.** All D1 writes go through workflow `step.do` blocks. The D1 read view has exactly one writer surface: the per-mutation workflow classes.
- **Mutating GraphQL resolvers that bypass the workflow.** Every resolver that mutates state calls `env.PHOENIX_MUTATIONS.create(...)`. No "small write, skip the workflow" exceptions.
- **Shared base classes / codegen for workflows** until the same shape appears in three or more places.

### Out of scope

- **Multi-consumer fanout via Queues** (workflow → queue → router). Future ADR. Triggered when N consumers >= ~4 or when the latency profile of one consumer demands fully-async fanout.
- **Workflow status surfacing to the client.** The resolver awaits workflow completion (or first `step.do` for fire-and-forget paths). No client-visible workflow id polling in v1.
- **Cross-workflow orchestration / sagas of sagas.** Each mutation is a single workflow instance. Composition of mutations happens at the resolver layer (which can create multiple workflows in sequence if needed).
- **Effect integration into workflow step bodies.** Steps stay plain async functions in v1; revisit when the resolver-side Effect runtime usage matures.

### When to revisit

- **Workflow creation latency becomes perceptible** at observed traffic volume — revisit fire-and-forget patterns or batching.
- **Workflow boilerplate hits real duplication** across ~3+ classes — extract a shared step helper or base, but only then.
- **Multi-consumer pressure grows** (notifications, search index, analytics, agent quality score, etc.) — promote the queue-fanout follow-up ADR.
- **Cost at scale becomes painful** — first measure step-do count per mutation; coalesce projection steps before considering pattern changes.
