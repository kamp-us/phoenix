/**
 * `user_activity_day` capture (#7029, epic #6767): one append-only row per
 * `(user_id, day)` recording that a validated session existed on that UTC day.
 * Forward-only by founder ruling R1.2 on #7028 — capture ships live on deploy, no
 * flag and no backfill, because a day that already passed cannot be reconstructed.
 *
 * This sits on the hottest path in the worker (`Pasaport.validateSession`), so the
 * memo below is load-bearing: ~one D1 write per active user per day, never per
 * request. The memo is isolate-local — workers reset it on every deploy/restart,
 * which is fine because `ON CONFLICT DO NOTHING` makes a re-attempt idempotent.
 */
import type {DrizzleDb} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";

/** Today's UTC day bucket: `YYYY-MM-DD`. */
export const utcDayBucket = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * The isolate-local `user_id → day` memo. Entries are cheap (two short strings) but
 * unbounded across a long-lived isolate's user population, so past the cap the whole
 * map is dropped rather than grown: worst case after a drop is a bounded burst of
 * extra no-op upserts, never unbounded memory on the hot path.
 */
const MEMO_CAP = 50_000;
const touchedDays = new Map<string, string>();

/** Test seam — the memo is module state, so a test resets it between scenarios. */
export const resetActivityMemoForTests = (): void => {
	touchedDays.clear();
};

export const shouldCapture = (userId: string, day: string): boolean =>
	touchedDays.get(userId) !== day;

export const recordCaptured = (userId: string, day: string): void => {
	if (!touchedDays.has(userId) && touchedDays.size >= MEMO_CAP) {
		touchedDays.clear();
	}
	touchedDays.set(userId, day);
};

/**
 * The upsert itself, exported as a builder so tests can assert its rendered SQL via
 * `.toSQL()` with no engine behind the client (the `renderDb` idiom).
 * `ON CONFLICT DO NOTHING` is what keeps a memo-missed repeat same-day write a no-op.
 */
export const upsertUserActivityDay = (db: DrizzleDb, userId: string, day: string) =>
	db.insert(schema.userActivityDay).values({userId, day}).onConflictDoNothing();
