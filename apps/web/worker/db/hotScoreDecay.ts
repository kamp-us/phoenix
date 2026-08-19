/**
 * The pure decay decision behind the periodic hot-score refresh (#2027). A periodic
 * refresh rather than a read-time recompute, because recompute-on-read fights both the
 * no-`POW` SQLite constraint (`hotScore.ts`) and the keyset cursor, which needs
 * `hot_score` to stay a stored, indexed column. The read and write-back are the caller's
 * (`post-operations.ts`); the `computeHotScore` reuse is what keeps the scheduled path
 * and the write path from drifting.
 */
import {computeHotScore} from "./hotScore.ts";

export interface HotDecayRow {
	readonly id: string;
	readonly score: number;
	readonly hotScore: number;
	readonly createdAtMs: number;
}

export interface HotDecayUpdate {
	readonly id: string;
	readonly hotScore: number;
}

/**
 * Returns ONLY the rows whose stored value actually changed, so the write-back is a no-op
 * in the common steady state where a post's floored score didn't move. `now` is threaded
 * in so the caller's single clock reading covers read + recompute.
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
