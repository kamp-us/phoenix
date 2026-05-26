/**
 * Resource declarations shared between the alchemy stack (`alchemy.run.ts`) and
 * the worker (`worker/index.ts`). One definition, two consumers: the stack
 * ensures the resource exists before deploy; the worker `bind()`s it at runtime.
 *
 * This replaces the `d1_databases` / `migrations_dir` keys of `wrangler.jsonc`
 * (ADR 0026). The Durable Object namespaces are not declared here — they are the
 * `DurableObjectNamespace` classes themselves (`infra/connection-do.ts`,
 * `infra/topic-do.ts`); declaring + binding them in the worker is enough for
 * alchemy to derive their migrations.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import type * as Effect from "effect/Effect";

/**
 * A typed, lazily-read view of a sibling DO namespace — narrowed to just its
 * `getByName(name)` typed-RPC accessor (the only surface a sibling DO calls
 * across the circular boundary).
 */
export type SiblingNamespace<Rpc> = Effect.Effect<
	{readonly getByName: (name: string) => Rpc},
	never,
	Cloudflare.Worker
>;

/**
 * The forced namespace-cast seam shared by the two live-fan-out DOs
 * (`infra/connection-do.ts` ↔ `infra/topic-do.ts`).
 *
 * Each DO must address its sibling namespace, but referencing the sibling's
 * full `DurableObjectNamespace` class type would form a circular type cycle.
 * This casts the namespace value to the narrowed {@link SiblingNamespace} RPC
 * view, breaking the cycle. It is wrapped in a **function** (called per RPC,
 * never at module top level) so the genuinely-circular runtime import is read
 * at call time — well after both modules have loaded — sidestepping the
 * temporal dead zone (ADR 0028).
 *
 * TODO(alchemy@2.0.0-beta.44): this `as never` cast is forced — the modular
 * `.make()` form is unimplemented for DOs and an eager circular `yield*` in
 * the init block OOMs the build, so the lazy cast is the only seam available.
 * Revisit and drop this helper when alchemy ships DO `.make()` (a non-circular
 * way to declare + reference sibling namespaces); the circular type/runtime
 * cycle that forces the cast goes away with it.
 */
export const siblingNamespace =
	<Rpc>(readNamespace: () => unknown): (() => SiblingNamespace<Rpc>) =>
	() =>
		readNamespace() as never;

/**
 * The single D1 database — the canonical store for every product table
 * (ADR 0009, d1-direct). `migrationsDir` points at the committed Drizzle
 * migration SQL; `migrationsTable: "drizzle_migrations"` keeps the applied-set
 * bookkeeping compatible with drizzle-kit's own table name. alchemy scans the
 * dir and applies pending migrations on deploy — replacing the
 * `wrangler d1 migrations apply` step.
 *
 * The cutover creates a *fresh* D1 (ADR 0009: phoenix has no irreplaceable prod
 * data; re-seed via the import scripts), so there is no adoption flag here.
 */
export const PhoenixDb = Cloudflare.D1Database("phoenix_db", {
	migrationsDir: "./worker/db/drizzle/migrations",
	migrationsTable: "drizzle_migrations",
});
