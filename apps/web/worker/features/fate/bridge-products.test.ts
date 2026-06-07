/**
 * fate bridge — data-plane parity for the remaining products (task 3, ADR 0029).
 *
 * Task 2 proved the worker-as-runtime seam on sozluk (see `bridge-sozluk.test.ts`).
 * This file ports the proof to **pano** (posts, comments), **pasaport** (profile,
 * `me`), **vote** (cross-product up-vote / retract), and **stats** (landingStats)
 * — every query, list, mutation, and source — driven through the SAME bridge via
 * {@link runFateOp}:
 *
 *   1. `Drizzle` + the feature services are built from a bound D1 (here a
 *      `node:sqlite` stand-in) via `makeFateLayer` — the worker init layer.
 *   2. Per "request" {@link runFateOp} provides only `Auth` + `HttpServerRequest`
 *      (plus the capturing `LiveBus` it owns), captures the live service map with
 *      `Effect.context<FateEnv>()`, and hands it to `fateServer.handleRequest`.
 *   3. The bridge runs each resolver with `Effect.provide(effect, ctx.context)`
 *      — nothing built or disposed per request.
 *
 * Asserts wire parity with the pre-migration `/fate` surface for these products:
 *   - pano: `posts(sort/host)` list, `post(idOrSlug)` detail + `Post.comments`
 *     keyset connection, post + comment mutations re-resolving the changed entity.
 *   - pasaport: `profile(username)` identity + counters + `Profile.contributions`
 *     discriminant feed, `me` (anon → UNAUTHORIZED, authed → row),
 *     `user.setUsername` round-trip.
 *   - vote: `post.vote` / `comment.vote` move the score and re-resolve the entity.
 *   - stats: `landingStats` returns the four counters + the build version.
 *
 * Runs in the node pool (no workerd) — same constraint as `bridge-sozluk.test.ts`.
 *
 * Per-test DB isolation: each `it` builds its own worker layer over a fresh
 * `node:sqlite` handle ({@link freshDb}) seeded identically, and closes it in
 * `afterEach`, so no rows leak across cases. Counts are therefore exact (the
 * previous file-order `>=` accumulation is gone).
 */
import {liveConnectionTopic, liveEntityTopic} from "@nkzw/fate/server";
import {Effect, Layer} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {Database} from "../../db/Database";
import {makeSqliteTestDb, type SqliteD1} from "../../db/sqlite-d1.testing";
import {Pano} from "../pano/Pano";
import {layerStub} from "../pasaport/better-auth.testing";
import {Pasaport} from "../pasaport/Pasaport";
import {makeFateLayer, type WorkerFateServices} from "./layers";
import {runFateOp} from "./run-fate-op";

const AUTHOR = {id: "u-author", name: "umut", email: "umut@example.com"};
const VOTER = {id: "u-voter", name: "elif", email: "elif@example.com"};
const BOOTSTRAP = {id: "u-bootstrap", name: "Ada Boot", email: "ada@example.com"};

/** The per-test in-memory D1; created in `beforeEach`, closed in `afterEach`. */
let sqlite: SqliteD1;
/** The per-test worker layer (Drizzle + features) over {@link sqlite}'s handle. */
let WorkerLive: Layer.Layer<WorkerFateServices>;
/** The seeded post id + its five chronological comment ids (per-test). */
let POST_ID = "";
const COMMENT_IDS: string[] = [];

/**
 * Build a fresh worker layer over a new `node:sqlite` handle, seed the three
 * users + one post + five comments + AUTHOR's username, and stash `POST_ID` /
 * `COMMENT_IDS`. `WorkerLive` wraps the SAME handle every `runFateOp` call hits
 * (`Layer.succeed(Database)(sqlite.d1)` over a shared object reference).
 */
