/**
 * `TopicDO` — the topic-role half of phoenix's live fan-out (ADR 0023, split per
 * ADR 0025), on alchemy's modular Effect Durable Object model (ADR 0028).
 *
 * One instance per topic, named `topic:<topicKey>`. It owns the **durable
 * subscriber registry** for that topic (in `state.storage.sql`), the **publish
 * fan-out**, and the **alarm reap** — nothing about any client's SSE stream.
 * The algorithm (epoch-based stale detection, the consecutive-miss reap, the
 * bounded fan-out) is a verbatim port of the legacy `cloudflare:workers` class;
 * the behavior lives in `makeTopicInstance` (`live-instance.ts`).
 *
 * **Modular `.make()` form** — the `TopicDO` class is a lightweight Tag (identity
 * + the `TopicRpc` contract on its 2nd type param, NO inline body), and
 * {@link TopicDOLive} is the implementation Layer. Splitting the two breaks the
 * `ConnectionDO` ↔ `TopicDO` circular reference that forced the old `as never`
 * sibling-cast seam: the sibling `ConnectionDO` namespace is obtained by
 * `yield*`-ing its Tag (a context lookup alchemy excludes from the Layer's
 * requirements via `DurableObjectServices`), so there is no circular Layer
 * dependency and no cast. Siblings are addressed by name
 * (`getByName(\`connection:${id}\`)`) — never `idFromName`/`idFromString`/`get`
 * (unavailable on the alchemy stub).
 *
 * The `ConnectionDO` sibling is resolved **per fan-out call** (`yield*
 * ConnectionDO` inside `publish`/`alarm`, never in init): resolving it in shared
 * init would pin the sibling Tag onto this Layer's requirements and form a
 * circular Layer dependency with `ConnectionDOLive`. Per-call, the Tag
 * requirement lands on the RPC method's `R` instead (declared in
 * {@link TopicRpcSurface}).
 */
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ConnectionDO from "./connection-do.ts";
import {type ConnectionRpc, makeTopicInstance, type TopicInstance} from "./live-instance.ts";

/**
 * The typed surface callers reach across the `TopicDO` stub: a sibling
 * `ConnectionDO` calls `register`/`deregister`, and the worker's `LiveTopics`
 * handle calls `publish`. `alarm` is invoked by the runtime, not via a stub, but
 * is part of the DO shape so it stays declared. `register`/`deregister` resolve
 * nothing → `R = never`; `publish`/`alarm` resolve the connection sibling per
 * call → `R = ConnectionDO | Worker` (`yield* ConnectionDO` also needs the
 * `Worker` binding service; alchemy provides both on the DO side, and the worker
 * — which yields `ConnectionDO`/`Worker` in init and hosts the DO — satisfies
 * them for its `LiveTopics.publish` call), so no cast is needed at either seam.
 */
export type TopicRpcSurface = Pick<
	TopicInstance<ConnectionDO | Cloudflare.Worker>,
	"register" | "deregister" | "publish" | "alarm"
>;

/**
 * `TopicDO` Tag — identity plus the {@link TopicRpcSurface} contract callers
 * reach across the stub. No inline body: the runtime implementation is
 * {@link TopicDOLive}, so importing this Tag pulls in no DO runtime code (the
 * bundler tree-shakes `.make()` out of consumers).
 */
export default class TopicDO extends Cloudflare.DurableObjectNamespace<TopicDO, TopicRpcSurface>()(
	"TopicDO",
) {}

/**
 * The `TopicDO` implementation Layer. The `ConnectionDO` sibling namespace is
 * resolved per fan-out call (`Effect.map(ConnectionDO, …)` inside the resolver
 * thunk — never in shared init, which would pin the sibling Tag onto this
 * Layer's requirements and form a circular Layer dependency with
 * `ConnectionDOLive`), then each call addresses a specific connection by name.
 */
export const TopicDOLive = TopicDO.make(
	Effect.gen(function* () {
		// ── SHARED INIT (once per namespace) ──
		// Do NOT resolve the ConnectionDO sibling here: `yield* ConnectionDO` in init
		// pins the sibling Tag onto this Layer's requirements, and paired with
		// `yield* TopicDO` in ConnectionDOLive's init that is a circular Layer
		// dependency `Layer.mergeAll` can't satisfy. Resolve it per fan-out call
		// (inside `publish`/`alarm`) instead — the Tag requirement then lands on the
		// RPC method's `R`, which alchemy provides from the DO's own services.
		// The shared-init gen RETURNS the per-instance Effect (run once per instance
		// wake). `return yield*` would run per-instance setup during shared init and
		// break the two-phase DO model — so the nested Effect is intentional here.
		// @effect-diagnostics-next-line effect/returnEffectInGen:off
		return Effect.gen(function* () {
			// ── PER-INSTANCE (once per instance wake) ──
			const state = yield* Cloudflare.DurableObjectState;
			// Run pending SQL migrations BEFORE building the instance — the migrator
			// layer runs on construction (`Layer.effectDiscard`) so by the time the
			// inner builder runs, `effect_sql_migrations` is up-to-date and the
			// `subscribers` schema matches what `live-instance.ts` expects. Migrations
			// are idempotent: on a fresh DO both run; on an existing DO the recorded
			// id in `effect_sql_migrations` gates pending ones. `import.meta.glob`
			// resolves at Vite build time, so the migration modules ship with the
			// worker bundle. `state.storage.sql.raw` is the underlying `cf.SqlStorage`
			// handle — alchemy wraps `exec` to return an Effect; the upstream adapter
			// expects the raw sync handle.
			const sqliteLayer = SqliteClient.layer({db: state.storage.sql.raw});
			const migratorLayer = SqliteMigrator.layer({
				loader: SqliteMigrator.fromGlob(
					import.meta.glob("./migrations/topic/*.ts", {eager: false}),
				),
			}).pipe(Layer.provide(sqliteLayer));
			// `Effect.orDie` absorbs MigrationError | SqlError into a defect — a
			// migration failure here is a hard infra crash (the DO is unusable), not
			// a recoverable error to surface to callers. Merging the two layers into
			// one `provide` keeps the service lifecycle coherent.
			return yield* Effect.sync(() =>
				makeTopicInstance(
					state,
					(connectionId): Effect.Effect<ConnectionRpc, never, ConnectionDO | Cloudflare.Worker> =>
						// Resolve the sibling ConnectionDO Tag per call (alchemy provides it —
						// plus the `Worker` binding service `yield* ConnectionDO` needs — on the
						// DO side), then address one connection by its human-readable name. The
						// typed stub's RPC surface matches `ConnectionRpc` exactly — no cast.
						Effect.map(ConnectionDO, (connections) =>
							connections.getByName(`connection:${connectionId}`),
						),
				),
			).pipe(Effect.provide(migratorLayer), Effect.orDie);
		});
	}),
);
