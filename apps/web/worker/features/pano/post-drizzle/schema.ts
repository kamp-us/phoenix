/**
 * Per-post DO sqlite schema for `PanoPost extends Agent<Env, PostState>`.
 *
 * Each DO instance owns one post; addressed by `idFromName(postId)`. The DO
 * namespace name (`this.name`) is the post id, so `post_meta` is single-row,
 * and `tag` / `comment` rows do NOT carry `post_id` — every row in this DO
 * belongs to the post whose id is the DO's name.
 *
 * Lineage:
 * - ADR 0005 (per-coordination-atom sharding) — singleton → per-post DOs.
 * - ADR 0006 (Agent base class) — `setState` is the canonical state hook.
 * - ADR 0007 (outbox + Workflows + D1 view layer) — `outbox` table here is
 *   the durability primitive: every mutation writes a row in the same
 *   `transactionSync` block; `flushOutbox` ships it to `PHOENIX_PROJECTION`.
 *
 * NOTE: this lives next to `Pano.ts`'s legacy schema (under `drizzle/`)
 * during the T3 → T18 migration window. The legacy directory ships the old
 * singleton `post`/`comment`/etc. tables; this directory ships the per-post
 * shape. T18 deletes the old class + directory under `delete_classes`.
 */
import {id} from "@usirin/forge";
import {
	type AnySQLiteColumn,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, {mode: "timestamp"});

const timestamps = {
	createdAt: timestamp("created_at").$defaultFn(() => new Date()),
	updatedAt: timestamp("updated_at").$defaultFn(() => new Date()),
};

/**
 * Single-row table holding the post's metadata. There is only ever one row
 * per DO instance (the DO's name is the post id); we do NOT store the id
 * here — `this.name` is the canonical id.
 *
 * Rows are upserted on first write (e.g. `submitPost` creating the post in
 * T7). `host` is denormalized from `url` on insert so the host-filtered feed
 * is a simple `WHERE host = ?` rather than a per-row parse.
 *
 * Soft-delete via `deletedAt`: read paths (`getPost`) filter
 * `WHERE deleted_at IS NULL`. Edit/delete mutations land in T9.
 */
export const postMeta = sqliteTable("post_meta", {
	// Always the literal string '1' — the row is a singleton.
	id: text("id").primaryKey().default("1"),
	slug: text("slug"),
	title: text("title").notNull(),
	url: text("url"),
	host: text("host"),
	body: text("body"),
	authorId: text("author_id").notNull(),
	authorName: text("author_name").notNull(),
	score: integer("score").notNull().default(0),
	commentCount: integer("comment_count").notNull().default(0),
	deletedAt: timestamp("deleted_at"),
	...timestamps,
});

/**
 * Tags belong to this post. `postId` omitted: every row in this DO belongs
 * to this DO's post. Uniqueness across `kind` is a write-time concern
 * enforced when post creation lands (T7).
 */
export const tag = sqliteTable("tag", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => id("tag")),
	kind: text("kind").notNull(),
	label: text("label").notNull(),
});

/**
 * Per-comment row. `postId` is intentionally omitted: every comment in this
 * DO belongs to this DO's post. `parentId` is a self-ref for nested replies.
 *
 * `score` is denormalized: recomputed inside the same `transactionSync` as
 * the vote insert/delete (T11). Soft-delete via `deletedAt`.
 */
export const comment = sqliteTable(
	"comment",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => id("comm")),
		parentId: text("parent_id").references((): AnySQLiteColumn => comment.id, {
			onDelete: "cascade",
		}),
		authorId: text("author_id").notNull(),
		authorName: text("author_name").notNull(),
		body: text("body").notNull(),
		score: integer("score").notNull().default(0),
		deletedAt: timestamp("deleted_at"),
		...timestamps,
	},
	(c) => [index("comment_parent_id_idx").on(c.parentId)],
);

/**
 * Composite-PK vote table: one row per (post, voter). Per-DO scoping makes
 * `post_id` redundant for storage — every row in this DO belongs to the post
 * named `this.name` — but the literal `(post_id, voter_id)` PK keeps the
 * table shape symmetric with `definition_vote` and `comment_vote`, and lets
 * future flatten/migrate paths read the table without DO context.
 *
 * Voting is up-only for MVP — presence = upvoted, absence = no vote. Score on
 * `post_meta.score` is denormalized: recomputed inside the same
 * `transactionSync` as the vote insert/delete (T8).
 */
export const postVote = sqliteTable(
	"post_vote",
	{
		postId: text("post_id").notNull(),
		voterId: text("voter_id").notNull(),
		createdAt: timestamp("created_at").$defaultFn(() => new Date()),
	},
	(t) => [primaryKey({columns: [t.postId, t.voterId]})],
);

/**
 * Composite-PK comment vote table; one row per (comment, voter). Voting is
 * up-only — presence = upvoted, absence = no vote. Vote mutations land in T11.
 */
export const commentVote = sqliteTable(
	"comment_vote",
	{
		commentId: text("comment_id").notNull(),
		voterId: text("voter_id").notNull(),
		createdAt: timestamp("created_at").$defaultFn(() => new Date()),
	},
	(t) => [primaryKey({columns: [t.commentId, t.voterId]})],
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
