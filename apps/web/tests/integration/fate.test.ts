/**
 * fate data-plane integration — black-box over HTTP against the deployed worker.
 *
 * Covers the pre-migration behavioral surface (ADR 0015–0020) end-to-end through
 * the real `/fate` route on a local workerd: sözlük / pano / pasaport / vote /
 * stats queries, lists, mutations, re-resolution, and wire-error parity. Replaces
 * the old `@cloudflare/vitest-pool-workers` suites — every assertion is an HTTP
 * round-trip against `h.url()` (no in-process service layers, no `env.PHOENIX_DB`).
 *
 * The worker is deployed once by `_global-setup.ts`; the D1 is shared across this
 * file, so each test uses unique slugs / emails to stay independent.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {harness} from "./_harness.ts";

const h = harness();

/** A signed-up author reused across mutation tests. */
let author: {userId: string; cookie: string};

beforeAll(async () => {
	author = await h.signUp(`author-${Date.now()}@test.local`, "hunter2hunter2", "yazar");
});

describe("fate seam", () => {
	it("health resolves data produced by a service method (D1-backed)", async () => {
		const result = await h.fate({
			kind: "query",
			name: "health",
			select: ["status", "definitions"],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			const data = result.data as {status: string; definitions: number};
			expect(data.status).toBe("ok");
			expect(typeof data.definitions).toBe("number");
		}
	});

	it("an anonymous `me` serializes as UNAUTHORIZED", async () => {
		const result = await h.fate({kind: "query", name: "me", select: ["id"]});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED");
	});
});

describe("sozluk", () => {
	const SLUG = "fate-it-sozluk-read";

	beforeAll(async () => {
		await h.seedTerm({
			slug: SLUG,
			title: "Fate IT Read",
			definitions: [
				{authorId: "u1", authorName: "umut", body: "alpha", score: 50},
				{authorId: "u2", authorName: "elif", body: "beta", score: 40},
				{authorId: "u3", authorName: "ada", body: "gamma", score: 30},
				{authorId: "u4", authorName: "deniz", body: "delta", score: 20},
				{authorId: "u5", authorName: "kaan", body: "epsilon", score: 10},
			],
		});
	});

	it("terms(recent) returns the seeded term with a slug cursor", async () => {
		const result = await h.fate({
			kind: "list",
			name: "terms",
			args: {sort: "recent"},
			select: ["slug", "title", "count", "totalScore"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			items: Array<{cursor: string; node: {slug: string; title: string; count: number}}>;
		};
		const seeded = data.items.find((e) => e.node.slug === SLUG);
		expect(seeded).toBeDefined();
		expect(seeded!.cursor).toBe(SLUG);
		expect(seeded!.node.count).toBe(5);
	});

	it("term(slug) returns detail counters; unknown slug → null", async () => {
		const found = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: SLUG},
			select: ["slug", "title", "count", "totalScore"],
		});
		expect(found.ok).toBe(true);
		if (found.ok) {
			const data = found.data as {slug: string; count: number; totalScore: number};
			expect(data.slug).toBe(SLUG);
			expect(data.count).toBe(5);
			expect(data.totalScore).toBe(150);
		}

		const missing = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: "no-such-term"},
			select: ["slug"],
		});
		expect(missing.ok).toBe(true);
		if (missing.ok) expect(missing.data).toBeNull();
	});

	it("definition.add writes and re-resolves; vote/retract move score; edit; empty body → BODY_REQUIRED", async () => {
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: "fate-it-mut", termTitle: "Fate IT Mut", body: "an added definition"},
				select: ["id", "body", "author", "authorId", "score", "myVote"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const def = added.data as {
			id: string;
			body: string;
			author: string;
			authorId: string;
			score: number;
			myVote: number | null;
		};
		expect(def.body).toBe("an added definition");
		expect(def.author).toBe("yazar");
		expect(def.authorId).toBe(author.userId);
		expect(def.score).toBe(0);
		expect(def.myVote).toBeNull();

		const voted = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id: def.id}, select: ["score", "myVote"]},
			{cookie: author.cookie},
		);
		expect(voted.ok && (voted.data as {score: number}).score).toBe(1);
		expect(voted.ok && (voted.data as {myVote: number}).myVote).toBe(1);

		const retracted = await h.fate(
			{
				kind: "mutation",
				name: "definition.retractVote",
				input: {id: def.id},
				select: ["score", "myVote"],
			},
			{cookie: author.cookie},
		);
		expect(retracted.ok && (retracted.data as {score: number}).score).toBe(0);
		expect(retracted.ok && (retracted.data as {myVote: number | null}).myVote).toBeNull();

		const edited = await h.fate(
			{
				kind: "mutation",
				name: "definition.edit",
				input: {id: def.id, body: "after edit"},
				select: ["id", "body"],
			},
			{cookie: author.cookie},
		);
		expect(edited.ok && (edited.data as {body: string}).body).toBe("after edit");

		const empty = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: "fate-it-mut", body: "   "},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.error.code).toBe("BODY_REQUIRED");
	});

	it("anonymous definition.add → UNAUTHORIZED", async () => {
		const res = await h.fate({
			kind: "mutation",
			name: "definition.add",
			input: {termSlug: "anon", body: "nope"},
			select: ["id"],
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe("UNAUTHORIZED");
	});
});

