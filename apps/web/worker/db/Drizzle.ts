/**
 * Drizzle service — the trust boundary between D1 and Effect-native feature code.
 *
 * The Tag's value is a `DrizzleAccess` record carrying two bound methods:
 * `run` (single-statement) and `batch` (atomic multi-statement). Both wrap the
 * promise → Effect boundary with a tagged `DrizzleError` so the resolver edge
 * can map it to `INTERNAL_SERVER_ERROR` cleanly. Neither method appears as a
 * static effect on the Tag class — that earlier shape forced every caller's
 * `R` channel to include `Drizzle` and pushed wrapper-closures into every
 * downstream service.
 *
 * Service idiom (see `.patterns/feature-services.md`): yield Drizzle once at
 * layer build, destructure `{run, batch}`, call them directly in every method
 * body. Method types stay `Effect<A, E, never>`; the dep is owned by the
 * service layer (`Layer<Service, never, Drizzle>`).
 *
 * `DrizzleError` and the `Stmt` / `BatchResult<T>` tuple typing stay intact;
 * only the home of `run` / `batch` moved (Tag-value field instead of class
 * static).
 *
 * ADR 0011 records the decision; the post-fbb57d8 corrective pass in task 4
 * codified the destructure-at-build idiom.
 */
import type {BatchItem, BatchResponse} from "drizzle-orm/batch";
import {drizzle} from "drizzle-orm/d1";
import {Context, Data, Effect, Layer} from "effect";
import * as schema from "../db/drizzle/schema.ts";

/**
 * The fully-typed drizzle builder phoenix uses everywhere. Constructed once
 * per request from `env.PHOENIX_DB`.
 */
export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Infrastructure error raised when a drizzle promise rejects inside
 * `run` / `batch`. Maps to `INTERNAL_SERVER_ERROR` at the resolver edge; the
 * `cause` is preserved for logs but never reaches the user.
 */
export class DrizzleError extends Data.TaggedError("@phoenix/Drizzle/Error")<{
	readonly cause: unknown;
}> {}

/**
 * Single statement type used by `batch`. The tuple shape `[Stmt, ...Stmt[]]`
 * preserves drizzle's per-statement result inference end-to-end.
 */
export type Stmt = BatchItem<"sqlite">;

/**
 * Per-statement result tuple — drizzle's `BatchResponse<T>` flows the tuple
 * shape through so callers get typed access to each statement's return.
 */
export type BatchResult<T extends Readonly<[Stmt, ...Stmt[]]>> = BatchResponse<T>;

/**
 * The Tag's value shape. `run` and `batch` are bound methods on the service
 * value — destructure them at layer build (`const {run, batch} = yield* Drizzle`)
 * and use directly in every method body. They never appear as static effects
 * on the `Drizzle` class.
 */
export interface DrizzleAccess {
	/**
	 * Run a single drizzle query. The callback receives the typed builder and
	 * returns the query's `Promise<A>`; the wrapper produces
	 * `Effect<A, DrizzleError>` with `R = never`.
	 *
	 * House rule: `Effect.tryPromise` always uses object notation with an
	 * explicit `catch` producing a tagged error. The catch here produces
	 * `DrizzleError` so resolvers can map it cleanly to
	 * `INTERNAL_SERVER_ERROR`.
	 */
	readonly run: <A>(fn: (db: DrizzleDb) => Promise<A>) => Effect.Effect<A, DrizzleError>;

	/**
	 * Atomic multi-statement write via D1's native batch API. The callback
	 * returns the tuple of unexecuted drizzle statements; the result is typed
	 * against the tuple shape (`BatchResult<T>`). Either every statement
	 * commits or none do.
	 */
	readonly batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(
		fn: (db: DrizzleDb) => T,
	) => Effect.Effect<BatchResult<T>, DrizzleError>;
}

/**
 * `Drizzle` is the Tag whose value carries the bound `run` / `batch` methods.
 * The class itself is identity-only — no static effects, no helpers — so the
 * one canonical API surface is the destructured methods.
 *
 * @example
 *   const {run, batch} = yield* Drizzle;
 *   const term = yield* run((db) =>
 *     db.query.termSummary.findFirst({where: eq(schema.termSummary.slug, slug)}),
 *   );
 *
 * @example
 *   yield* batch((db) => [
 *     db.insert(schema.definitionVote).values({...}),
 *     db.update(schema.definitionView).set({...}).where(...),
 *   ] as const);
 */
export class Drizzle extends Context.Service<Drizzle, DrizzleAccess>()("@phoenix/Drizzle") {}

/**
 * Build the fully-typed drizzle instance from a bound D1 database. The single
 * place `drizzle(db, {schema})` is called — both the worker init (via the bound
 * `D1Connection.raw`) and tests hand it a `D1Database` and get back the same
 * `DrizzleDb` every feature service runs on.
 */
export const createDrizzle = (db: D1Database): DrizzleDb => drizzle(db, {schema});

/**
 * Build a `DrizzleAccess` value over an already-constructed drizzle instance —
 * the single home of the `run` / `batch` bodies. {@link makeDrizzleLayer} wraps
 * this, so the promise → Effect boundary and the tagged `DrizzleError` catch
 * live in exactly one place.
 *
 * House rule (`.patterns/feature-services.md`): `Effect.tryPromise` always uses
 * object notation with an explicit `catch` producing a tagged error — here
 * `DrizzleError`, so resolvers can map it cleanly to `INTERNAL_SERVER_ERROR`.
 */
export const makeDrizzleAccess = (db: DrizzleDb): DrizzleAccess => ({
	run: <A>(fn: (db: DrizzleDb) => Promise<A>) =>
		Effect.tryPromise({
			try: () => fn(db),
			catch: (cause) => new DrizzleError({cause}),
		}),
	batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(fn: (db: DrizzleDb) => T) =>
		Effect.tryPromise({
			try: () => db.batch(fn(db)) as Promise<BatchResult<T>>,
			catch: (cause) => new DrizzleError({cause}),
		}),
});

/**
 * Build the `Drizzle` layer from an **already-constructed** drizzle instance.
 *
 * Per ADR 0029 / `.patterns/alchemy-runtime.md`: on alchemy the D1 binding is
 * stable for the isolate's life, so `drizzle()` is built ONCE in the worker init
 * (from the bound `D1Connection.raw`) and provided as a worker-level layer. The
 * `run` / `batch` surface comes from {@link makeDrizzleAccess}; the `db` arrives
 * as an argument so neither this layer nor its consumers read a per-request
 * `CloudflareEnv`.
 */
export const makeDrizzleLayer = (db: DrizzleDb): Layer.Layer<Drizzle> =>
	Layer.succeed(Drizzle, makeDrizzleAccess(db));
