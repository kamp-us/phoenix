/**
 * The periodic hot-score decay-refresh core (#2027) — pure, DB-free.
 *
 * `hot_score` is a STORED, indexed integer (`post_record.hot_score`, index
 * `post_record_hot`) that the sıcak/hot feed reads by keyset pagination with no
 * read-time recompute. It is written only at activity sites (create/vote/comment),
 * so the age term of the HN gravity formula (`hotScore.ts`) freezes the moment a
 * post stops getting activity — an inactive post never decays and squats the feed.
 *
 * The fix is a periodic refresh, NOT a read-time recompute: read-time recompute
 * fights both the no-`POW` SQLite constraint (`hotScore.ts`) and the keyset-cursor
 * contract (the cursor needs `hot_score` to stay a stored, indexed, monotonic
 * column). This module owns the pure decision — given the current rows and `now`,
 * which `hot_score` values changed and to what — reusing the ONE `computeHotScore`
 * formula so the scheduled path and the write path can never drift. The DB read of
 * the candidate rows and the write-back are the caller's (`post-operations.ts`);
 * this stays workerd-free and unit-tested.
 */
import {computeHotScore} from "./hotScore.ts";

/** The minimal post shape the decay decision reads. */
export interface HotDecayRow {
	readonly id: string;
	readonly score: number;
	readonly hotScore: number;
	readonly createdAtMs: number;
}

/** One post whose stored `hot_score` must be rewritten to `hotScore`. */
export interface HotDecayUpdate {
	readonly id: string;
	readonly hotScore: number;
}

/**
 * The pure decay decision: recompute each row's `hot_score` at `now` via the shared
 * formula and return ONLY the rows whose stored value actually changed. Filtering to
 * changed rows keeps the write-back a no-op for the (common) steady state where a
 * post's floored score didn't move this pass — the refresh never writes churn.
 *
 * A row with `score === 0` recomputes to `0` and, if already `0`, is dropped — a
 * brand-new post at rest costs no write. `now` is threaded (not read here) so a
 * caller's single clock reading is the source of truth across read + recompute.
 */
export const decayHotScores = (
	rows: ReadonlyArray<HotDecayRow>,
	now: number,
): ReadonlyArray<HotDecayUpdate> => {
	const updates: Array<HotDecayUpdate> = [];
	for (const row of rows) {
		const next = computeHotScore(row.score, row.createdAtMs, now);
		if (next !== row.hotScore) {
			updates.push({id: row.id, hotScore: next});
		}
	}
	return updates;
};
