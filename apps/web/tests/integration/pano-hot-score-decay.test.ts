/**
 * pano sıcak/hot decay-refresh → the AC4 end-to-end guard for #2027.
 *
 * The bug (#2027): `post_record.hot_score` is a STORED, keyset-read integer written only at
 * activity sites, so the age term of the HN gravity formula freezes the instant a post stops
 * getting activity — an inactive post keeps a "young, high" score forever and squats the hot
 * feed. `Pano.refreshHotScores` re-decays the stored column for every live non-draft post
 * (WINDOWLESS since #2133), with no read-time recompute (the keyset cursor and SQLite's
 * missing `POW` both need `hot_score` stored and indexed).
 *
 * No HTTP route triggers the cron on a deployed worker, so — like `fts-backfill` (#645) —
 * this drives the real method against this stage's real D1 REST target. Per-file
 * `integrationStack`, so the direct-D1 refresh and the feed reads see one isolated table.
 */
import {Effect} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import {createDrizzle, makeDrizzleAccess, orDieAccess} from "../../worker/db/Drizzle.ts";
import {computeHotScore} from "../../worker/db/hotScore.ts";
import {makeRefreshHotScores} from "../../worker/features/pano/post-operations.ts";
import {makeIntegrationD1Rest} from "./_cf-rest-transport.ts";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

interface PostNode {
	id: string;
	title: string;
	host: string | null;
	score: number;
	commentCount: number;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

// One per-file host so `posts(host, sort:"hot")` scopes to exactly this test's rows —
// the isolation the ordered feed assertion needs (mirrors pano-read's host-scoping).
const HOST = `hot-decay-${Date.now().toString(36)}.example.com`;

const HOUR_MS = 3_600_000;

let author: {userId: string; cookie: string};
let voter: {userId: string; cookie: string};

async function seedPost(title: string): Promise<string> {
	const r = await h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {
				title,
				url: `https://${HOST}/${title.replace(/\s+/g, "-")}`,
				tags: [{kind: "tartışma"}],
			},
			select: ["id"],
		},
		{cookie: author.cookie},
	);
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error(`seedPost(${title}) failed`);
	return (r.data as PostNode).id;
}

/** Post ids in feed (rank) order. */
async function hotFeedIds(): Promise<string[]> {
	const feed = await h.fate({
		kind: "list",
		name: "posts",
		args: {sort: "hot", host: HOST, first: 50},
		select: ["id", "host", "score", "commentCount"],
	});
	expect(feed.ok).toBe(true);
	if (!feed.ok) throw new Error("hot feed read failed");
	return (feed.data as Connection<PostNode>).items.map((e) => e.node.id);
}

async function readPost(id: string): Promise<{score: number; commentCount: number}> {
	const r = await h.fate({
		kind: "query",
		name: "post",
		args: {idOrSlug: id},
		select: ["id", "score", "commentCount"],
	});
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error(`readPost(${id}) failed`);
	const node = r.data as PostNode;
	return {score: node.score, commentCount: node.commentCount};
}

/**
 * The shipped worker code path bound to this stage's real remote D1, never a
 * re-implementation of its query. `refreshHotScores` reads only `run`, so it builds
 * standalone without the full `PostOperationsDeps` graph.
 */
async function realRefreshHotScores() {
	const target = await h.d1Target();
	const db = createDrizzle(makeIntegrationD1Rest(target));
	const access = orDieAccess(makeDrizzleAccess(db));
	return makeRefreshHotScores(access.run);
}

beforeAll(async () => {
	author = await h.signUp("hot-decay-author@test.local", "hunter2hunter2", "hot-decay-yazar");
	// The fresher post is voted below by a non-author (`voter`) — self-voting is blocked
	// (#2216) — to earn its young-high frozen score. A fresh account is a çaylak rejected at
	// cast (#1810's "earn to vote" gate), so promote both.
	voter = await h.signUp("hot-decay-voter@test.local", "hunter2hunter2", "hot-decay-oycu");
	await h.promoteToYazar(author.userId);
	await h.promoteToYazar(voter.userId);
});

