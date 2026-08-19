/**
 * HN-style hot-score decay — the single source of truth for the ranking formula and
 * its gravity constants, homed below both consumers (Vote never imports `pano/`) so
 * neither owns a private copy that can drift.
 *
 * SQLite has no `POW`, so the `(hoursOld + 2)^1.8` factor is computed in JS here and
 * bound into SQL as `CAST(count * multiplier AS INTEGER)`.
 */

const GRAVITY = 1.8;
const AGE_OFFSET_HOURS = 2;
const SCORE_SCALE = 1000;
const MS_PER_HOUR = 3_600_000;

/** Age in hours, floored at 0 so a clock skew can't make a post rank as future. */
const hoursOld = (createdAtMs: number, nowMs: number): number =>
	Math.max(0, (nowMs - createdAtMs) / MS_PER_HOUR);

export const hotMultiplier = (createdAtMs: number, nowMs: number): number =>
	SCORE_SCALE / (hoursOld(createdAtMs, nowMs) + AGE_OFFSET_HOURS) ** GRAVITY;

/**
 * Floored so the persisted column stays an integer — D1 indexes integers cheaper than
 * floats, and only the relative ordering matters.
 */
export const computeHotScore = (score: number, createdAtMs: number, nowMs: number): number =>
	Math.floor(score * hotMultiplier(createdAtMs, nowMs));
