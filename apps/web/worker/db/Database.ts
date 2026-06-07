/**
 * `Database` service — the single seam holding the raw `D1Database` handle
 * (ADR 0040, b1 addendum).
 *
 * The Tag's value IS the raw Cloudflare `D1Database` binding. Both downstream
 * surfaces *derive* from it:
 *   - the `Drizzle` service is built from `Database` (via `createDrizzle`), and
 *   - the better-auth adapter is built from `Database`.
 *
 * Because both derive from the **same** `Database` tag they are guaranteed to
 * share one underlying handle — the one-`sqlite` invariant the original ADR
 * asked tests to uphold by hand is now type-enforced by the layer graph. A
 * consumer (or a test) provides one `Database` layer and both `Drizzle` and
 * auth follow.
 *
 * This module is purely additive: it introduces the tag plus its production
 * (`DatabaseLive`) and test (`makeDatabaseTest`) layers. Nothing else is
 * rewired onto `Database` yet — the seam wiring (`Drizzle` + auth deriving from
 * the tag) is a follow-on.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import {Context, Effect, Layer} from "effect";
import {PhoenixDb} from "./resources.ts";
import {makeSqliteTestDb} from "./sqlite-d1.fake.ts";

/**
 * `Database` is the Tag whose value is the raw Cloudflare `D1Database` handle.
 * Identity-only — no static effects, no helpers; the canonical surface is the
 * raw handle itself, which `createDrizzle` and the better-auth adapter consume.
 *
 * @example
 *   const raw = yield* Database;
 *   const db = createDrizzle(raw);
 */
export class Database extends Context.Service<Database, D1Database>()("@phoenix/Database") {}

/**
 * Production `Database` layer: source the raw handle from the `PhoenixDb`
 * binding, mirroring the worker init (`Cloudflare.D1Connection.bind(PhoenixDb)`
 * → `.raw`, the underlying Cloudflare `D1Database`). The binding is stable for
 * the isolate's life, so the handle is resolved once and provided as a
 * worker-level layer; there is no finalizer because a Cloudflare binding is not
 * a resource the worker owns or closes.
 */
export const DatabaseLive = Layer.effect(
	Database,
	Effect.gen(function* () {
		const connection = yield* Cloudflare.D1Connection.bind(PhoenixDb);
		return yield* connection.raw;
	}),
);

/**
 * Test `Database` layer: a fresh in-memory `node:sqlite`-backed D1 handle (via
 * {@link makeSqliteTestDb}, with the baseline migration applied and
 * `foreign_keys` forced OFF to match D1) wrapped in `Effect.acquireRelease`, so
 * the handle is closed when the scope ends.
 *
 * A **factory, not a shared instance** — each call yields an independent
 * `:memory:` database, so tests never cross-contaminate.
 *
 * `Layer.scoped` does not exist at this effect pin; `Layer.effect` over an
 * `Effect.acquireRelease` is the equivalent — `Layer.effect` consumes the
 * `Scope` the acquire-release introduces, so the finalizer runs on the layer's
 * scope teardown.
 */
export const makeDatabaseTest = (): Layer.Layer<Database> =>
	Layer.effect(
		Database,
		Effect.acquireRelease(
			Effect.sync(() => makeSqliteTestDb()),
			(sqlite) => Effect.sync(() => sqlite.close()),
		).pipe(Effect.map((sqlite) => sqlite.d1)),
	);