describe("pano sıcak/hot decay-refresh (#2027 AC4) — the stored-column read → window → write-back", () => {
	it("an aged post's hot rank drops below a fresher post after a refresh, with no activity write", async () => {
		const staleId = await seedPost("stale-hot-post");
		const fresherId = await seedPost("fresher-hot-post");

		// Voting at age≈0 earns a young-high stored score through the live activity path:
		// score 1 → `hot_score = computeHotScore(1, now, now)` = 287.
		const voted = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id: fresherId}, select: ["id", "score"]},
			{cookie: voter.cookie},
		);
		expect(voted.ok).toBe(true);
		if (!voted.ok) return;
		expect((voted.data as PostNode).score).toBe(1);

		// Construct the exact #2027/#2133 bug state on the stale post via the setup-only D1 REST
		// seam (the write clock + frozen-score the public mutation seam can't set): a HIGHER score
		// (5), a `hot_score` FROZEN at the young value it would have had at age≈0
		// (`computeHotScore(5, t, t)` = 1436), and a `created_at` aged 17 DAYS into the past — far
		// OUTSIDE the OLD 72h window (`decayWindowMs`, dropped in #2133) that used to gate the
		// refresh, so a windowed refresh would never have re-selected this row (the #2133 freeze).
		// `created_at` is `integer(mode:"timestamp")`, stored as whole epoch SECONDS. So pre-refresh
		// the OLD post's frozen 1436 outranks the fresher post's 287 — a stale post squatting #1.
		const nowMs = Date.now();
		const staleCreatedSec = Math.floor((nowMs - 17 * 24 * HOUR_MS) / 1000);
		const staleFrozenHot = computeHotScore(5, nowMs, nowMs); // young-high, frozen at age≈0
		const changed = await h.execD1(
			"UPDATE post_record SET score = ?, hot_score = ?, created_at = ? WHERE id = ?",
			[5, staleFrozenHot, staleCreatedSec, staleId],
		);
		expect(changed).toBe(1);

		const before = await hotFeedIds();
		const staleBefore = before.indexOf(staleId);
		const fresherBefore = before.indexOf(fresherId);
		expect(staleBefore).toBeGreaterThanOrEqual(0);
		expect(fresherBefore).toBeGreaterThanOrEqual(0);
		expect(staleBefore).toBeLessThan(fresherBefore); // stale ranks ABOVE fresher (the bug)

		// Grounded in the same formula the refresh applies, not intuition: re-decayed at 17 days
		// the stale score falls below the fresher one, so the refresh MUST flip the order.
		const staleDecayed = computeHotScore(5, staleCreatedSec * 1000, nowMs);
		const fresherYoung = computeHotScore(1, nowMs, nowMs);
		expect(staleDecayed).toBeLessThan(fresherYoung);

		// The #2133 guard: the 17-day stale post is far outside the old 72h window, so a windowed
		// refresh would never have selected it; the windowless pass re-decays it here.
		const refreshHotScores = await realRefreshHotScores();
		const result = await Effect.runPromise(refreshHotScores(new Date(nowMs)));
		expect(result.scanned).toBeGreaterThanOrEqual(2);
		expect(result.updated).toBeGreaterThanOrEqual(1);

		const after = await hotFeedIds();
		const staleAfter = after.indexOf(staleId);
		const fresherAfter = after.indexOf(fresherId);
		expect(staleAfter).toBeGreaterThanOrEqual(0);
		expect(fresherAfter).toBeGreaterThanOrEqual(0);
		expect(fresherAfter).toBeLessThan(staleAfter); // fresher now ranks ABOVE stale (fixed)

		// A vote/comment write — the only pre-fix way a score refreshed — would have moved
		// these, so unchanged scalars prove decay rewrote `hot_score` alone.
		const stalePost = await readPost(staleId);
		expect(stalePost.score).toBe(5);
		expect(stalePost.commentCount).toBe(0);
	});
});
