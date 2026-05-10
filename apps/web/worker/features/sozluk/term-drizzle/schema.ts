/**
 * Per-term DO sqlite schema for `SozlukTerm extends Agent<Env, TermState>`.
 *
 * Each DO instance owns one term; addressed by `idFromName(slug)`. The DO
 * namespace name (`this.name`) is the slug, so `term_meta` is single-row and
 * `definition` rows do NOT carry `term_id` — every row in this DO belongs to
 * the term whose slug is the DO's name.
 *
 * Lineage:
 * - ADR 0005 (per-coordination-atom sharding) — singleton → per-term DOs.
 * - ADR 0006 (Agent base class) — `setState` is the canonical state hook.
 * - ADR 0007 (outbox + Workflows + D1 view layer) — `outbox` table here is
 *   the durability primitive: every mutation writes a row in the same
 *   `transactionSync` block; `flushOutbox` ships it to `PHOENIX_PROJECTION`.
 *
 * NOTE: this lives next to `Sozluk.ts`'s legacy schema (under `drizzle/`)
 * during the T2 → T18 migration window. The legacy directory ships the old
 * singleton `term`/`definition` tables; this directory ships the per-term
 * shape. T18 deletes the old class + directory under `delete_classes`.
 */
import {id} from "@usirin/forge";
import {integer, primaryKey, sqliteTable, text} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, {mode: "timestamp"});

const timestamps = {
	createdAt: timestamp("created_at").$defaultFn(() => new Date()),
	updatedAt: timestamp("updated_at").$defaultFn(() => new Date()),
};

/**
 * Single-row table holding the term's metadata. There is only ever one row
 * per DO instance (the DO's name is the term slug); we do NOT store the slug
 * here — `this.name` is the canonical slug.
 *
 * Rows are upserted on first write (e.g. `addDefinition` creating the term
 * implicitly). Reads MUST go through the DO's `getTerm()` method which fans
 * out to `definition` and applies the deleted-at filter.
 */
export const termMeta = sqliteTable("term_meta", {
	// Always the literal string '1' — the row is a singleton.
	id: text("id").primaryKey().default("1"),
	title: text("title").notNull(),
	...timestamps,
});

/**
 * Per-definition row. `termId` is intentionally omitted: every definition in
 * this DO belongs to this DO's term. `authorId` references Pasaport's user
 * table; storage isolation makes the FK un-enforced — `authorName` is
 * denormalized so the read path never has to cross-DO call.
 *
 * Soft-delete via `deletedAt`: read paths (`getTerm`) filter
 * `WHERE deleted_at IS NULL`. Edit/delete mutations land in T6.
 */
export const definition = sqliteTable("definition", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => id("def")),
	authorId: text("author_id").notNull(),
	authorName: text("author_name").notNull(),
	body: text("body").notNull(),
	score: integer("score").notNull().default(0),
	deletedAt: timestamp("deleted_at"),
	...timestamps,
});

/**
 * Composite-PK vote table; one row per (definition, voter). Voting is up-only
 * for MVP — presence = upvoted, absence = no vote. Vote mutations land in T5.
 *
 * Score on `definition.score` is denormalized: recomputed inside the same
 * `transactionSync` as the vote insert/delete.
 */
export const definitionVote = sqliteTable(
	"definition_vote",
	{
		definitionId: text("definition_id").notNull(),
		voterId: text("voter_id").notNull(),
		createdAt: timestamp("created_at").$defaultFn(() => new Date()),
	},
	(t) => [primaryKey({columns: [t.definitionId, t.voterId]})],
);

/**
 * Outbox: durability primitive per ADR 0007. Mutation methods write a row
 * here in the same `transactionSync` block as the mutation; `flushOutbox`
 * dispatches the payload to `PHOENIX_PROJECTION` and deletes the row on
 * success. `eventId` is a forge ULID — lex-sortable for in-order replay,
 * idempotent as the workflow instance id.
 *
 * `payload` is JSON-encoded `ProjectionEvent` (see `worker/view/PhoenixProjection.ts`).
 */
export const outbox = sqliteTable("outbox", {
	eventId: text("event_id").primaryKey(),
	payload: text("payload").notNull(),
	createdAt: integer("created_at").notNull(),
});
