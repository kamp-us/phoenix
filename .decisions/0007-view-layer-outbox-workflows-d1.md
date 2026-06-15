---
id: 0007
title: View layer — outbox + Workflows + single D1, triggered inline
status: accepted
date: 2026-05-09
tags: [architecture, durable-objects, workflows, d1, projection, agents-sdk]
---

# 0007 — View layer: outbox + Workflows + single D1, triggered inline

## Context

[ADR 0005](0005-product-dos-shard-by-coordination-atom.md) committed product
DOs to per-coordination-atom sharding (`SozlukTerm`, `PanoPost`) backed by a
view layer for cross-entity reads. [ADR 0006](0006-product-dos-extend-cloudflare-agent.md)
picked Cloudflare's `Agent<Env, State>` as the DO base class. This ADR fills
the third layer: the projection transport, the view-store shape, the trigger
pattern, and durability.

The sözlük-redesign grill (Q9–Q15) landed these substantive findings that
this ADR locks in:

- **Workflows over Queues** for projection. CF Workflows GA April 2026; local
  dev story (Local Explorer, `wrangler workflows trigger --local`) is mature
  while CF Queues local-dev is "experimental, subject to change." Single
  projection target = simplicity wins. Strategic alignment with CF's
  durable-execution direction.
- **Skip the Agent SDK's `runWorkflow` helper.** It maintains a
  `cf_agents_workflows` mirror of workflow status inside the Agent — a
  classic dual-source-of-truth problem (status drifts when lifecycle
  callbacks fail or workflows are externally terminated). For our
  fire-and-forget projection, status tracking is dead weight. Direct
  `env.PHOENIX_PROJECTION.create({id, params})` is the right call.