describe("pano", () => {
	it("post.submit writes + re-resolves; comment.add bumps commentCount; vote/retract move score", async () => {
		const submitted = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "a submitted post", tags: [{kind: "tartışma"}]},
				select: [
					"id",
					"title",
					"author",
					"authorId",
					"score",
					"commentCount",
					"myVote",
					"tags.kind",
				],
			},
			{cookie: author.cookie},
		);
		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;
		const post = submitted.data as {
			id: string;
			title: string;
			author: string;
			score: number;
			commentCount: number;
			tags: Array<{kind: string}>;
		};
		expect(post.title).toBe("a submitted post");
		expect(post.author).toBe("yazar");
		expect(post.score).toBe(0);
		expect(post.commentCount).toBe(0);
		expect(post.tags.map((t) => t.kind)).toEqual(["tartışma"]);

		const commented = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId: post.id, body: "a comment"},
				select: ["id", "body"],
			},
			{cookie: author.cookie},
		);
		expect(commented.ok).toBe(true);

		const reread = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: post.id},
			select: ["id", "commentCount"],
		});
		expect(reread.ok && (reread.data as {commentCount: number}).commentCount).toBe(1);

		const voted = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id: post.id}, select: ["score", "myVote"]},
			{cookie: author.cookie},
		);
		expect(voted.ok && (voted.data as {score: number}).score).toBe(1);

		const retracted = await h.fate(
			{kind: "mutation", name: "post.retractVote", input: {id: post.id}, select: ["score"]},
			{cookie: author.cookie},
		);
		expect(retracted.ok && (retracted.data as {score: number}).score).toBe(0);
	});

	it("posts(hot) returns a connection envelope with id cursors", async () => {
		const result = await h.fate({
			kind: "list",
			name: "posts",
			args: {sort: "hot"},
			select: ["id", "title"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			items: Array<{cursor: string; node: {id: string}}>;
			pagination: {hasNext: boolean};
		};
		expect(Array.isArray(data.items)).toBe(true);
		expect(data.pagination).toBeDefined();
		if (data.items.length) expect(data.items[0]!.cursor).toBeTruthy();
	});
});

describe("pasaport", () => {
	it("me resolves the signed-up user with a cookie; user.setUsername round-trips", async () => {
		const me = await h.fate({kind: "query", name: "me", select: ["id"]}, {cookie: author.cookie});
		expect(me.ok).toBe(true);
		if (me.ok) expect((me.data as {id: string}).id).toBe(author.userId);

		// Username constraints: 3–30 chars, `[a-z0-9]` + interior `-` only (no `_`).
		const username = `yazar-${Date.now().toString(36)}`;
		// The mutation input field is `value` (ADR 0020 — `Pasaport.setUsername({value})`).
		const set = await h.fate(
			{
				kind: "mutation",
				name: "user.setUsername",
				input: {value: username},
				select: ["id", "username"],
			},
			{cookie: author.cookie},
		);
		expect(set.ok).toBe(true);

		const profile = await h.fate({
			kind: "query",
			name: "profile",
			args: {username},
			select: ["username"],
		});
		expect(profile.ok).toBe(true);
		if (profile.ok) expect((profile.data as {username: string}).username).toBe(username);
	});
});

describe("stats", () => {
	it("landingStats returns the four counters + build version", async () => {
		const result = await h.fate({
			kind: "query",
			name: "landingStats",
			select: ["totalDefinitions", "totalPosts", "totalComments", "totalAuthors", "version"],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			const data = result.data as {
				totalDefinitions: number;
				totalPosts: number;
				version: string;
			};
			expect(typeof data.totalDefinitions).toBe("number");
			expect(typeof data.totalPosts).toBe("number");
			expect(data.version).toBe("v0.3");
		}
	});
});
