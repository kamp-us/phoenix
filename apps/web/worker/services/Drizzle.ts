/**
 * Drizzle service — the trust boundary between D1 and Effect-native feature code.
 *
 * Holds the singleton drizzle builder constructed from `env.PHOENIX_DB`. Feature
 * services consume it via `Drizzle.run(cb)` / `Drizzle.batch(cb)` — they never
 * touch `Effect.tryPromise` directly and never see the raw D1 binding.
 *
 * See `.patterns/feature-services.md` for the full rationale and call-site
 * conventions; ADR 0011 records the decision.
 */
import type {BatchItem} from "drizzle-orm/batch";
import {drizzle} from "drizzle-orm/d1";
import {Context, Data, Effect, Layer} from "effect";
import * as schema from "../db/drizzle/schema";
import {CloudflareEnv} from "./CloudflareEnv";

/**
 * The fully-typed drizzle builder phoenix uses everywhere. Constructed once
 * per request from `env.PHOENIX_DB`.
 */
export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Infrastructure error raised when a drizzle promise rejects inside
 * `Drizzle.run` / `Drizzle.batch`. Maps to `INTERNAL_SERVER_ERROR` at the
 * resolver edge; the `cause` is preserved for logs but never reaches the user.
 */
export class DrizzleError extends Data.TaggedError("@phoenix/Drizzle/Error")<{
	readonly cause: unknown;
}> {}

/**
 * `Drizzle` is the drizzle builder, exposed as a `Context.Service`. The class
 * doubles as the tag (`yield* Drizzle` gives you the builder) and the namespace
 * for the `run` / `batch` static helpers feature code uses.
 *
 * @example
 *   const term = yield* Drizzle.run((db) =>
 *     db.query.termSummary.findFirst({where: eq(schema.termSummary.slug, slug)}),
 *   );
 *
 * @example
 *   yield* Drizzle.batch((db) => [
 *     db.insert(schema.definitionVote).values({...}),
 *     db.update(schema.definitionView).set({...}).where(...),
 *   ]);
 */
export class Drizzle extends Context.Service<Drizzle, DrizzleDb>()("@phoenix/Drizzle") {
	/**
	 * Run a single drizzle query. The callback receives the typed builder and
	 * returns the query's `Promise<A>`; the static yields the `Drizzle` service
	 * internally and wraps the promise as `Effect<A, DrizzleError, Drizzle>`.
	 *
	 * House rule: `Effect.tryPromise` always uses object notation with an
	 * explicit `catch` producing a tagged error. The catch here produces
	 * `DrizzleError` so resolvers can map it cleanly to `INTERNAL_SERVER_ERROR`.
	 */
	static readonly run = <A>(fn: (db: DrizzleDb) => Promise<A>) =>
		Effect.gen(function* () {
			const db = yield* Drizzle;
			return yield* Effect.tryPromise({
				try: () => fn(db),
				catch: (cause) => new DrizzleError({cause}),
			});
		});

	/**
	 * Atomic multi-statement write via D1's native batch API. The callback
	 * returns the tuple of unexecuted drizzle statements; the result is typed
	 * against the tuple shape (`BatchResponse<T>`). Either every statement
	 * commits or none do.
	 */
	static readonly batch = <U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(
		fn: (db: DrizzleDb) => T,
	) =>
		Effect.gen(function* () {
			const db = yield* Drizzle;
			const statements = fn(db);
			return yield* Effect.tryPromise({
				try: () => db.batch(statements),
				catch: (cause) => new DrizzleError({cause}),
			});
		});
}

/**
 * Live layer — constructs the drizzle builder from `env.PHOENIX_DB`. Depends
 * on `CloudflareEnv`, which is provided per-request at the worker entry.
 */
export const DrizzleLive = Layer.effect(Drizzle)(
	Effect.gen(function* () {
		const env = yield* CloudflareEnv;
		return drizzle(env.PHOENIX_DB, {schema});
	}),
);
