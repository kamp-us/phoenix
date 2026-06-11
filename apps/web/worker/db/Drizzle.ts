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
 * ADR 0011 records the decision.
 */
import type {BatchItem, BatchResponse} from "drizzle-orm/batch";
import {drizzle} from "drizzle-orm/d1";
import {defineRelations} from "drizzle-orm/relations";
import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {Database} from "../db/Database.ts";
import * as schema from "../db/drizzle/schema.ts";

/**
 * RQB v2 relations config (drizzle 1.0). The Relational Query Builder
 * (`db.query.<table>`) is now driven by a relations definition, not by `schema`
 * alone — passing only `{schema}` leaves `db.query` empty (`{}`). phoenix uses
 * no cross-table `.with` traversal, so the single-arg `defineRelations(schema)`
 * (empty relations) is enough: it registers every table so `db.query.<table>`
 * is typed again. Raw-SQL `where` (`and(eq(...))`) still works in RQB v2.
 */
export const relations = defineRelations(schema);

/**
 * The fully-typed drizzle builder phoenix uses everywhere. Built once per
 * isolate from the bound D1 handle (the `Database` seam). Carries both the
 * `schema` and `relations` generics (RQB v2) so `db.query.<table>` and
 * `db.select()` are both typed.
 */
export type DrizzleDb = ReturnType<typeof drizzle<typeof schema, typeof relations>>;

/**
 * Infrastructure error raised when a drizzle promise rejects inside
 * `run` / `batch`. Maps to `INTERNAL_SERVER_ERROR` at the resolver edge; the
 * `cause` is preserved for logs but never reaches the user.
 */
export class DrizzleError extends Schema.TaggedErrorClass<DrizzleError>()(
	"@phoenix/Drizzle/Error",
	{
		cause: Schema.Defect(),
	},
) {}

/**
 * Collapse the `DrizzleError` channel into the defect channel — the
 * infra-failures-are-defects rule (`.patterns/effect-errors.md`): a DB failure
 * is not a domain value, so it dies and `encodeWireError` maps the defect to
 * `INTERNAL_SERVER_ERROR` with a fixed message — `cause` reaches logs, never
 * the wire.
 *
 * This is a DOMAIN-BOUNDARY policy, applied INSIDE the feature services (via
 * {@link orDieAccess} at layer build) — not at the fate-handler call sites.
 * Service public signatures therefore carry domain errors only, and the fate
 * layer never names Drizzle. Domain errors in the same union pass through
 * untouched.
 */
export const orDieDrizzle = <A, E, R>(self: Effect.Effect<A, E, R>) =>
	Effect.catchIf(
		self,
		(e): e is E & DrizzleError => e instanceof DrizzleError,
		(e) => Effect.die(e),
	);

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
 * The domain-service view of {@link DrizzleAccess}: the same `run` / `batch`,
 * with the `DrizzleError` channel already collapsed into the defect channel at
 * the Drizzle call site itself (via {@link orDieDrizzle}). Feature services
 * destructure THIS at layer build (`const {run, batch} = orDieAccess(yield*
 * Drizzle)`), so every internal DB call dies on infra failure and the
 * services' public method signatures carry domain errors only — the boundary
 * rule in `.patterns/feature-services.md`.
 */
export interface DrizzleAccessOrDie {
	readonly run: <A>(fn: (db: DrizzleDb) => Promise<A>) => Effect.Effect<A>;
	readonly batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(
		fn: (db: DrizzleDb) => T,
	) => Effect.Effect<BatchResult<T>>;
}

/**
 * Wrap a {@link DrizzleAccess} so every `run` / `batch` dies on
 * `DrizzleError` instead of surfacing it as a typed failure. The one
 * construction site of the domain-boundary policy — services consume this;
 * the fate layer never sees the tech at all.
 */
export const orDieAccess = (access: DrizzleAccess): DrizzleAccessOrDie => ({
	run: (fn) => orDieDrizzle(access.run(fn)),
	batch: (fn) => orDieDrizzle(access.batch(fn)),
});

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
export const createDrizzle = (db: D1Database): DrizzleDb => drizzle(db, {schema, relations});

/**
 * Build a `DrizzleAccess` value over an already-constructed drizzle instance —
 * the single home of the `run` / `batch` bodies. {@link makeDrizzleLayer} wraps
 * this, so the promise → Effect boundary and the tagged `DrizzleError` catch
 * live in exactly one place.
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

/**
 * The `Drizzle` layer derived from the `Database` seam (ADR 0040).
 *
 * Reads the raw `D1Database` from the `Database` tag, builds the typed drizzle
 * instance with {@link createDrizzle}, and wraps the `run` / `batch` surface via
 * {@link makeDrizzleAccess}. Because both this layer and the better-auth adapter
 * derive from the SAME `Database` tag, feature services and auth are guaranteed
 * to share one underlying handle — the one-`sqlite` invariant is now
 * type-enforced by the layer graph (`R = Database`), not test-owned.
 *
 * This replaces the concrete-handle threading {@link makeDrizzleLayer} expressed:
 * the raw handle now lives behind the tag, not as a passed-in argument.
 */
export const DrizzleLive: Layer.Layer<Drizzle, never, Database> = Layer.effect(
	Drizzle,
	Effect.map(Database, (raw) => makeDrizzleAccess(createDrizzle(raw))),
);
