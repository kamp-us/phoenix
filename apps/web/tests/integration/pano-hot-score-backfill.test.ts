/**
 * pano sıcak/hot one-time full backfill → the end-to-end guard for #2131.
 *
 * The bug (#2131): the go-forward decay cron (#2033) re-decays `post_record.hot_score`
 * only over a 72h recency window (`decayWindowMs`, `db/hotScoreDecay.ts`) — its query
 * filters `gte(created_at, now - decayWindowMs)`. So a post that froze high BEFORE that
 * fix shipped and now sits OUTSIDE the window is never selected by `refreshHotScores` and
 * keeps its stale young-high stored score forever, pinned #1 on the sıcak feed (the live
 * 17-day-old squatter the founder observed). There is no backfill path.
 *
 * The fix is `Pano.backfillHotScores` (`post-operations.ts`): a ONE-TIME windowless
 * recompute over ALL live non-draft rows, reusing the SAME pure core (`decayHotScores`)
 * MINUS the window clause, guarded run-once by the `hot_score_backfill` marker row.
 *
 * This is the integration tier (ADR 0082 §irreducible-integration): the stored-column
 * read → windowless recompute → write-back → keyset feed re-ordering that the pure
 * `decayHotScores` unit test and the query-shape unit test can't reach. It proves the
 * exact pre-fix-frozen case — a post OUTSIDE the 72h window — by:
 *   1. seeding two real posts over `/fate` under one per-file host;
 *   2. constructing the #2131 bug state on the stale post via a setup-only D1 write: a
 *      higher score, a `hot_score` FROZEN at the young value, and a `created_at` aged 17
 *      DAYS into the past — far OUTSIDE the 72h decay window the cron scans;
 *   3. asserting the WINDOWED `refreshHotScores` does NOT re-decay it (the bug: the row is
 *      outside the window, so it is never selected — it stays pinned above the fresher
 *      post);
 *   4. running the REAL `Pano.backfillHotScores(now)` against this stage's REAL remote D1
 *      (the shipped code path over `@kampus/d1-rest`, no re-implementation of the query);
 *   5. asserting the stale post's rank drops BELOW the fresher post through the `/fate`
 *      hot feed — driven purely by the stored column the backfill rewrote;
 *   6. asserting a SECOND backfill is a run-once no-op (`ran === false`), and that no
 *      activity write was needed (the stale post's `score`/`commentCount` are unchanged).
 *
 * Like `pano-hot-score-decay`, there is no HTTP route to trigger the scheduled handler on
 * demand, so the test drives the real method directly against this stage's real D1 REST
 * target — the fts-backfill precedent (#645). Per-file `integrationStack`: this file owns
 * its own worker + D1, so the direct-D1 backfill and the feed reads see one isolated table.
 */
import {makeD1RestFromEnv} from "@kampus/d1-rest";
import {Effect} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import {createDrizzle, makeDrizzleAccess, orDieAccess} from "../../worker/db/Drizzle.ts";
import {computeHotScore} from "../../worker/db/hotScore.ts";
import {
	makeBackfillHotScores,
	makeRefreshHotScores,
} from "../../worker/features/pano/post-operations.ts";
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

const HOST = `hot-backfill-${Date.now().toString(36)}.example.com`;
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
 * Build the REAL `Pano.refreshHotScores` / `Pano.backfillHotScores` bound to this stage's
 * REAL remote D1 over `@kampus/d1-rest` — the shipped worker code path
 * (`createDrizzle` → `makeDrizzleAccess` → `orDieAccess` → the factory), never a
 * re-implementation of the query. Both methods read only `run`, so they build standalone.
 */
async function realOps() {
	const target = await h.d1Target();
	const db = createDrizzle(makeD1RestFromEnv(target));
	const access = orDieAccess(makeDrizzleAccess(db));
	return {
		refreshHotScores: makeRefreshHotScores(access.run),
		backfillHotScores: makeBackfillHotScores(access.run),
	};
}

