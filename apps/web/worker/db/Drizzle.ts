/**
 * Drizzle service — the trust boundary between D1 and Effect-native feature code
 * (ADR 0011). The Tag's value is a `DrizzleAccess` record carrying two bound
 * methods, `run` and `batch`; they are NOT static effects on the class, because
 * that shape forced every caller's `R` channel to include `Drizzle`.
 *
 * Service idiom (`.patterns/feature-services.md`): destructure `{run, batch}` at
 * layer build, call them directly in method bodies — method types stay
 * `Effect<A, E, never>`, the dep is owned by the service layer.
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
 * `schema` alone — passing only `{schema}` leaves `db.query` empty (`{}`).
 * phoenix uses no cross-table `.with` traversal, so the single-arg
 * `defineRelations(schema)` (empty relations) is enough to register every table
 * so `db.query.<table>` is typed.
 */
export const relations = defineRelations(schema);

/** Carries both `schema` and `relations` generics so `db.query` and `db.select()` are typed. */
export type DrizzleDb = ReturnType<typeof drizzle<typeof schema, typeof relations>>;

/**
 * The schema-agnostic surface the FTS dual-write builders need: just
 * `delete`/`insert` against the FTS shim tables (`fts-sync.ts`), which carry their
 * own table arg and so don't depend on the db's schema generic. Both the worker's
 * full `DrizzleDb` and the backfill CLI's narrow-schema db satisfy it — so the
 * `@kampus/fts-backfill` consumer can replay the same builders without pulling the
 * worker's full schema graph (the preview-seed narrow-schema idiom).
 */
export type FtsSyncDb = Pick<DrizzleDb, "delete" | "insert">;

/**
 * Raised when a drizzle promise rejects inside `run` / `batch`. The `cause` is
 * preserved for logs but never reaches the user.
 */
export class DrizzleError extends Schema.TaggedErrorClass<DrizzleError>()("@kampus/Drizzle/Error", {
	cause: Schema.Defect(),
}) {}

/**
 * Collapse the `DrizzleError` channel into the defect channel — the
 * infra-failures-are-defects rule (`.patterns/effect-errors.md`). A
 * domain-boundary policy applied INSIDE the feature services (via
 * {@link orDieAccess} at layer build), not at fate-handler call sites: service
 * public signatures carry domain errors only, and the fate layer never names
 * Drizzle. Domain errors in the same union pass through untouched.
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

	/** Atomic multi-statement write via D1's native batch API: every statement commits or none do. */
	readonly batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(
		fn: (db: DrizzleDb) => T,
	) => Effect.Effect<BatchResult<T>, DrizzleError>;
}

/**
 * {@link DrizzleAccess} with the `DrizzleError` channel already collapsed into
 * the defect channel (via {@link orDieDrizzle}). Feature services destructure
 * THIS, so every internal DB call dies on infra failure and public method
 * signatures carry domain errors only (`.patterns/feature-services.md`).
 */
export interface DrizzleAccessOrDie {
	readonly run: <A>(fn: (db: DrizzleDb) => Promise<A>) => Effect.Effect<A>;
	readonly batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(
		fn: (db: DrizzleDb) => T,
	) => Effect.Effect<BatchResult<T>>;
}

/** The one construction site of the domain-boundary policy. */
export const orDieAccess = (access: DrizzleAccess): DrizzleAccessOrDie => ({
	run: (fn) => orDieDrizzle(access.run(fn)),
	batch: (fn) => orDieDrizzle(access.batch(fn)),
});

/**
 * @example
 *   const {run, batch} = yield* Drizzle;
 *   const term = yield* run((db) =>
 *     db.query.termSummary.findFirst({where: eq(schema.termSummary.slug, slug)}),
 *   );
 *
 * @example
 *   yield* batch((db) => [
 *     db.insert(schema.definitionVote).values({...}),
 *     db.update(schema.definitionRecord).set({...}).where(...),
 *   ] as const);
 */
export class Drizzle extends Context.Service<Drizzle, DrizzleAccess>()("@kampus/Drizzle") {}

/** The single place `drizzle(db, {schema, relations})` is called (worker init + tests). */
export const createDrizzle = (db: D1Database): DrizzleDb => drizzle(db, {schema, relations});

/**
 * The single home of the `run` / `batch` bodies — the promise → Effect boundary
 * and the tagged `DrizzleError` catch live here, in exactly one place.
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
 * Per ADR 0029 / `.patterns/fate-effect-worker-wiring.md`: the D1 binding is
 * stable for the isolate's life, so `drizzle()` is built ONCE in worker init and
 * provided as a worker-level layer. `db` arrives as an argument so neither this
 * layer nor its consumers read a per-request `CloudflareEnv`.
 */
export const makeDrizzleLayer = (db: DrizzleDb): Layer.Layer<Drizzle> =>
	Layer.succeed(Drizzle, makeDrizzleAccess(db));

/**
 * The `Drizzle` layer derived from the `Database` seam (ADR 0040). Because both
 * this layer and the better-auth adapter derive from the SAME `Database` tag,
 * they share one underlying handle — the one-`sqlite` invariant is type-enforced
 * by the layer graph (`R = Database`), not test-owned.
 */
export const DrizzleLive: Layer.Layer<Drizzle, never, Database> = Layer.effect(
	Drizzle,
	Effect.map(Database, (raw) => makeDrizzleAccess(createDrizzle(raw))),
);
