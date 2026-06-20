/**
 * HN-style hot-score decay — the single source of truth for the ranking formula
 * `floor(score * 1000 / (hoursOld + 2)^1.8)` and its gravity constants, homed
 * below both consumers so neither owns a private copy that can silently drift.
 *
 * Two consumers across the Vote↔Pano seam, both reading from here (Vote never
 * imports `pano/`, so the shared home is `db/`, mirroring `pasaport/karma.ts`):
 *   - Pano calls `computeHotScore` for the integer score it persists.
 *   - Vote calls `hotMultiplier` for the JS-side multiplier it binds into SQL
 *     (SQLite has no `POW`, so the `(hoursOld + 2)^1.8` factor is computed here
 *     and the column is `CAST(count * multiplier AS INTEGER)`).
 */

const GRAVITY = 1.8;
const AGE_OFFSET_HOURS = 2;
const SCORE_SCALE = 1000;
const MS_PER_HOUR = 3_600_000;

/** Age in hours, floored at 0 so a clock skew can't make a post rank as future. */
const hoursOld = (createdAtMs: number, nowMs: number): number =>
	Math.max(0, (nowMs - createdAtMs) / MS_PER_HOUR);

/**
 * The decay multiplier `1000 / (hoursOld + 2)^1.8` — the per-vote weight at this
 * age. Vote binds this into SQL as `CAST(count * multiplier AS INTEGER)`.
 */
export const hotMultiplier = (createdAtMs: number, nowMs: number): number =>
	SCORE_SCALE / (hoursOld(createdAtMs, nowMs) + AGE_OFFSET_HOURS) ** GRAVITY;

/**
 * The persisted integer hot score `floor(score * multiplier)`. Floored so the
 * column stays an integer (D1 indexes integers cheaper than floats; only the
 * relative ordering matters). Equivalent to `count * multiplier` cast to INTEGER.
 */
export const computeHotScore = (score: number, createdAtMs: number, nowMs: number): number =>
	Math.floor(score * hotMultiplier(createdAtMs, nowMs));
