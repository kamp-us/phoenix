/**
 * `Pasaport.setDisplayName` — the görünen-ad write-through (#2154). The load-bearing
 * correctness concern is LOCKSTEP: the better-auth field the settings surface reads
 * (`user.name`) and the stamped column every author byline reads
 * (`user_profile.display_name`) move in ONE atomic D1 batch, so they can never
 * diverge — the one-shot-sync defect this closes (display_name was written only at
 * `setUsername`-time and never re-synced).
 *
 * Proven by rendering the batch's `.toSQL()` over a no-op D1 (the
 * `promotion-sweep.unit.test.ts` idiom) — no engine, so this is a unit test; the
 * execute-and-read-back byline convergence over real D1 is the integration tier
 * (`tests/integration/pasaport.test.ts`).
 *
 * This test fails WITHOUT the write-through: with no `setDisplayName` the service
 * shape doesn't compile, and a write that touched only `user.name` (the old
 * `authClient.updateUser` path) would emit a single statement, never the
 * `user_profile.display_name` write this pins.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Cause, Effect, Exit, Layer} from "effect";
import {
	Drizzle,
	type DrizzleAccess,
	type DrizzleDb,
	relations,
	type Stmt,
} from "../../db/Drizzle.ts";
import {DisplayNameEmpty} from "./errors.ts";
import {type BetterAuthInstance, makePasaportLive, Pasaport} from "./Pasaport.ts";

// A real drizzle client over a no-op D1 — used ONLY to render the batch statements'
// `.toSQL()`; it never executes (the `promotion-sweep.unit.test.ts` renderer).
// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; nothing here executes against it.
const noopD1 = {
	prepare: () => ({
		bind() {
			return this;
		},
		async all() {
			return {results: []};
		},
		async first() {
			return null;
		},
		async run() {
			return {};
		},
		async raw() {
			return [];
		},
	}),
	async batch() {
		return [];
	},
} as unknown as D1Database;
const renderDb = drizzle(noopD1, {relations});

const inertAuth = {} as BetterAuthInstance;

// A `run` that replays the single `user.findFirst` read the method makes before the
// batch, and a `batch` that captures the rendered statements. `existingUser` scripts
// the pre-read (null ⇒ the UserNotFound path, which never reaches the batch).
function capturing(
	existingUser: {id: string; username: string | null; image: string | null} | null,
): {
	access: DrizzleAccess;
	statements: () => {sql: string; params: unknown[]}[];
} {
	const captured: {sql: string; params: unknown[]}[] = [];
	const access: DrizzleAccess = {
		run: (<A>(_fn: (db: DrizzleDb) => Promise<A>) => {
			// The only `run` the method issues is the pre-batch existence read; script it.
			return Effect.succeed(existingUser as A);
		}) as DrizzleAccess["run"],
		batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(fn: (db: DrizzleDb) => T) => {
			const stmts = fn(renderDb);
			for (const s of stmts) {
				// biome-ignore lint/plugin: drizzle's `Stmt` carries `.toSQL()` at runtime but doesn't expose it on the type; render it to assert the built SQL.
				const renderable = s as unknown as {toSQL: () => {sql: string; params: unknown[]}};
				captured.push(renderable.toSQL());
			}
			return Effect.succeed(stmts.map(() => ({})) as never);
		},
	};
	return {access, statements: () => captured};
}

const pasaportOver = (access: DrizzleAccess) =>
	makePasaportLive(inertAuth).pipe(Layer.provide(Layer.succeed(Drizzle, access)));

const existing = {id: "u-1", username: "ada", image: null};

describe("Pasaport.setDisplayName — lockstep display-name write-through (#2154)", () => {
	it.effect("writes user.name AND user_profile.display_name in ONE batch (lockstep)", () => {
		const cap = capturing(existing);
		return Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			const result = yield* pasaport.setDisplayName({userId: "u-1", value: "Yeni Ad"});
			assert.strictEqual(result.displayName, "Yeni Ad");

			const stmts = cap.statements();
			assert.strictEqual(stmts.length, 2, "one user.name update + one user_profile upsert");

			const userUpdate = stmts[0];
			const profileUpsert = stmts[1];
			assert.isTrue(userUpdate !== undefined && profileUpsert !== undefined);
			if (!userUpdate || !profileUpsert) return;

			// Statement 0: the better-auth `user.name` write the settings surface reads.
			const u = userUpdate.sql.toLowerCase();
			assert.match(u, /update\s+"user"/);
			assert.match(u, /"name"\s*=\s*\?/);
			assert.include(userUpdate.params as unknown[], "Yeni Ad");

			// Statement 1: the STAMPED column every author byline reads — the write that
			// was missing before this fix. An upsert (insert…on conflict) so a user with
			// no profile row still gets a populated display_name.
			const p = profileUpsert.sql.toLowerCase();
			assert.match(p, /insert\s+into\s+"user_profile"/);
			assert.match(p, /on\s+conflict/);
			assert.match(p, /"display_name"\s*=/);
			assert.include(profileUpsert.params as unknown[], "Yeni Ad");
		}).pipe(Effect.provide(pasaportOver(cap.access)));
	});

	it.effect("the conflict upsert preserves username — sets display_name + updated_at only", () => {
		const cap = capturing(existing);
		return Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			yield* pasaport.setDisplayName({userId: "u-1", value: "Yeni Ad"});
			const upsert = cap.statements()[1];
			assert.isTrue(upsert !== undefined);
			if (!upsert) return;
			const sql = upsert.sql.toLowerCase();
			// The ON CONFLICT SET clause names display_name + updated_at, never username —
			// a rename must not blank the immutable handle.
			const setClause = sql.slice(sql.indexOf("on conflict"));
			assert.match(setClause, /"display_name"\s*=/);
			assert.match(setClause, /"updated_at"\s*=/);
			assert.notMatch(setClause, /set[\s\S]*"username"\s*=/);
		}).pipe(Effect.provide(pasaportOver(cap.access)));
	});

	it.effect("an empty/whitespace value fails with DisplayNameEmpty and writes nothing", () => {
		const cap = capturing(existing);
		return Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			const exit = yield* pasaport.setDisplayName({userId: "u-1", value: "   "}).pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) {
				const error = Cause.findErrorOption(exit.cause);
				assert.isTrue(error._tag === "Some");
				if (error._tag === "Some") {
					assert.isTrue(error.value instanceof DisplayNameEmpty);
				}
			}
			// The blank floor short-circuits before the pre-read and the batch — no write.
			assert.strictEqual(cap.statements().length, 0);
		}).pipe(Effect.provide(pasaportOver(cap.access)));
	});
});