- **Trigger goes inline in the mutating method, not in `onStateChanged`.**
  CF documents `onStateChanged` as a notification hook ("should not block
  broadcasts"); zero CF examples trigger Workflows from it. This overrides
  ADR 0006's "Projection emission contract" — see "ADR 0006 amendment" below.
- **DO sqlite is synchronous.** `ctx.storage.sql.exec()` returns a cursor,
  not a Promise. Sequential SQL writes are atomic only inside
  `ctx.storage.transactionSync(() => { ... })`. This makes the outbox
  insert atomic with the mutation in one synchronous block.
- **Outbox + Agent's built-in `this.queue` is the durability mechanism.**
  Idempotency on `workflow.create` (via forge ULID id) makes RETRIES safe
  but doesn't provide a retry mechanism. If `create` throws after `setState`
  commits, the trigger is lost. The Agent SDK ships a built-in
  framework-managed task queue (`this.queue(callback, payload, {retry})`,
  backed by a `cf_agents_queues` table in Agent sqlite, with auto-dispatch
  + retry + dequeue on success). We use it for dispatch — but `this.queue`
  is async and CANNOT sit inside `transactionSync`, so it is not atomic
  with the mutation on its own. The hybrid pattern (atomic outbox row in
  `transactionSync` + `this.queue` for retry-aware dispatch + reconciliation
  on Agent wake) is the only design that doesn't lose events under normal
  failure modes (worker death between mutation commit and queue call,
  worker restart on deploy, transient queue insert failure).
- **Shape A — one big SQL cache, peelable.** Single D1 with discrete
  per-aggregate tables; one projection workflow with discrete steps per
  event kind; no join-spaghetti inside projection. Joins happen at read
  time in resolvers, where they're cheap to refactor when a view earns
  its own service.

[wf-ga]: https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/
[agent-pat]: https://github.com/cloudflare/agents

## Decision

### Substrate

- **One D1 binding: `PHOENIX_DB`.** Holds all materialized views for all
  product DOs (Sozluk, Pano, future products).
- **One Workflows binding: `PHOENIX_PROJECTION`** pointing at a single
  `PhoenixProjection` class.
- **Same Worker** for producer (Agents) and consumer (workflow handler) —
  one bundle, one deployment, shared `env`, shared types.

### View tables (initial)

```ts
// apps/web/worker/view/drizzle/schema.ts (D1, not DO sqlite)

export const termSummary = sqliteTable("term_summary", {
  slug: text("slug").primaryKey(),
  title: text("title").notNull(),
  firstLetter: text("first_letter").notNull(),         // for alphabet pivot
  definitionCount: integer("definition_count").notNull().default(0),
  totalScore: integer("total_score").notNull().default(0),
  excerpt: text("excerpt"),
  topDefinitionId: text("top_definition_id"),
  firstAt: integer("first_at", {mode: "timestamp"}),
  lastActivityAt: integer("last_activity_at", {mode: "timestamp"}),
  lastEditAt: integer("last_edit_at", {mode: "timestamp"}),
  lastEventId: text("last_event_id").notNull().default(""),  // ULID, lex ordering
}, (t) => [
  index("term_summary_recent").on(desc(t.lastActivityAt)),
  index("term_summary_popular").on(desc(t.totalScore)),
  index("term_summary_letter").on(t.firstLetter),
]);

export const sozlukStats = sqliteTable("sozluk_stats", {
  id: integer("id").primaryKey().default(1),
  totalDefinitions: integer("total_definitions").notNull().default(0),
  totalAuthors: integer("total_authors").notNull().default(0),
  updatedAt: integer("updated_at", {mode: "timestamp"}).notNull(),
});

export const postSummary = sqliteTable("post_summary", {
  id: text("id").primaryKey(),
  slug: text("slug"),
  title: text("title").notNull(),
  host: text("host"),
  authorId: text("author_id").notNull(),
  authorName: text("author_name").notNull(),
  score: integer("score").notNull().default(0),
  commentCount: integer("comment_count").notNull().default(0),
  hotScore: integer("hot_score").notNull().default(0),     // f(score, age)
  createdAt: integer("created_at", {mode: "timestamp"}).notNull(),
  lastActivityAt: integer("last_activity_at", {mode: "timestamp"}).notNull(),
  lastEventId: text("last_event_id").notNull().default(""),
}, (t) => [
  index("post_summary_hot").on(desc(t.hotScore)),
  index("post_summary_new").on(desc(t.createdAt)),
  index("post_summary_top").on(desc(t.score)),
  index("post_summary_host").on(t.host),
]);

export const panoStats = sqliteTable("pano_stats", {
  id: integer("id").primaryKey().default(1),
  totalPosts: integer("total_posts").notNull().default(0),
  totalComments: integer("total_comments").notNull().default(0),
  totalAuthors: integer("total_authors").notNull().default(0),
  updatedAt: integer("updated_at", {mode: "timestamp"}).notNull(),
});

// Powers `myVote` field — per-user-per-target lookup
export const userVote = sqliteTable("user_vote", {
  userId: text("user_id").notNull(),
  targetKind: text("target_kind").notNull(),    // 'definition' | 'post' | 'comment'
  targetId: text("target_id").notNull(),
  value: integer("value").notNull(),             // +1 / -1
  updatedAt: integer("updated_at", {mode: "timestamp"}).notNull(),
}, (t) => [
  primaryKey({columns: [t.userId, t.targetKind, t.targetId]}),
  index("user_vote_target").on(t.targetKind, t.targetId),
]);
```

Each table is read by **resolvers** for cross-entity GraphQL queries
(`terms(sort,limit)`, `posts(sort,limit,host)`, `me { votes }`, etc.).
Per-entity reads (`term(slug)`, `post(idOrSlug)`) still RPC into the
per-entity Agent.

### Producer pattern (atomic outbox + Agent task queue + reconciliation)

The pattern has three parts:

1. **Atomic outbox** in the same `transactionSync` block as the mutation —
   the only thing that guarantees we never lose an event when the worker
   dies between mutation commit and dispatch.
2. **Agent's built-in `this.queue`** for retry-aware dispatch — handles
   sequential FIFO processing, persistence across restarts, and exponential
   backoff for transient `workflow.create` failures.
3. **`onStart` reconciliation + periodic safety net** — wakes scan the
   outbox for orphaned rows (left behind by worker death after the
   transactionSync commit but before `this.queue` succeeded) and re-queues
   flush tasks.

Outbox table inside each Agent's sqlite:

```ts
// In SozlukTerm DO sqlite (and PanoPost):
export const outbox = sqliteTable("outbox", {
  eventId: text("event_id").primaryKey(),       // forge ULID, lex-sortable
  payload: text("payload").notNull(),           // JSON
  createdAt: integer("created_at").notNull(),
});
```

Mutation method shape:

```ts
@callable()
async vote(definitionId: string, value: 1 | -1, voterId: string) {
  const eventId = id('evt');                    // forge monotonic ULID

  // 1. ATOMIC: mutation + outbox row in one synchronous transaction.
  //    This is the durability guarantee — if anything in this block
  //    succeeds, the projection cannot be lost.
  this.ctx.storage.transactionSync(() => {
    this.sql`
      INSERT INTO definition_vote (definition_id, voter_id, value)
      VALUES (${definitionId}, ${voterId}, ${value})
      ON CONFLICT(definition_id, voter_id) DO UPDATE SET value = excluded.value
    `;
    const [{total}] = this.sql`
      SELECT COALESCE(SUM(value), 0) AS total
      FROM definition_vote WHERE definition_id = ${definitionId}
    `.toArray();
    this.sql`UPDATE definition SET score = ${total} WHERE id = ${definitionId}`;

    const payload = JSON.stringify({
      kind: 'TermChanged',
      slug: this.name,
      title: this.state.title,
      definitionCount: this.state.definitionCount,
      totalScore: total,
      lastActivityAt: Date.now(),
      eventId,
    });
    this.sql`
      INSERT INTO outbox (event_id, payload, created_at)
      VALUES (${eventId}, ${payload}, ${Date.now()})
    `;
  });

  // 2. State update fires after commit; pushes to WebSocket-connected clients
  this.setState({...this.state, totalScore: total, lastEventId: eventId});

  // 3. Best-effort fast dispatch via Agent's built-in queue.
  //    Failure here is fine — the outbox row is durable, reconciliation
  //    catches it on next Agent wake or on the periodic schedule.
  try {
    await this.queue('flushOutbox', {eventId}, {
      retry: {maxAttempts: 5},
    });
  } catch (err) {
    console.error('[queue-immediate] enqueue failed; reconcile will catch', err);
  }
}

// Auto-dispatched callback. Throws → Agent retries per RetryOptions.
// Returns → framework auto-dequeues from cf_agents_queues.
async flushOutbox({eventId}: {eventId: string}) {
  const [row] = this.sql`
    SELECT payload FROM outbox WHERE event_id = ${eventId}
  `.toArray();
  if (!row) return;                              // already flushed; idempotent

  await this.env.PHOENIX_PROJECTION.create({
    id: eventId,                                 // forge ULID = idempotent on retry
    params: JSON.parse(row.payload),
  });

  this.sql`DELETE FROM outbox WHERE event_id = ${eventId}`;
}

// Reconciliation: scan outbox for orphans, queue flush tasks for each.
async reconcileOutbox() {
  const orphans = this.sql`
    SELECT event_id FROM outbox ORDER BY event_id ASC LIMIT 100
  `.toArray();
  for (const {event_id} of orphans) {
    try {
      await this.queue('flushOutbox', {eventId: event_id});
    } catch (err) {
      console.error('[reconcile-outbox]', err);
      break;                                     // back off; next reconcile retries
    }
  }
}
```

Wake-time + periodic reconciliation, set once on Agent start:

```ts
async onStart() {
  // Recover any orphans left behind by worker death between transactionSync
  // commit and the immediate `this.queue` call.
  await this.reconcileOutbox();

  // Periodic safety net for hibernated Agents that never get woken by traffic.
  if (!(await this.getScheduleById('reconcile-outbox'))) {
    await this.scheduleEvery(300, 'reconcileOutbox');  // 5 min
  }
}
```

### Workflow class

Single class with `event.kind` switch:

```ts
// apps/web/worker/view/PhoenixProjection.ts
export class PhoenixProjection extends WorkflowEntrypoint<Env, ProjectionEvent> {
  async run(event: WorkflowEvent<ProjectionEvent>, step: WorkflowStep) {
    const e = event.payload;

    await step.do(`project-${e.kind}`, async () => {
      switch (e.kind) {
        case 'TermChanged': return projectTermChanged(this.env.PHOENIX_DB, e);
        case 'PostChanged': return projectPostChanged(this.env.PHOENIX_DB, e);
        case 'VoteRecorded': return projectVoteRecorded(this.env.PHOENIX_DB, e);
        default: throw new Error(`unknown event kind: ${(e as ProjectionEvent).kind}`);
      }
    });
  }
}
```

Each `project*` function is one D1 write to one MV table. **No
cross-table joins inside projection** — that preserves Shape B as the
mental model and keeps each table independently peelable into its own
service later.

Projection writes are **convergent overwrites** guarded by `lastEventId`:

```ts
async function projectTermChanged(db: D1Database, e: TermChangedEvent) {
  await db.prepare(`
    INSERT INTO term_summary (slug, title, first_letter, definition_count,
                              total_score, last_activity_at, last_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      title             = excluded.title,
      definition_count  = excluded.definition_count,
      total_score       = excluded.total_score,
      last_activity_at  = excluded.last_activity_at,
      last_event_id     = excluded.last_event_id
    WHERE term_summary.last_event_id < excluded.last_event_id
  `).bind(e.slug, e.title, e.slug.charAt(0), e.definitionCount,
          e.totalScore, e.lastActivityAt, e.eventId).run();
}
```

Forge ULIDs are lex-sortable, so `last_event_id < excluded.last_event_id`
is the natural ordering guard. Out-of-order events (rare, but possible
under retry) become no-ops. No separate idempotency table needed.

### Wrangler configuration

```jsonc
"d1_databases": [
  { "binding": "PHOENIX_DB", "database_name": "phoenix-view", "database_id": "..." }
],
"workflows": [
  { "name": "phoenix-projection", "binding": "PHOENIX_PROJECTION",
    "class_name": "PhoenixProjection" }
],
```

## Consequences

### ADR 0006 amendment

ADR 0006's "Projection emission contract" section claimed `onStateChanged`
as the projection chokepoint. **That section is overridden by this ADR.**
Per CF's documented intent (notification hook, not side-effect trigger)
and zero CF examples triggering Workflows from it, the trigger goes inline
in the mutating method, after `setState`, with the outbox guaranteeing
durability.

The rest of ADR 0006 stands: product DOs extend `Agent<Env, State>`, we
adopt typed state + WebSocket sync + multi-schedule + `@callable()`, we do
NOT adopt `runWorkflow` or any AI packages.

### Refactor sequencing (ADR 0005 + 0006 + 0007 land together)

The Sozluk and Pano refactors mandated by ADR 0005 + 0006 + this ADR are
one PR per product, not staggered:

1. Add D1 binding (`PHOENIX_DB`); generate the view schema with drizzle.
2. Add Workflows binding (`PHOENIX_PROJECTION`); add `PhoenixProjection`
   class skeleton with no-op steps.
3. Refactor `Sozluk` (singleton DO) → `SozlukTerm extends Agent` (per-term).
   Schema changes: drop `term` table, add `term_meta` (one row per DO),
   `definition_vote`, `outbox`. Resolver split: `terms(sort,limit)` reads
   from `PHOENIX_DB.term_summary`; `term(slug)` RPCs into `SozlukTerm`.
   Mutations (`addDefinition`, `voteDefinition`, `retractVote`) follow the
   producer pattern above.
4. Same for `Pano` → `PanoPost extends Agent` (per-post). Schema changes
   mirror Sozluk: `post_meta`, `post_vote`, `comment_vote`, `outbox`.
   Resolver split: `posts(sort,limit,host)` reads from
   `PHOENIX_DB.post_summary`; `post(idOrSlug)` and `postComments(postId)`
   RPC into `PanoPost`.
5. Implement `PhoenixProjection` step bodies for the actual event kinds.
6. Re-seed via the new write paths (no live data exists).
7. Wrangler migration: `delete_classes: ["Sozluk", "Pano"]`,
   `new_sqlite_classes: ["SozlukTerm", "PanoPost"]`, new tag `v4`.
   Update bindings (`SOZLUK` → `SOZLUK_TERM`, `PANO` → `PANO_POST`).

### Failure modes addressed

| Failure | Recovery |
|---|---|
| Worker dies after `transactionSync` commits, before `this.queue` enqueue | Outbox row is durable. Next Agent wake → `onStart.reconcileOutbox` re-queues a flush task. |
| `this.queue` enqueue itself fails (rare; sqlite write under the hood) | Outbox row remains; `onStart` and `scheduleEvery('reconcile-outbox', 300)` re-queue. |
| `workflow.create` throws inside `flushOutbox` callback | `this.queue`'s `RetryOptions` re-runs the callback with backoff; ULID id makes the eventual create idempotent. |
| D1 write fails inside a workflow step | Workflow `step.do(...)` retries automatically with backoff; permanent failure → instance marked `failed` in CF Workflows dashboard. |
| Out-of-order projection delivery (rare under retry) | Projection D1 update guarded by `WHERE last_event_id < excluded.last_event_id`. Stale events become no-ops. |
| Agent hibernates with rows in outbox, never naturally woken | `scheduleEvery('reconcile-outbox', 300)` wakes it every 5 min; `onStart` reconciles on every wake. |

### Banned

- **`runWorkflow` helper from Agent SDK** — dual-source-of-truth, status
  mirror drift. Use direct `env.PHOENIX_PROJECTION.create({id, params})`.
- **Triggering workflows from `onStateChanged`** — CF documents the hook
  as notification-only. Trigger inline in mutating methods.
- **Cross-MV-table joins inside projection steps** — keeps Shape B as the
  peeling axis. Joins happen at read time in resolvers.
- **Mutation methods that bypass the outbox** — every state-changing
  method on a product Agent MUST write an outbox row inside its
  `transactionSync` block. Bypassing breaks projection durability.
- **Calling `this.queue('flushOutbox', ...)` without writing the outbox
  row first** — `this.queue` is async and lives outside `transactionSync`;
  it is NOT a substitute for the atomic outbox write. The atomicity is in
  the outbox row; the queue is the dispatcher.
- **Drizzle inside `transactionSync`** — drizzle's API is async; only
  synchronous storage operations are allowed in `transactionSync`. Use
  raw `this.sql` for atomic mutation blocks. Drizzle stays for schema,
  migrations, and async cross-aggregate queries (in resolvers and in the
  workflow consumer reading from `PHOENIX_DB`).

### Out of scope

- **Voting mechanics specifics** (up-only vs up/down, weights, reputation) —
  decide separately when wiring vote mutations.
- **Anti-abuse** (rate limiting, vote manipulation, sockpuppets) — when
  votes are wired.
- **WebSocket subscriptions from the React frontend** to per-entity Agents
  for live updates. Initial reads stay GraphQL → DO RPC. Add Agent
  WebSocket subscriptions when the first live-update UX is needed.
- **Full-text / semantic search** (Vectorize, AI Search) — sozluk's
  `excerpt` field and term titles are searchable via simple `LIKE` for
  now. Add when corpus grows.
- **Workers Analytics Engine** for high-cardinality counters (trending,
  view counts). YAGNI for community scale; D1 indexed reads suffice.
- **Multiple projection consumers** (notifications, search index,
  analytics). Currently one consumer (D1). Workflows handles a single
  projection target cleanly; if we need multiple, that's a follow-up
  ADR (potentially Queues for fan-out).

### When to revisit

- **Workflows pricing or limits become painful** at observed event volume.
  Mitigation order: increase coalescing in `tryFlushOutbox` (drain larger
  batches per call), then move to Queues for fan-out, then per-view services.
- **A specific MV table earns its own service** (semantic search,
  real-time presence, etc.). Peel it off: extract its table + its
  projection step into a separate service. The Shape B mental model is
  the migration path.
- **Cross-product joins become so frequent** the read pattern argues for
  a different read store (postgres via Hyperdrive, etc.). Unlikely.