beforeAll(async () => {
	author = await h.signUp("hot-backfill-author@test.local", "hunter2hunter2", "hot-backfill-yazar");
	// `voter` casts the fresher post's live vote below — self-voting is blocked (#2216), so the
	// caster is never the author; both need yazar to clear the #1810 "earn to vote" gate.
	voter = await h.signUp("hot-backfill-voter@test.local", "hunter2hunter2", "hot-backfill-oycu");
	await h.promoteToYazar(author.userId);
	await h.promoteToYazar(voter.userId);
});

describe("pano sıcak/hot one-time backfill (#2131) — the windowless recompute reaches rows OUTSIDE 72h", () => {
	it("un-freezes a post OUTSIDE the 72h window that the windowed refresh never touches", async () => {
		const staleId = await seedPost("stale-outside-window");
		const fresherId = await seedPost("fresher-inside-window");

		// The fresher post earns a young-high stored score via the live vote path (cast by a
		// non-author — self-voting is blocked, #2216).
		const voted = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id: fresherId}, select: ["id", "score"]},
			{cookie: voter.cookie},
		);
		expect(voted.ok).toBe(true);
		if (!voted.ok) return;
		expect((voted.data as PostNode).score).toBe(1);

		// The exact #2131 bug state on the stale post: a higher score (5), a `hot_score`
		// FROZEN at the young age≈0 value, and a `created_at` aged 17 DAYS into the past —
		// far OUTSIDE the 72h window (`decayWindowMs`). `created_at` is
		// `integer(mode:"timestamp")`, stored as whole epoch SECONDS.
		const nowMs = Date.now();
		const staleCreatedSec = Math.floor((nowMs - 17 * 24 * HOUR_MS) / 1000);
		const staleFrozenHot = computeHotScore(5, nowMs, nowMs); // young-high, frozen at age≈0
		const changed = await h.execD1(
			"UPDATE post_record SET score = ?, hot_score = ?, created_at = ? WHERE id = ?",
			[5, staleFrozenHot, staleCreatedSec, staleId],
		);
		expect(changed).toBe(1);

		// Pre-fix: the frozen-while-young stale score keeps the OLD post ranked #1.
		const before = await hotFeedIds();
		expect(before.indexOf(staleId)).toBeLessThan(before.indexOf(fresherId));

		// Grounding (the same formula the backfill applies): re-decayed at 17 days the stale
		// score collapses far below the fresher post's young score, so a windowless recompute
		// MUST flip the order.
		const staleDecayed = computeHotScore(5, staleCreatedSec * 1000, nowMs);
		const fresherYoung = computeHotScore(1, nowMs, nowMs);
		expect(staleDecayed).toBeLessThan(fresherYoung);

		const {refreshHotScores, backfillHotScores} = await realOps();

		// The WINDOWED refresh does NOT reach the 17-day post — it is outside the 72h window,
		// so `refreshHotScores` never selects it and the bug persists (this is why a backfill
		// is needed). The stale post is still pinned above the fresher one.
		await Effect.runPromise(refreshHotScores(new Date(nowMs)));
		const afterRefresh = await hotFeedIds();
		expect(afterRefresh.indexOf(staleId)).toBeLessThan(afterRefresh.indexOf(fresherId));

		// The ONE-TIME windowless backfill DOES reach it: it recomputes every row regardless
		// of age and rewrites the stale post's collapsed stored score.
		const result = await Effect.runPromise(backfillHotScores(new Date(nowMs)));
		expect(result.ran).toBe(true);
		expect(result.scanned).toBeGreaterThanOrEqual(2);
		expect(result.updated).toBeGreaterThanOrEqual(1);

		// Post-backfill: the aged stale post's re-decayed stored score has collapsed, so the
		// fresher post now outranks it in the SAME keyset feed.
		const after = await hotFeedIds();
		expect(after.indexOf(fresherId)).toBeLessThan(after.indexOf(staleId));

		// Run-once: a second backfill is a no-op guarded by the `hot_score_backfill` marker.
		const second = await Effect.runPromise(backfillHotScores(new Date(nowMs)));
		expect(second.ran).toBe(false);
		expect(second.updated).toBe(0);

		// No activity write was needed: decay rewrote `hot_score` alone. The stale post's
		// activity-bearing scalars are untouched.
		const stalePost = await readPost(staleId);
		expect(stalePost.score).toBe(5);
		expect(stalePost.commentCount).toBe(0);
	});
});
