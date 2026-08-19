/**
 * `VouchLedger.castVouch` — the load-bearing concern is that the concurrent-vouch cap is
 * enforced *atomically with the insert*, not as a separable check-then-act. The cap check
 * and the insert compile to a single `INSERT … SELECT <values> WHERE (active-count
 * subquery) < cap`, so no concurrent vouch can interleave between the two.
 *
 * Proven by rendering `.toSQL()` over a no-op D1 — no engine, so this is a unit test;
 * real-D1 concurrency fidelity is the integration tier.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {
	Drizzle,
	type DrizzleAccess,
	type DrizzleDb,
	makeDrizzleAccess,
	relations,
	type Stmt,
} from "../../db/Drizzle.ts";
import {VOUCH_CONCURRENT_CAP} from "./standing.ts";
import {VouchLedger, VouchLedgerLive} from "./VouchLedger.ts";

// A real drizzle client over a no-op D1, used ONLY to render `.toSQL()`; it never executes.
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

// Captures the batch's two rendered statements and answers with a scripted result. `run` is
// fail-on-contact — `castVouch` must batch, never split the cap check into its own statement.
function capturingBatch(opts: {changes: number; existing: boolean}): {
	access: DrizzleAccess;
	statements: () => {sql: string; params: unknown[]}[];
} {
	const captured: {sql: string; params: unknown[]}[] = [];
	const access: DrizzleAccess = {
		run: () =>
			Effect.die(new Error("castVouch must not run a single statement — it batches the guard")),
		batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(fn: (db: DrizzleDb) => T) => {
			const stmts = fn(renderDb);
			for (const s of stmts) {
				// biome-ignore lint/plugin: drizzle's `BatchItem`/`Stmt` carries `.toSQL()` at runtime but doesn't expose it on the type; render it to assert the built SQL.
				const renderable = s as unknown as {toSQL: () => {sql: string; params: unknown[]}};
				captured.push(renderable.toSQL());
			}
			const result = [{meta: {changes: opts.changes}}, opts.existing ? [{voucherId: "v"}] : []];
			return Effect.succeed(result as never);
		},
	};
	return {access, statements: () => captured};
}

const ledgerOver = (access: DrizzleAccess) =>
	VouchLedgerLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

const castVouch = (cap: ReturnType<typeof capturingBatch>) =>
	Effect.gen(function* () {
		const ledger = yield* VouchLedger;
		return yield* ledger.castVouch({
			voucherId: "v",
			candidateId: "c",
			now: new Date(1_700_000_000_000),
		});
	}).pipe(Effect.provide(ledgerOver(cap.access)));

describe("VouchLedger.castVouch — the cap is enforced atomically with the insert", () => {
	it.effect("batches exactly two statements: the guarded insert + the existence probe", () => {
		const cap = capturingBatch({changes: 1, existing: true});
		return Effect.gen(function* () {
			yield* castVouch(cap);
			assert.strictEqual(cap.statements().length, 2, "guarded insert + existence probe");
		});
	});

	it.effect("the insert is a single `INSERT … SELECT … WHERE active_count < cap` guard", () => {
		const cap = capturingBatch({changes: 1, existing: true});
		return Effect.gen(function* () {
			yield* castVouch(cap);

			const insert = cap.statements()[0];
			assert.isTrue(insert !== undefined);
			if (insert === undefined) return;
			const sql = insert.sql.toLowerCase();
			// INSERT … SELECT … (not INSERT … VALUES) — the cap check rides inside the insert.
			assert.match(sql, /insert\s+into\s+"authorship_vouch"/);
			assert.match(sql, /select/);
			// the active-count subquery, tier-joined to `user` and bounded `< cap`.
			assert.match(sql, /count\(\*\)/);
			assert.match(sql, /inner\s+join\s+"user"/);
			assert.match(sql, /where\s*\(/); // the SELECT is gated on the count comparison
			assert.match(sql, /<\s*\?/); // … < cap (parameterized)
			assert.match(sql, /on\s+conflict\s+do\s+nothing/); // re-vouch idempotency stays in the table
			// the cap value and the çaylak tier filter are bound params of THIS one statement.
			assert.includeMembers(insert.params as unknown[], [VOUCH_CONCURRENT_CAP, "çaylak"]);
		});
	});

	it.effect("the existence probe keys the row by its composite PK (voucher, candidate)", () => {
		const cap = capturingBatch({changes: 0, existing: true});
		return Effect.gen(function* () {
			yield* castVouch(cap);
			const probe = cap.statements()[1];
			assert.isTrue(probe !== undefined);
			if (probe === undefined) return;
			const sql = probe.sql.toLowerCase();
			assert.match(sql, /select.*from\s+"authorship_vouch"/);
			assert.match(sql, /"voucher_id"/);
			assert.match(sql, /"candidate_id"/);
		});
	});

	it.effect("changes > 0 ⇒ recorded (a new vouch landed under the cap)", () =>
		Effect.gen(function* () {
			const {outcome} = yield* castVouch(capturingBatch({changes: 1, existing: true}));
			assert.strictEqual(outcome, "recorded");
		}),
	);

	it.effect("zero changes + the row exists ⇒ alreadyVouched (idempotent re-vouch)", () =>
		Effect.gen(function* () {
			const {outcome} = yield* castVouch(capturingBatch({changes: 0, existing: true}));
			assert.strictEqual(outcome, "alreadyVouched");
		}),
	);

	it.effect("zero changes + no row ⇒ capReached (the guard blocked a new vouch)", () =>
		Effect.gen(function* () {
			const {outcome} = yield* castVouch(capturingBatch({changes: 0, existing: false}));
			assert.strictEqual(outcome, "capReached");
		}),
	);
});

// Records the rendered `{sql, params}` the statement `.get()` prepares and binds, so a real
// drizzle read is captured at the binding boundary without an engine.
function capturingRun(): {
	access: DrizzleAccess;
	statement: () => {sql: string; params: unknown[]};
} {
	let captured: {sql: string; params: unknown[]} | undefined;
	// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; this records the prepared SQL/params, nothing executes.
	const capturingD1 = {
		prepare(sql: string) {
			const params: unknown[] = [];
			const record = () => {
				captured = {sql, params: [...params]};
			};
			return {
				bind(...p: unknown[]) {
					params.push(...p);
					return this;
				},
				async all() {
					record();
					return {results: []};
				},
				async first() {
					record();
					return null;
				},
				async run() {
					record();
					return {};
				},
				async raw() {
					record();
					return [];
				},
			};
		},
		async batch() {
			return [];
		},
	} as unknown as D1Database;
	const db = drizzle(capturingD1, {relations});
	const access: DrizzleAccess = makeDrizzleAccess(db);
	return {
		access,
		statement: () => {
			assert.isDefined(captured, "hasActiveFor never issued a read");
			return captured as {sql: string; params: unknown[]};
		},
	};
}

const hasActiveFor = (cap: ReturnType<typeof capturingRun>, candidateId: string) =>
	Effect.gen(function* () {
		const ledger = yield* VouchLedger;
		return yield* ledger.hasActiveFor(candidateId);
	}).pipe(Effect.provide(ledgerOver(cap.access)));

describe("VouchLedger.hasActiveFor — active is tier-filtered, symmetric with activeCountFor (#1324)", () => {
	// The behavioral contract — a yazar candidate whose only vouch row is leftover yields
	// `false` — is pinned structurally: the read inner-joins `user` and binds the `çaylak`
	// tier, so a `tier = 'yazar'` row drops out of the join, exactly as in `activeCountFor`.
	it.effect("the read inner-joins `user` and filters tier = 'çaylak' on the candidate", () => {
		const cap = capturingRun();
		return Effect.gen(function* () {
			yield* hasActiveFor(cap, "cand");
			const {sql, params} = cap.statement();
			const lower = sql.toLowerCase();
			assert.match(lower, /from\s+"authorship_vouch"/);
			// the tier-join to `user` — the symmetry with activeCountFor that excludes a yazar.
			assert.match(lower, /inner\s+join\s+"user"/);
			assert.match(lower, /"candidate_id"\s*=\s*\?/);
			// the candidate id and the çaylak tier are bound params of THIS one read.
			assert.includeMembers(params as unknown[], ["cand", "çaylak"]);
		});
	});
});
