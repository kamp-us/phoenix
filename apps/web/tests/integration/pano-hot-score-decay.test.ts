/**
 * pano sıcak/hot decay-refresh → the AC4 end-to-end guard for #2027.
 *
 * The bug (#2027): `post_record.hot_score` is a STORED, keyset-read integer written
 * only at activity sites (create/vote/comment), so the age term of the HN gravity
 * formula freezes the instant a post stops getting activity — an inactive post keeps
 * a "young, high" score forever and squats the hot feed above genuinely fresher rows.
 * The fix is `Pano.refreshHotScores` (`post-operations.ts`), driven periodically by
 * the cron trigger (`hot-score-decay-cron.ts`): re-decay the stored column over the
 * recency window, WITHOUT a read-time recompute (the keyset-cursor contract + the
 * no-`POW` SQLite constraint both need `hot_score` to stay a stored, indexed column).
 *
 * The pure decay core (`decayHotScores`) is unit-tested off-DB (`hotScoreDecay.unit.test.ts`).
 * This is the integration tier AC4 names (ADR 0082 §irreducible-integration): the
 * stored-column read → window filter → changed-only write-back → keyset feed re-ordering
 * that `decayHotScores`'s unit test can't reach. It:
 *   1. seeds two real posts over `/fate` under one per-file host (so the `posts(hot)`
 *      feed scopes to exactly this test's rows) — a `fresher` post voted young for a
 *      real young-high stored score, and a `stale` post;
 *   2. constructs the exact #2027 bug state on the stale post via a setup-only D1 write
 *      (`execD1`) — a higher score, a `hot_score` FROZEN at the young value, and a
 *      `created_at` aged 60h into the past (OLD, but still inside the 72h decay window
 *      the refresh scans): the "advance time" + frozen-score the public seam can't set,
 *      so the OLD post outranks the fresher one #1;
 *   3. runs the REAL `Pano.refreshHotScores(now)` against this stage's REAL remote D1
 *      (the fts-backfill precedent, #645: the shipped code path over `@kampus/d1-rest`,
 *      NOT a `node:sqlite` oracle — banned by ADR 0082, and NOT a re-implementation of
 *      the query — the worker's own `createDrizzle`/`makeDrizzleAccess`/`makePostOperations`);
 *   4. asserts the stale post's hot rank drops BELOW the fresher post through the `/fate`
 *      hot feed — the re-ordering, driven by the stored column the refresh rewrote;
 *   5. asserts NO activity write was needed: the stale post's `score` / `commentCount`
 *      are unchanged (decay wrote only `hot_score`), and the refresh reports `updated >= 1`.
 *
 * There is no HTTP route to trigger the cron on a deployed worker (the scheduled
 * handler fires on Cloudflare's schedule, not on demand), so — like `fts-backfill` —
 * the test drives the real method directly against this stage's real D1 REST target
 * (`h.d1Target()` + `$CLOUDFLARE_API_TOKEN`, the same creds the integration deploy uses).
 * Per-file `integrationStack`: this file owns its own worker + D1, so the direct-D1
 * refresh and the feed reads see one isolated table.
 */
import {makeD1RestFromEnv} from "@kampus/d1-rest";
import {Effect} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import {createDrizzle, makeDrizzleAccess, orDieAccess} from "../../worker/db/Drizzle.ts";
import {computeHotScore} from "../../worker/db/hotScore.ts";
import {makeRefreshHotScores} from "../../worker/features/pano/post-operations.ts";
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

/** Submit a real post under `HOST` over `/fate`; return its id. */
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

/** Read this host's hot feed and return post ids in feed (rank) order. */
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

/** Re-resolve a post's activity-bearing scalars over `/fate`. */
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
 * Build the REAL `Pano.refreshHotScores` bound to this stage's REAL remote D1 over
 * `@kampus/d1-rest` — the shipped worker code path (`createDrizzle` → `makeDrizzleAccess`
 * → `orDieAccess` → `makeRefreshHotScores`), never a re-implementation of its window query.
 * The method reads only `run`, so `makeRefreshHotScores(run)` builds it standalone against
 * this stage's real D1 — no full `PostOperationsDeps` graph, no cast.
 */
