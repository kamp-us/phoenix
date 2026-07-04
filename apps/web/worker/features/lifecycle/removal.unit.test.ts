/**
 * The removal SUBSTRATE ({@link Removal.removeEntity}/{@link Removal.restoreEntity}, #1129)
 * driven directly through its own `RemovalSequence` port — the interface-level coverage the
 * substrate lacked (#2017). Its headline invariants (ADR 0096 §3, ADR 0080) were asserted only
 * by prose and exercised indirectly through the plane callers; the caller-side ceremony that
 * wraps it (`apply-removal-transition.unit.test.ts`, #2012) uses an INERT `RemovalSequence`, so
 * nothing drove the substrate's own ordering / batch-shape / FTS decisions.
 *
 * The port is purpose-built for substitution, so this substitutes a RECORDING `RemovalSequence`
 * — the `Vote.clearTarget`-batch-shape idiom (`vote/Vote.unit.test.ts`) crossed with the
 * `.toSQL()` render double (`sozluk/persist-term-summary.unit.test.ts`, ADR 0082/0104/0105: no
 * engine, no revived `node:sqlite` fake). Every `run`/`batch` builder is invoked against a
 * `drizzle(noopD1)` so the produced statements render to real SQL, and every call (including
 * `clearTarget`) is appended to one ordered event stream. That lets us assert THROUGH the
 * interface:
 *
 *   (a) `clearTarget` (the vote wipe, karma KEPT) fires BEFORE any content stamp on a remove,
 *       and NOT AT ALL on a restore (ADR 0096 §3/§4);
 *   (b) `post` routes via `batch` (stamp + FTS lockstep, ADR 0080) while `comment`/`definition`
 *       route via a single `run` (FTS-free);
 *   (c) a `post` restore re-enters `post_search` FROM the title (delete + insert bound to it),
 *       a `post` remove drops it (delete only) — the FTS re-entry is asymmetric by direction;
 *   (d) an illegal transition intent is unrepresentable (title-less post restore / a title on a
 *       comment restore / a stray kind do not typecheck).
 *
 * Row-level fidelity on real D1 (the batch actually commits all-or-none) stays the integration
 * tier's job; this proves the substrate ASKS the port for the right shape, in the right order.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect} from "effect";
import {expectTypeOf} from "vitest";
import {type DrizzleDb, relations} from "../../db/Drizzle.ts";
import type {TargetKind} from "../../db/target-kind.ts";
import * as Removal from "./removal.ts";

const now = new Date("2026-07-04T00:00:00.000Z");

// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; only `.toSQL()` rendering is exercised — the recording `run`/`batch` never execute a query.
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

type Rendered = {sql: string; params: unknown[]};

// One ordered event per port call. `clearTarget` records the (kind,id) the vote wipe targets;
// `run`/`batch` record the mode + the rendered SQL of every statement the builder produced, so
// the ordering, the run-vs-batch routing, and the FTS shape are all readable off `events`.
type Event =
	| {readonly op: "clearTarget"; readonly kind: TargetKind; readonly id: string}
	| {readonly op: "run"; readonly stmts: ReadonlyArray<Rendered>}
	| {readonly op: "batch"; readonly stmts: ReadonlyArray<Rendered>};

const render = (stmt: unknown): Rendered =>
	// drizzle's `BatchItem`/`Stmt` carries `.toSQL()` at runtime but doesn't expose it on the type.
	(stmt as {toSQL: () => Rendered}).toSQL();

// A recording `RemovalSequence`: the substrate calls it exactly as it would the real Drizzle
// seam, but every builder is rendered instead of executed and every call is appended to `events`.
const recordingSeq = () => {
	const events: Event[] = [];
	const seq: Removal.RemovalSequence = {
		clearTarget: (kind, id) =>
			Effect.sync(() => {
				events.push({op: "clearTarget", kind, id});
			}),
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) =>
			Effect.sync(() => {
				// `run` takes a single-statement builder; render it as a one-element list so the
				// two modes share one shape. The substrate's `run` builder returns the drizzle
				// statement synchronously (it's `db.update(...)`), never a resolved promise — we
				// render its `.toSQL()`, we do not execute the query.
				const stmt = fn(renderDb as never) as unknown;
				events.push({op: "run", stmts: [render(stmt)]});
				return undefined as A;
			}),
		batch: <T extends Readonly<[unknown, ...unknown[]]>>(fn: (db: DrizzleDb) => T) =>
			Effect.sync(() => {
				const stmts = fn(renderDb as never) as ReadonlyArray<unknown>;
				events.push({op: "batch", stmts: stmts.map(render)});
				return [] as never;
			}),
	};
	return {seq, events};
};

// The stamped-columns a caller loads from `Lifecycle.remove(...)`/`restore(...)` and hands the
// substrate. The substrate does not compute these — it writes whatever it is given — so a fixed
// pair suffices; the ordering/shape is what varies by intent.
const removedColumns: Removal.RemovalColumns = {
	removedAt: now,
	removedBy: "mod-1",
	removedReason: Removal.encodeReason(new Removal.AuthorDeletion()),
	sandboxedAt: null,
};
const liveColumns: Removal.RemovalColumns = {
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: null,
};

const POST_TITLE = "Kelime Başlık";

describe("removeEntity — clearTarget-before-stamp ordering (ADR 0096 §3)", () => {
	for (const kind of ["post", "comment", "definition"] as const) {
		it.effect(`${kind}: the vote wipe fires BEFORE the content stamp`, () =>
			Effect.gen(function* () {
				const {seq, events} = recordingSeq();
				yield* Removal.removeEntity(seq, {kind, id: `${kind}-1`}, removedColumns, now);

				assert.strictEqual(events.length, 2, "exactly a clearTarget then a single write");
				assert.strictEqual(
					events[0]?.op,
					"clearTarget",
					"clearTarget is FIRST — the vote wipe precedes the stamp",
				);
				const first = events[0];
				if (first?.op === "clearTarget") {
					assert.strictEqual(first.kind, kind, "the vote wipe targets the entity's own kind");
					assert.strictEqual(first.id, `${kind}-1`);
				}
				assert.notStrictEqual(
					events[1]?.op,
					"clearTarget",
					"the second event is the content write, not a second wipe",
				);
			}),
		);
	}
});

describe("restoreEntity — no vote wipe (ADR 0096 §4: votes are not resurrected)", () => {
	for (const target of [
		{kind: "post", id: "post-1", title: POST_TITLE},
		{kind: "comment", id: "comment-1"},
		{kind: "definition", id: "definition-1"},
	] as const) {
		it.effect(`${target.kind}: restore NEVER calls clearTarget`, () =>
			Effect.gen(function* () {
				const {seq, events} = recordingSeq();
				yield* Removal.restoreEntity(seq, target, liveColumns, now);

				assert.isFalse(
					events.some((e) => e.op === "clearTarget"),
					"a restore does not touch votes — the wipe is remove-only",
				);
				assert.strictEqual(events.length, 1, "a restore is one content write, nothing else");
			}),
		);
	}
});

describe("removeEntity / restoreEntity — per-kind write routing (batch vs run, ADR 0080)", () => {
	it.effect("post routes the stamp through a BATCH (stamp + FTS lockstep)", () =>
		Effect.gen(function* () {
			const {seq, events} = recordingSeq();
			yield* Removal.removeEntity(seq, {kind: "post", id: "post-1"}, removedColumns, now);
			assert.strictEqual(
				events[1]?.op,
				"batch",
				"post's stamp + FTS move all-or-none in one batch",
			);
		}),
	);

	for (const kind of ["comment", "definition"] as const) {
		it.effect(`${kind} (FTS-free) routes the stamp through a single RUN, never a batch`, () =>
			Effect.gen(function* () {
				const {seq, events} = recordingSeq();
				yield* Removal.removeEntity(seq, {kind, id: `${kind}-1`}, removedColumns, now);
				assert.strictEqual(
					events[1]?.op,
					"run",
					`${kind} has no search row — a single update, no batch`,
				);
			}),
		);
	}

	it.effect("post restore routes through a batch; comment/definition restore through a run", () =>
		Effect.gen(function* () {
			const post = recordingSeq();
			yield* Removal.restoreEntity(
				post.seq,
				{kind: "post", id: "post-1", title: POST_TITLE},
				liveColumns,
				now,
			);
			assert.strictEqual(post.events[0]?.op, "batch", "post restore re-enters FTS ⇒ batch");

			const comment = recordingSeq();
			yield* Removal.restoreEntity(
				comment.seq,
				{kind: "comment", id: "comment-1"},
				liveColumns,
				now,
			);
			assert.strictEqual(comment.events[0]?.op, "run", "comment restore is FTS-free ⇒ single run");

			const definition = recordingSeq();
			yield* Removal.restoreEntity(
				definition.seq,
				{kind: "definition", id: "definition-1"},
				liveColumns,
				now,
			);
			assert.strictEqual(
				definition.events[0]?.op,
				"run",
				"definition restore is FTS-free ⇒ single run",
			);
		}),
	);
});

describe("post FTS lockstep — remove drops the search row, restore re-enters it FROM the title", () => {
	it.effect("post remove batch = stamp + a post_search DELETE (row dropped, not re-indexed)", () =>
		Effect.gen(function* () {
			const {seq, events} = recordingSeq();
			yield* Removal.removeEntity(seq, {kind: "post", id: "post-1"}, removedColumns, now);
			const batch = events[1];
			assert.strictEqual(batch?.op, "batch");
			if (batch?.op === "batch") {
				assert.strictEqual(
					batch.stmts.length,
					2,
					"exactly two statements: the record stamp + the FTS drop",
				);
				assert.match(
					batch.stmts[0]?.sql ?? "",
					/update .*post_record/i,
					"first statement stamps post_record",
				);
				assert.match(
					batch.stmts[1]?.sql ?? "",
					/delete from .*post_search/i,
					"second statement drops the FTS row",
				);
				// A remove indexes nothing new — no INSERT into post_search, so the title never appears.
				assert.isFalse(
					batch.stmts.some((s) => /insert into .*post_search/i.test(s.sql)),
					"a remove re-indexes nothing — no post_search INSERT",
				);
			}
		}),
	);

	it.effect(
		"post restore batch = stamp + a DELETE + an INSERT binding the title (FTS re-entered)",
		() =>
			Effect.gen(function* () {
				const {seq, events} = recordingSeq();
				yield* Removal.restoreEntity(
					seq,
					{kind: "post", id: "post-1", title: POST_TITLE},
					liveColumns,
					now,
				);
				const batch = events[0];
				assert.strictEqual(batch?.op, "batch");
				if (batch?.op === "batch") {
					assert.strictEqual(
						batch.stmts.length,
						3,
						"three statements: the record stamp + FTS delete-then-insert upsert",
					);
					assert.match(
						batch.stmts[0]?.sql ?? "",
						/update .*post_record/i,
						"first statement clears the triad on post_record",
					);
					assert.match(
						batch.stmts[1]?.sql ?? "",
						/delete from .*post_search/i,
						"the upsert deletes the stale FTS row first",
					);
					const insert = batch.stmts[2];
					assert.match(
						insert?.sql ?? "",
						/insert into .*post_search/i,
						"then re-inserts the FTS row",
					);
					// The re-indexed norm is derived FROM the title the caller passed — the restore
					// re-enters search from the title (not from a stale/empty value). The title is
					// normalized before binding, so assert the bound param derives from POST_TITLE.
					assert.isTrue(
						(insert?.params ?? []).some(
							(p) => typeof p === "string" && p.includes("kelime") && p.includes("baslik"),
						),
						"the re-indexed FTS param is the normalized title the restore was handed",
					);
				}
			}),
	);
});

describe("removeEntity / restoreEntity — illegal transitions are unrepresentable (compile-time)", () => {
	it("a post restore without its title does not typecheck; a comment restore with a title does not either", () => {
		const {seq} = recordingSeq();
		// A post restore MUST carry the title its FTS row is rebuilt from.
		// @ts-expect-error — a title-less post restore is missing `title`.
		void Removal.restoreEntity(seq, {kind: "post", id: "p1"}, liveColumns, now);
		// The FTS-free kinds carry NO title — a title on a comment restore is not part of the intent.
		// @ts-expect-error — `title` is not a member of a comment `RestoreTarget`.
		void Removal.restoreEntity(seq, {kind: "comment", id: "c1", title: "x"}, liveColumns, now);
		// A stray kind is not a valid target at all.
		// @ts-expect-error — "reaction" is not a removable entity kind.
		void Removal.removeEntity(seq, {kind: "reaction", id: "r1"}, removedColumns, now);

		// The intent unions admit exactly the three kinds — the tag is the discriminant.
		expectTypeOf<Removal.RemoveTarget["kind"]>().toEqualTypeOf<"post" | "comment" | "definition">();
		expectTypeOf<Removal.RestoreTarget["kind"]>().toEqualTypeOf<
			"post" | "comment" | "definition"
		>();
		assert.ok(true);
	});
});