async function freshDb(): Promise<void> {
	sqlite = makeSqliteTestDb();

	// `makeFateLayer` is a zero-arg layer with `R = Database | BetterAuth` (ADR
	// 0040). Provide the seam from the SAME handle the seeding below writes to
	// so features and seeding share one database — the one-`sqlite` invariant is
	// type-enforced. The stub `BetterAuth` is enough: these tests never reach the
	// session path (`Pasaport.validateSession`).
	WorkerLive = makeFateLayer.pipe(
		Layer.provide(Layer.merge(Layer.succeed(Database)(sqlite.d1), layerStub())),
	);

	// Seed users directly via raw SQL (better-auth owns `user` in prod; here the
	// node pool can't forge a session, so we insert the rows the services read).
	const nowSec = Math.floor(Date.now() / 1000);
	for (const u of [AUTHOR, VOTER, BOOTSTRAP]) {
		sqlite.applyMigration(
			`INSERT INTO user (id, name, email, type, created_at, updated_at)
			 VALUES ('${u.id}', '${u.name}', '${u.email}', 'human', ${nowSec}, ${nowSec});`,
		);
	}

	// Seed one post + five chronological comments through the live Pano service —
	// the same lifecycle a user-driven submit would take, so the view rows + stats
	// land identically. Give AUTHOR a username so the pasaport profile feed is a
	// mixed discriminant (post + comment).
	const seeded = await Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			const post = yield* pano.submitPost({
				title: "Bridge Post",
				url: "https://example.com/bridge",
				body: "bridge pano body",
				tags: [{kind: "tartışma"}, {kind: "soru"}],
				authorId: AUTHOR.id,
				authorName: AUTHOR.name,
			});
			const ids: string[] = [];
			for (let i = 0; i < 5; i++) {
				const c = yield* pano.addComment({
					postId: post.postId,
					authorId: AUTHOR.id,
					authorName: AUTHOR.name,
					body: `comment ${i} body — long enough`,
				});
				ids.push(c.commentId);
			}
			const pasaport = yield* Pasaport;
			yield* pasaport.setUsername({userId: AUTHOR.id, value: "umut-author"});
			return {postId: post.postId, commentIds: ids};
		}).pipe(Effect.provide(WorkerLive)),
	);
	POST_ID = seeded.postId;
	COMMENT_IDS.length = 0;
	COMMENT_IDS.push(...seeded.commentIds);
}

beforeEach(async () => {
	await freshDb();
});

afterEach(() => {
	sqlite?.close();
});

/* -------------------------------------------------------------------------- */
/* pano reads                                                                  */
/* -------------------------------------------------------------------------- */