async function realRefreshHotScores() {
	const target = await h.d1Target();
	const db = createDrizzle(makeD1RestFromEnv(target));
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

		// The fresher post earns a young-high stored score by voting it while age≈0 — the
		// live activity path, score 1 → `hot_score = computeHotScore(1, now, now)` = 287.
		// Cast by a non-author (self-voting is blocked, #2216).
		const voted = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id: fresherId}, select: ["id", "score"]},
			{cookie: voter.cookie},
		);
		expect(voted.ok).toBe(true);
		if (!voted.ok) return;
		expect((voted.data as PostNode).score).toBe(1);

		// Construct the exact #2027 bug state on the stale post via the setup-only D1 REST seam
		// (the write clock + frozen-score the public mutation seam can't set): a HIGHER score (5),
		// a `hot_score` FROZEN at the young value it would have had at age≈0
		// (`computeHotScore(5, t, t)` = 1436), and a `created_at` aged 60h into the past — OLD, but
		// still INSIDE the 72h decay window (`decayWindowMs`) the refresh scans. `created_at` is
		// `integer(mode:"timestamp")`, stored as whole epoch SECONDS. So pre-refresh the OLD post's
		// frozen 1436 outranks the fresher post's 287 — the bug: a stale post squatting #1.
		const nowMs = Date.now();
		const staleCreatedSec = Math.floor((nowMs - 60 * HOUR_MS) / 1000);
		const staleFrozenHot = computeHotScore(5, nowMs, nowMs); // young-high, frozen at age≈0
		const changed = await h.execD1(
			"UPDATE post_record SET score = ?, hot_score = ?, created_at = ? WHERE id = ?",
			[5, staleFrozenHot, staleCreatedSec, staleId],
		);
		expect(changed).toBe(1);

		// Pre-refresh: the frozen-while-young stale score keeps the OLD post ranked above the
		// fresher one — the bug the feed exhibits (higher stored `hot_score` sorts first).
		const before = await hotFeedIds();
		const staleBefore = before.indexOf(staleId);
		const fresherBefore = before.indexOf(fresherId);
		expect(staleBefore).toBeGreaterThanOrEqual(0);
		expect(fresherBefore).toBeGreaterThanOrEqual(0);
		expect(staleBefore).toBeLessThan(fresherBefore); // stale ranks ABOVE fresher (the bug)

		// Grounding (the same formula the refresh applies, not intuition): re-decayed at 60h the
		// stale score collapses far below the fresher post's young score, so the refresh MUST flip
		// the order.
		const staleDecayed = computeHotScore(5, staleCreatedSec * 1000, nowMs);
		const fresherYoung = computeHotScore(1, nowMs, nowMs);
		expect(staleDecayed).toBeLessThan(fresherYoung);

		// Run the REAL refresh against real remote D1 — the shipped window query + write-back.
		const refreshHotScores = await realRefreshHotScores();
		const result = await Effect.runPromise(refreshHotScores(new Date(nowMs)));
		expect(result.scanned).toBeGreaterThanOrEqual(2); // both posts are inside the 72h window
		expect(result.updated).toBeGreaterThanOrEqual(1); // the stale post's frozen score moved

		// Post-refresh: the aged stale post's re-decayed stored score has collapsed, so the
		// fresher post now outranks it in the SAME keyset feed — driven purely by the stored
		// column the refresh rewrote (no read-time recompute).
		const after = await hotFeedIds();
		const staleAfter = after.indexOf(staleId);
		const fresherAfter = after.indexOf(fresherId);
		expect(staleAfter).toBeGreaterThanOrEqual(0);
		expect(fresherAfter).toBeGreaterThanOrEqual(0);
		expect(fresherAfter).toBeLessThan(staleAfter); // fresher now ranks ABOVE stale (fixed)

		// No activity write was needed: decay rewrote `hot_score` alone. The stale post's
		// activity-bearing scalars are untouched — score stays 5, commentCount stays 0. A
		// vote/comment write (the only pre-fix way a score refreshed) would have moved these.
		const stalePost = await readPost(staleId);
		expect(stalePost.score).toBe(5);
		expect(stalePost.commentCount).toBe(0);
	});
});
