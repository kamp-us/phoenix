/**
 * Drizzle service — the trust boundary between D1 and Effect-native feature code
 * (ADR 0011). `run` and `batch` are bound methods on the Tag's value, NOT static
 * effects on the class: that shape forced every caller's `R` to include `Drizzle`.
 * Destructure `{run, batch}` at layer build (`.patterns/feature-services.md`).
 */
import type {BatchItem, BatchResponse} from "drizzle-orm/batch";
import {drizzle} from "drizzle-orm/d1";
import {defineRelations} from "drizzle-orm/relations";
import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {Database} from "../db/Database.ts";
import * as schema from "../db/drizzle/schema.ts";

/**
 * RQB v2 (drizzle 1.0) drives `db.query.<table>` off a relations definition, not
 * `schema` alone — passing only `{schema}` leaves `db.query` empty (`{}`). phoenix
 * uses no cross-table `.with` traversal, so empty relations are enough.
 */
export const relations = defineRelations(schema);

export type DrizzleDb = ReturnType<typeof drizzle<typeof relations>>;

/**
 * Deliberately schema-agnostic: both the worker's full `DrizzleDb` and the backfill
 * CLI's narrow-schema db satisfy it, so `@kampus/fts-backfill` can replay the same
 * builders without pulling the worker's whole schema graph.
 */
export type FtsSyncDb = Pick<DrizzleDb, "delete" | "insert">;

/** The `cause` is preserved for logs but never reaches the user. */
export class DrizzleError extends Schema.TaggedErrorClass<DrizzleError>()("@kampus/Drizzle/Error", {
	cause: Schema.Defect(),
}) {}

/**
 * The infra-failures-are-defects rule (`.patterns/effect-errors.md`), applied
 * INSIDE the feature services via {@link orDieAccess} at layer build, never at
 * fate-handler call sites. Domain errors in the same union pass through untouched.
 */
export const orDieDrizzle = <A, E, R>(self: Effect.Effect<A, E, R>) =>
	Effect.catchIf(
		self,
		(e): e is E & DrizzleError => e instanceof DrizzleError,
		(e) => Effect.die(e),
	);

/** The tuple shape `[Stmt, ...Stmt[]]` preserves per-statement result inference end-to-end. */
export type Stmt = BatchItem<"sqlite">;

export type BatchResult<T extends Readonly<[Stmt, ...Stmt[]]>> = BatchResponse<T>;

export interface DrizzleAccess {
	readonly run: <A>(fn: (db: DrizzleDb) => Promise<A>) => Effect.Effect<A, DrizzleError>;

	/** D1's native batch API: every statement commits or none do. */
	readonly batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(
		fn: (db: DrizzleDb) => T,
	) => Effect.Effect<BatchResult<T>, DrizzleError>;
}

/**
 * Feature services destructure THIS, not {@link DrizzleAccess}, so every internal
 * DB call dies on infra failure and public method signatures carry domain errors
 * only (`.patterns/feature-services.md`).
 */
export interface DrizzleAccessOrDie {
	readonly run: <A>(fn: (db: DrizzleDb) => Promise<A>) => Effect.Effect<A>;
	readonly batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(
		fn: (db: DrizzleDb) => T,
	) => Effect.Effect<BatchResult<T>>;
}

export const orDieAccess = (access: DrizzleAccess): DrizzleAccessOrDie => ({
	run: (fn) => orDieDrizzle(access.run(fn)),
	batch: (fn) => orDieDrizzle(access.batch(fn)),
});

export class Drizzle extends Context.Service<Drizzle, DrizzleAccess>()("@kampus/Drizzle") {}

export const createDrizzle = (db: D1Database): DrizzleDb => drizzle(db, {relations});

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
 * `db` arrives as an argument so neither this layer nor its consumers read a
 * per-request `CloudflareEnv` (ADR 0029, `.patterns/fate-effect-worker-wiring.md`).
 */
export const makeDrizzleLayer = (db: DrizzleDb): Layer.Layer<Drizzle> =>
	Layer.succeed(Drizzle, makeDrizzleAccess(db));

/**
 * Both this layer and the better-auth adapter derive from the SAME `Database` tag,
 * so they share one underlying handle — the one-`sqlite` invariant is type-enforced
 * by the layer graph (`R = Database`), not test-owned (ADR 0040).
 */
export const DrizzleLive: Layer.Layer<Drizzle, never, Database> = Layer.effect(
	Drizzle,
	Effect.map(Database, (raw) => makeDrizzleAccess(createDrizzle(raw))),
);
