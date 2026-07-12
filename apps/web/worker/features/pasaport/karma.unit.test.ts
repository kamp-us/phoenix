/**
 * `karmaBumpStatements` — pasaport's `KarmaBump` implementation (#2592). Proves the
 * two co-committed statements by rendering their `.toSQL()` over a no-op D1 (the
 * `promotion-sweep.unit.test.ts` / `set-display-name.unit.test.ts` idiom) — no engine,
 * so this is a unit test; the execute-and-read-back over real D1 is the integration
 * tier (`tests/integration/pasaport.test.ts` drives the same batch via `totalKarma`).
 *
 * The load-bearing correctness concern is that every bump emits BOTH a `total_karma`
 * UPDATE and a `karma_event` INSERT carrying the same signed delta — so a delta can't
 * land without its provenance row, and `SUM(karma_event.delta)` reconciles to
 * `total_karma`. A retraction is a NEGATIVE-delta INSERT, never a deletion (append-only).
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {relations, type Stmt} from "../../db/Drizzle.ts";
import {targetTable} from "../../db/target-table.ts";
import type {KarmaBumpInput} from "../vote/Vote.ts";
import {karmaBumpStatements} from "./karma.ts";

// A real drizzle client over a no-op D1 — used ONLY to render statements' `.toSQL()`.
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

const render = (s: Stmt) =>
	// biome-ignore lint/plugin: drizzle's `Stmt`/`BatchItem` carries `.toSQL()` at runtime but doesn't expose it on the type; render it to assert the built SQL.
	(s as unknown as {toSQL: () => {sql: string; params: unknown[]}}).toSQL();

// The pre-mutation vote-change guard the real batch threads in (`targetTable[kind]`),
// so these render tests exercise the SAME guard SQL production sees, not a stand-in.
const guardFor = (kind: "definition" | "post" | "comment", targetId: string, isCast: boolean) =>
	targetTable[kind].voteChangeGuard(renderDb, targetId, "voter-1", isCast);

describe("karmaBumpStatements — the bump + its append-only ledger row (#2592)", () => {
	it("a cast (+1) emits the total_karma bump AND a matching karma_event INSERT", () => {
		const input: KarmaBumpInput = {
			recipientId: "author-1",
			delta: 1,
			source: {kind: "definition", id: "def-1"},
			reason: "vote",
			at: new Date("2026-01-02T03:04:05Z"),
			guard: guardFor("definition", "def-1", true),
		};
		const stmts = karmaBumpStatements(renderDb, input);
		assert.strictEqual(stmts.length, 2, "exactly two statements: bump + event");

		const bump = render(stmts[0]);
		assert.match(bump.sql, /update .*user_profile.* set .*total_karma/i);
		assert.include(bump.params, "author-1", "bump targets the recipient");
		assert.include(bump.params, 1, "bump adds the delta");
		// A cast bumps only if the vote row does NOT yet exist (#2552).
		assert.match(bump.sql, /where.*not exists.*select.*definition_vote/is);

		const event = render(stmts[1]);
		assert.match(event.sql, /insert into .*karma_event/i);
		// The ledger row is gated by the SAME guard — it can't land without the delta.
		assert.match(event.sql, /not exists.*select.*definition_vote/is);
		assert.include(event.params, "author-1", "event.user_id is the recipient");
		assert.include(event.params, 1, "event.delta is the signed delta");
		assert.include(event.params, "definition", "event.source_kind");
		assert.include(event.params, "def-1", "event.source_id");
		assert.include(event.params, "vote", "event.reason");
	});

	it("a retraction (-1) records a NEGATIVE-delta event with reason 'retract' (append-only)", () => {
		const input: KarmaBumpInput = {
			recipientId: "author-1",
			delta: -1,
			source: {kind: "post", id: "post-9"},
			reason: "retract",
			at: new Date("2026-01-02T03:04:05Z"),
			guard: guardFor("post", "post-9", false),
		};
		const stmts = karmaBumpStatements(renderDb, input);
		const bump = render(stmts[0]);
		// A retract debits only if the vote row STILL exists (the mirror of the cast guard, #2552).
		assert.match(bump.sql, /where.*(?<!not )exists.*select.*post_vote/is);
		const event = render(stmts[1]);
		assert.match(event.sql, /insert into .*karma_event/i);
		assert.match(event.sql, /(?<!not )exists.*select.*post_vote/is);
		assert.include(event.params, -1, "a retraction is a negative delta, not a deletion");
		assert.include(event.params, "retract", "event.reason distinguishes the retraction");
		assert.include(event.params, "post", "event.source_kind carries the target");
		assert.include(event.params, "post-9", "event.source_id carries the target");
	});

	it("the bump delta and the event delta are the SAME value — they can't diverge", () => {
		// The reconciliation invariant at the statement level: `total_karma += delta` and
		// `karma_event.delta = delta` read the one `input.delta`, so SUM(events) tracks the
		// accumulator by construction (#2592).
		for (const delta of [1, -1]) {
			const stmts = karmaBumpStatements(renderDb, {
				recipientId: "u",
				delta,
				source: {kind: "comment", id: "c-1"},
				reason: delta > 0 ? "vote" : "retract",
				at: new Date(0),
				guard: guardFor("comment", "c-1", delta > 0),
			});
			assert.include(render(stmts[0]).params, delta, "bump carries the delta");
			assert.include(render(stmts[1]).params, delta, "event carries the same delta");
		}
	});
});

describe("karmaBumpStatements — the pre-mutation guard blocks a raced double-bump (#2552)", () => {
	// The double-bump defect: `Vote.castImpl` probes idempotency OUTSIDE the batch, so two
	// concurrent identical casts both see `alreadyCast=false` and both run the batch. Before
	// #2552 the karma UPDATE was unconditional, so `total_karma` bumped twice (and a second
	// ledger row landed). The fix gates BOTH statements on `input.guard` — the vote row's
	// PRE-mutation presence — and Vote orders the pair ahead of the vote write. Here we prove
	// the statement-level invariant that makes the second cast a no-op: bump and event carry
	// the SAME `NOT EXISTS(vote row)` predicate, so they commit together or not at all.
	it("bump AND event are gated by the identical vote-row predicate — they can't diverge", () => {
		const stmts = karmaBumpStatements(renderDb, {
			recipientId: "author-1",
			delta: 1,
			source: {kind: "definition", id: "def-1"},
			reason: "vote",
			at: new Date("2026-01-02T03:04:05Z"),
			guard: guardFor("definition", "def-1", true),
		});
		// The one guard subquery, keyed on the exact vote row (target + voter) whose presence
		// decides whether the cast changed state, appears verbatim in BOTH statements — so a
		// duplicate that finds the row present writes neither the delta nor the ledger row.
		const subquery = 'not exists (select 1 from "definition_vote"';
		assert.include(render(stmts[0]).sql, subquery, "the bump is gated on the vote row");
		assert.include(render(stmts[1]).sql, subquery, "the ledger row is gated by the same predicate");
		for (const stmt of stmts) {
			assert.include(render(stmt).params, "def-1", "guard keys on the target");
			assert.include(render(stmt).params, "voter-1", "guard keys on the voter");
		}
	});
});