describe("fate bridge — pano reads", () => {
	it("posts(hot) returns rows with id cursors", async () => {
		const {result} = await runFateOp(WorkerLive, {
			kind: "list",
			name: "posts",
			args: {sort: "hot"},
			select: ["id", "title", "score", "commentCount", "author"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			items: Array<{cursor: string; node: {id: string; title: string; commentCount: number}}>;
			pagination: {hasNext: boolean; hasPrevious: boolean};
		};
		const seeded = data.items.find((e) => e.node.id === POST_ID);
		expect(seeded).toBeDefined();
		expect(seeded!.cursor).toBe(POST_ID);
		expect(seeded!.node.title).toBe("Bridge Post");
		expect(seeded!.node.commentCount).toBe(5);
		expect(data.pagination.hasPrevious).toBe(false);
	});

	it("posts(host) filters by host", async () => {
		const {result} = await runFateOp(WorkerLive, {
			kind: "list",
			name: "posts",
			args: {sort: "new", host: "example.com"},
			select: ["id", "host"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {items: Array<{node: {id: string; host: string | null}}>};
		expect(data.items.length).toBeGreaterThan(0);
		expect(data.items.every((e) => e.node.host === "example.com")).toBe(true);
		expect(data.items.some((e) => e.node.id === POST_ID)).toBe(true);
	});

	it("post(idOrSlug) returns the detail row with tags", async () => {
		const {result} = await runFateOp(WorkerLive, {
			kind: "query",
			name: "post",
			args: {idOrSlug: POST_ID},
			select: ["id", "title", "url", "host", "score", "commentCount", "tags"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			id: string;
			title: string;
			host: string | null;
			commentCount: number;
			tags: Array<{kind: string; label: string}>;
		};
		expect(data.id).toBe(POST_ID);
		expect(data.title).toBe("Bridge Post");
		expect(data.host).toBe("example.com");
		expect(data.commentCount).toBe(5);
		expect(data.tags.map((t) => t.kind).sort()).toEqual(["soru", "tartışma"]);
	});

	it("post(idOrSlug) returns null for an unknown id", async () => {
		const {result} = await runFateOp(WorkerLive, {
			kind: "query",
			name: "post",
			args: {idOrSlug: "post_does_not_exist"},
			select: ["id"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBeNull();
	});

	it("Post.comments paginates by DB keyset with no skips/dupes across pages", async () => {
		const page1 = await runFateOp(WorkerLive, {
			kind: "query",
			name: "post",
			args: {idOrSlug: POST_ID, comments: {first: 2}},
			select: ["id", "comments.id", "comments.body"],
		});
		expect(page1.result.ok).toBe(true);
		if (!page1.result.ok) return;
		const d1 = page1.result.data as {
			comments: {
				items: Array<{cursor: string; node: {id: string}}>;
				pagination: {hasNext: boolean; nextCursor?: string};
			};
		};
		expect(d1.comments.items.map((e) => e.node.id)).toEqual(COMMENT_IDS.slice(0, 2));
		expect(d1.comments.pagination.hasNext).toBe(true);
		const cursor = d1.comments.pagination.nextCursor;
		expect(cursor).toBe(COMMENT_IDS[1]);

		const page2 = await runFateOp(WorkerLive, {
			kind: "query",
			name: "post",
			args: {idOrSlug: POST_ID, comments: {first: 2, after: cursor}},
			select: ["id", "comments.id"],
		});
		expect(page2.result.ok).toBe(true);
		if (!page2.result.ok) return;
		const d2 = page2.result.data as {
			comments: {items: Array<{node: {id: string}}>; pagination: {nextCursor?: string}};
		};
		expect(d2.comments.items.map((e) => e.node.id)).toEqual(COMMENT_IDS.slice(2, 4));

		const page3 = await runFateOp(WorkerLive, {
			kind: "query",
			name: "post",
			args: {idOrSlug: POST_ID, comments: {first: 2, after: d2.comments.pagination.nextCursor}},
			select: ["id", "comments.id"],
		});
		expect(page3.result.ok).toBe(true);
		if (!page3.result.ok) return;
		const d3 = page3.result.data as {
			comments: {items: Array<{node: {id: string}}>; pagination: {hasNext: boolean}};
		};
		expect(d3.comments.items.map((e) => e.node.id)).toEqual([COMMENT_IDS[4]]);
		expect(d3.comments.pagination.hasNext).toBe(false);

		const allIds = [
			...d1.comments.items.map((e) => e.node.id),
			...d2.comments.items.map((e) => e.node.id),
			...d3.comments.items.map((e) => e.node.id),
		];
		expect(new Set(allIds).size).toBe(5);
		expect([...allIds].sort()).toEqual([...COMMENT_IDS].sort());
	});

	it("Comment nodes carry the author/authorId/myVote scalar surface", async () => {
		const {result} = await runFateOp(WorkerLive, {
			kind: "query",
			name: "post",
			args: {idOrSlug: POST_ID, comments: {first: 1}},
			select: [
				"comments.id",
				"comments.author",
				"comments.authorId",
				"comments.score",
				"comments.myVote",
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const node = (result.data as {comments: {items: Array<{node: Record<string, unknown>}>}})
			.comments.items[0]!.node;
		expect(node.author).toBe(AUTHOR.name);
		expect(node.authorId).toBe(AUTHOR.id);
		expect(node.score).toBe(0);
		expect(node.myVote).toBeNull();
	});
});

/* -------------------------------------------------------------------------- */
/* pano mutations + vote                                                       */
/* -------------------------------------------------------------------------- */

describe("fate bridge — pano mutations + vote round-trip", () => {
	it("post.submit round-trips and the post re-resolves over the bridge", async () => {
		const add = await runFateOp(
			WorkerLive,
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "Submitted via bridge", body: "a body", tags: [{kind: "soru"}]},
				select: ["id", "title", "score", "author", "authorId"],
			},
			{auth: AUTHOR},
		);
		expect(add.result.ok).toBe(true);
		if (!add.result.ok) return;
		const created = add.result.data as {id: string; title: string; score: number; authorId: string};
		expect(created.id).toBeTruthy();
		expect(created.title).toBe("Submitted via bridge");
		expect(created.score).toBe(0);
		expect(created.authorId).toBe(AUTHOR.id);

		const reread = await runFateOp(WorkerLive, {
			kind: "query",
			name: "post",
			args: {idOrSlug: created.id},
			select: ["id", "title", "score"],
		});
		expect(reread.result.ok).toBe(true);
		if (!reread.result.ok) return;
		expect((reread.result.data as {id: string; title: string}).title).toBe("Submitted via bridge");
	});

	it("comment.add round-trips and the changed parent re-resolves over the bridge", async () => {
		const add = await runFateOp(
			WorkerLive,
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId: POST_ID, body: "added via bridge — long enough"},
				select: ["id", "body", "author", "authorId"],
			},
			{auth: AUTHOR},
		);
		expect(add.result.ok).toBe(true);
		if (!add.result.ok) return;
		const created = add.result.data as {id: string; body: string; authorId: string};
		expect(created.id).toBeTruthy();
		expect(created.authorId).toBe(AUTHOR.id);

		// Re-resolve the parent post: commentCount now reflects the added comment,
		// and the new comment is in the Post.comments connection.
		const reread = await runFateOp(WorkerLive, {
			kind: "query",
			name: "post",
			args: {idOrSlug: POST_ID, comments: {first: 50}},
			select: ["id", "commentCount", "comments.id", "comments.body"],
		});
		expect(reread.result.ok).toBe(true);
		if (!reread.result.ok) return;
		const post = reread.result.data as {
			commentCount: number;
			comments: {items: Array<{node: {id: string; body: string}}>};
		};
		expect(post.commentCount).toBe(6);
		expect(post.comments.items.some((e) => e.node.id === created.id)).toBe(true);
		// The append targets `Post.comments` scoped to the parent post — the publish
		// must reach the ARGS-scoped topic, not the global wildcard (ADR 0039).
		expect(add.published).toContain(liveConnectionTopic("Post.comments", {id: POST_ID}));
		expect(add.published).not.toContain("connection:Post.comments:*");
	});

	it("post.vote publishes to the Post entity topic (ADR 0039)", async () => {
		const vote = await runFateOp(
			WorkerLive,
			{kind: "mutation", name: "post.vote", input: {id: POST_ID}, select: ["id", "score"]},
			{auth: VOTER},
		);
		expect(vote.result.ok).toBe(true);
		if (!vote.result.ok) return;
		expect(vote.published).toEqual([liveEntityTopic("Post", POST_ID)]);
	});

	it("post.vote moves the score and re-resolves the post (vote service)", async () => {
		const vote = await runFateOp(
			WorkerLive,
			{
				kind: "mutation",
				name: "post.vote",
				input: {id: POST_ID},
				select: ["id", "score", "myVote"],
			},
			{auth: VOTER},
		);
		expect(vote.result.ok).toBe(true);
		if (!vote.result.ok) return;
		const voted = vote.result.data as {id: string; score: number; myVote: number | null};
		expect(voted.id).toBe(POST_ID);
		expect(voted.score).toBe(1);
		expect(voted.myVote).toBe(1);

		// Re-cast is idempotent; retract returns score to 0.
		const retract = await runFateOp(
			WorkerLive,
			{
				kind: "mutation",
				name: "post.retractVote",
				input: {id: POST_ID},
				select: ["id", "score", "myVote"],
			},
			{auth: VOTER},
		);
		expect(retract.result.ok).toBe(true);
		if (!retract.result.ok) return;
		const retracted = retract.result.data as {score: number; myVote: number | null};
		expect(retracted.score).toBe(0);
		expect(retracted.myVote).toBeNull();
	});

	it("comment.vote moves the comment score and re-resolves it (vote service)", async () => {
		const target = COMMENT_IDS[0]!;
		const vote = await runFateOp(
			WorkerLive,
			{
				kind: "mutation",
				name: "comment.vote",
				input: {id: target},
				select: ["id", "score", "myVote"],
			},
			{auth: VOTER},
		);
		expect(vote.result.ok).toBe(true);
		if (!vote.result.ok) return;
		const voted = vote.result.data as {id: string; score: number; myVote: number | null};
		expect(voted.id).toBe(target);
		expect(voted.score).toBe(1);
		expect(voted.myVote).toBe(1);
	});

	it("a write gated by Auth.required fails anonymously → UNAUTHORIZED", async () => {
		const {result} = await runFateOp(WorkerLive, {
			kind: "mutation",
			name: "post.vote",
			input: {id: POST_ID},
			select: ["id"],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});
});

/* -------------------------------------------------------------------------- */
/* pasaport reads + mutations                                                  */
/* -------------------------------------------------------------------------- */

describe("fate bridge — pasaport", () => {
	it("me anonymous → UNAUTHORIZED, authed → the full user row", async () => {
		const anon = await runFateOp(WorkerLive, {kind: "query", name: "me", select: ["id"]});
		expect(anon.result.ok).toBe(false);
		if (anon.result.ok) return;
		expect(anon.result.error.code).toBe("UNAUTHORIZED");

		const authed = await runFateOp(
			WorkerLive,
			{kind: "query", name: "me", select: ["id", "email", "username"]},
			{auth: AUTHOR},
		);
		expect(authed.result.ok).toBe(true);
		if (!authed.result.ok) return;
		const me = authed.result.data as {id: string; email: string; username: string | null};
		expect(me.id).toBe(AUTHOR.id);
		expect(me.email).toBe(AUTHOR.email);
		// username was set during seeding.
		expect(me.username).toBe("umut-author");
	});

	it("profile(username) returns identity + live-aggregated counters", async () => {
		const {result} = await runFateOp(WorkerLive, {
			kind: "query",
			name: "profile",
			args: {username: "umut-author"},
			select: ["userId", "username", "displayName", "postCount", "commentCount"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			userId: string;
			username: string;
			displayName: string | null;
			postCount: number;
			commentCount: number;
		};
		expect(data.userId).toBe(AUTHOR.id);
		expect(data.username).toBe("umut-author");
		expect(data.displayName).toBe(AUTHOR.name);
		// AUTHOR authored exactly the seeded post + 5 comments (fresh DB per test).
		expect(data.postCount).toBe(1);
		expect(data.commentCount).toBe(5);
	});

	it("profile(username) returns null for an unknown username", async () => {
		const {result} = await runFateOp(WorkerLive, {
			kind: "query",
			name: "profile",
			args: {username: "no-such-user-99999"},
			select: ["userId"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBeNull();
	});

	it("Profile.contributions is a discriminant feed (kind per node, keyset cursor)", async () => {
		const {result} = await runFateOp(WorkerLive, {
			kind: "query",
			name: "profile",
			args: {username: "umut-author", contributions: {first: 50}},
			select: ["username", "contributions.kind", "contributions.id", "contributions.postId"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			contributions: {items: Array<{cursor: string; node: {kind: string; id: string}}>};
		};
		expect(data.contributions.items.length).toBeGreaterThanOrEqual(6);
		const kinds = new Set(data.contributions.items.map((e) => e.node.kind));
		expect(kinds.has("post")).toBe(true);
		expect(kinds.has("comment")).toBe(true);
		for (const e of data.contributions.items) {
			expect(e.cursor).toMatch(/^\d+:.+$/);
		}
	});

	it("user.setUsername round-trips and re-resolves the User entity", async () => {
		const set = await runFateOp(
			WorkerLive,
			{
				kind: "mutation",
				name: "user.setUsername",
				input: {value: "ada-boot"},
				select: ["id", "username", "email"],
			},
			{auth: BOOTSTRAP},
		);
		expect(set.result.ok).toBe(true);
		if (!set.result.ok) return;
		const user = set.result.data as {id: string; username: string; email: string};
		expect(user.id).toBe(BOOTSTRAP.id);
		expect(user.username).toBe("ada-boot");

		// Re-resolve via me: the freshly-set username round-trips.
		const me = await runFateOp(
			WorkerLive,
			{kind: "query", name: "me", select: ["id", "username"]},
			{auth: BOOTSTRAP},
		);
		expect(me.result.ok).toBe(true);
		if (!me.result.ok) return;
		expect((me.result.data as {username: string}).username).toBe("ada-boot");
	});
});

/* -------------------------------------------------------------------------- */
/* stats                                                                       */
/* -------------------------------------------------------------------------- */

describe("fate bridge — stats", () => {
	it("landingStats returns the four counters plus the build version", async () => {
		const {result} = await runFateOp(WorkerLive, {
			kind: "query",
			name: "landingStats",
			select: ["id", "totalDefinitions", "totalPosts", "totalComments", "totalAuthors", "version"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			id: string;
			totalPosts: number;
			totalComments: number;
			totalAuthors: number;
			version: string;
		};
		expect(data.id).toBe("landing");
		expect(data.totalPosts).toBeGreaterThanOrEqual(1);
		expect(data.totalComments).toBeGreaterThanOrEqual(1);
		expect(data.totalAuthors).toBeGreaterThanOrEqual(1);
		expect(data.version).toBe("v0.3");
	});
});
