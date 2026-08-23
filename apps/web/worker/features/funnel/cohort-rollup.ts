/**
 * The weekly cohort rollup (#7030, epic #6767): a FULL, idempotent recompute of
 * per-signup-cohort week-1 survival into `cohort_week_rollup`, so cohort history
 * survives beyond live queries (ADR 0153 names roll-up-into-D1 as the longer-history
 * path). Mirrors the hot-score-decay / sözlük-reconcile cron precedents: the pass is
 * clocked off the controller's scheduled instant and rewrites every row from live
 * tables, so re-running it on unchanged source data writes byte-identical rows —
 * no sampling, no failure bookkeeping.
 *
 * Silence detection (founder ruling R1.2 on #7028) rides the same pass: when sessions
 * exist inside the trailing weekly window but zero new `user_activity_day` rows landed
 * over it, capture is dead and the error is logged into the worker error pipeline
 * (Sentry-surfaced) so a silently dead capture is visible at the weekly cadence.
 *
 * Stage definitions (epic R1.3): per signup cohort (UTC-Monday week of `created_at`) —
 * signed up → returned any of days 2–7 → first contribution → vouched → promoted,
 * each within 7 days of signup, plus D1/D7 return counts and rates. First contribution
 * is `MIN(created_at)` per author across the three content tables (the promotion sweep
 * clears `sandboxed_at` but never `created_at`), vouch time is `MIN(authorship_vouch.created_at)`,
 * promotion time is `promoted_at` — the fact floor of epic session R1.1.
 */
import {and, asc, count, countDistinct, eq, gte, isNotNull, lt, min} from "drizzle-orm";
import {Effect} from "effect";
import type {DrizzleAccessOrDie, DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {utcDayBucket} from "../pasaport/user-activity-day.ts";

const DAY_MS = 86_400_000;

/** The silence-detection window: the week before the scheduled instant, `[since, until)`. */
export const ROLLUP_WINDOW_MS = 7 * DAY_MS;

/** The 7-day horizon every funnel stage must fall within ("within 7 days of signup"). */
export const STAGE_HORIZON_MS = 7 * DAY_MS;

export interface CohortUserRow {
	readonly id: string;
	readonly createdAtMs: number;
	readonly promotedAtMs: number | null;
}

export interface ActivityDayRow {
	readonly userId: string;
	readonly day: string;
}

export interface FirstAtRow {
	readonly key: string;
	readonly firstAtMs: number;
}

export interface CohortRollupInputs {
	readonly users: ReadonlyArray<CohortUserRow>;
	readonly activityDays: ReadonlyArray<ActivityDayRow>;
	/** Earliest `created_at` per author across definition/post/comment records, pre-merged. */
	readonly firstContributionAt: ReadonlyArray<FirstAtRow>;
	readonly firstVouchAt: ReadonlyArray<FirstAtRow>;
}

export interface CohortRollupRow {
	readonly cohortWeek: string;
	readonly signedUp: number;
	readonly returnedDays2to7: number;
	readonly firstContributed7d: number;
	readonly vouched7d: number;
	readonly promoted7d: number;
	readonly d1Returned: number;
	readonly d7Returned: number;
	readonly d1ReturnRate: number;
	readonly d7ReturnRate: number;
}

/** UTC day offset between two `YYYY-MM-DD` buckets (`Date.parse` reads them as UTC midnight). */
export const dayOffset = (signupDay: string, day: string): number =>
	Math.round((Date.parse(day) - Date.parse(signupDay)) / DAY_MS);

/** The `YYYY-MM-DD` bucket of the UTC Monday of the given instant's week. */
export const cohortWeekStart = (atMs: number): string => {
	const utcMidnight = Date.UTC(
		new Date(atMs).getUTCFullYear(),
		new Date(atMs).getUTCMonth(),
		new Date(atMs).getUTCDate(),
	);
	const monday = utcMidnight - ((new Date(atMs).getUTCDay() + 6) % 7) * DAY_MS;
	return new Date(monday).toISOString().slice(0, 10);
};

/**
 * The fold proper: raw rows → one rollup row per signup week. Pure, so stage math is
 * decided with no engine (ADR 0082) and a second run over unchanged inputs returns a
 * deep-equal, deterministically ordered result.
 */
export const foldCohortRollup = (inputs: CohortRollupInputs): Array<CohortRollupRow> => {
	const earliest = (rows: ReadonlyArray<FirstAtRow>): Map<string, number> => {
		const byKey = new Map<string, number>();
		for (const row of rows) {
			const known = byKey.get(row.key);
			if (known === undefined || row.firstAtMs < known) byKey.set(row.key, row.firstAtMs);
		}
		return byKey;
	};

	const contributionAt = earliest(inputs.firstContributionAt);
	const vouchAt = earliest(inputs.firstVouchAt);

	const offsetsByUser = new Map<string, string[]>();
	for (const row of inputs.activityDays) {
		const days = offsetsByUser.get(row.userId);
		if (days === undefined) offsetsByUser.set(row.userId, [row.day]);
		else days.push(row.day);
	}

	interface WeekTally {
		cohortWeek: string;
		signedUp: number;
		returnedDays2to7: number;
		firstContributed7d: number;
		vouched7d: number;
		promoted7d: number;
		d1Returned: number;
		d7Returned: number;
	}
	const weeks = new Map<string, WeekTally>();

	for (const u of inputs.users) {
		const cohortWeek = cohortWeekStart(u.createdAtMs);
		const tally =
			weeks.get(cohortWeek) ??
			({
				cohortWeek,
				signedUp: 0,
				returnedDays2to7: 0,
				firstContributed7d: 0,
				vouched7d: 0,
				promoted7d: 0,
				d1Returned: 0,
				d7Returned: 0,
			} satisfies WeekTally);
		tally.signedUp++;

		const signupDay = utcDayBucket(new Date(u.createdAtMs));
		for (const day of offsetsByUser.get(u.id) ?? []) {
			const offset = dayOffset(signupDay, day);
			if (offset < 1 || offset > 7) continue;
			tally.d7Returned++;
			if (offset === 1) tally.d1Returned++;
			else tally.returnedDays2to7++;
		}

		const horizon = u.createdAtMs + STAGE_HORIZON_MS;
		const contributedAt = contributionAt.get(u.id);
		if (contributedAt !== undefined && contributedAt <= horizon) tally.firstContributed7d++;
		const vouchedAt = vouchAt.get(u.id);
		if (vouchedAt !== undefined && vouchedAt <= horizon) tally.vouched7d++;
		if (u.promotedAtMs !== null && u.promotedAtMs <= horizon) tally.promoted7d++;

		weeks.set(cohortWeek, tally);
	}

	return [...weeks.values()]
		.map((t) => ({
			...t,
			d1ReturnRate: t.signedUp === 0 ? 0 : t.d1Returned / t.signedUp,
			d7ReturnRate: t.signedUp === 0 ? 0 : t.d7Returned / t.signedUp,
		}))
		.sort((a, b) => (a.cohortWeek < b.cohortWeek ? -1 : a.cohortWeek > b.cohortWeek ? 1 : 0));
};

export interface RollupWindow {
	readonly sinceMs: number;
	readonly untilMs: number;
}

export const rollupWindowEnding = (now: Date): RollupWindow => ({
	sinceMs: now.getTime() - ROLLUP_WINDOW_MS,
	untilMs: now.getTime(),
});

export interface WindowCounts {
	/** Distinct users with a session updated inside the window. */
	readonly sessionsPresent: number;
	/** New `user_activity_day` rows that landed inside the window. */
	readonly newActivityRows: number;
}

export interface CaptureSilence extends WindowCounts, RollupWindow {}

/**
 * Sessions present with zero new activity-day rows over the window ⇒ capture is
 * silently dead. A healthy window stays silent; zero SESSIONS means nobody came by,
 * which is not a capture failure.
 */
export const detectCaptureSilence = (
	counts: WindowCounts,
	window: RollupWindow,
): CaptureSilence | null =>
	counts.sessionsPresent > 0 && counts.newActivityRows === 0 ? {...counts, ...window} : null;

// ---------------------------------------------------------------------------
// Query builders — extracted from the ports, not inlined, so each predicate is
// `.toSQL()`-inspectable in a unit test with no engine (ADR 0082 T1/T2).
// ---------------------------------------------------------------------------

/** Humans with a registration stamp; bots/system and null-`created_at` rows never enter. */
export const cohortUsersQuery = (db: DrizzleDb) =>
	db
		.select({
			id: schema.user.id,
			createdAt: schema.user.createdAt,
			promotedAt: schema.user.promotedAt,
		})
		.from(schema.user)
		.where(and(eq(schema.user.type, "human"), isNotNull(schema.user.createdAt)))
		.orderBy(asc(schema.user.id));

/** The full activity-day table — the pass is deliberately full-pass, no sampling. */
export const activityDaysQuery = (db: DrizzleDb) =>
	db
		.select({userId: schema.userActivityDay.userId, day: schema.userActivityDay.day})
		.from(schema.userActivityDay)
		.orderBy(asc(schema.userActivityDay.userId), asc(schema.userActivityDay.day));

/** Earliest contribution per author from ONE content table (merged across three in TS). */
export const definitionFirstContributionQuery = (db: DrizzleDb) =>
	db
		.select({
			key: schema.definitionRecord.authorId,
			firstAt: min(schema.definitionRecord.createdAt),
		})
		.from(schema.definitionRecord)
		.groupBy(schema.definitionRecord.authorId);

export const postFirstContributionQuery = (db: DrizzleDb) =>
	db
		.select({key: schema.postRecord.authorId, firstAt: min(schema.postRecord.createdAt)})
		.from(schema.postRecord)
		.groupBy(schema.postRecord.authorId);

export const commentFirstContributionQuery = (db: DrizzleDb) =>
	db
		.select({key: schema.commentRecord.authorId, firstAt: min(schema.commentRecord.createdAt)})
		.from(schema.commentRecord)
		.groupBy(schema.commentRecord.authorId);

/** Earliest received vouch per candidate. A withdrawn vouch deletes its row (known hole, not reconstructed). */
export const firstVouchQuery = (db: DrizzleDb) =>
	db
		.select({
			key: schema.authorshipVouch.candidateId,
			firstAt: min(schema.authorshipVouch.createdAt),
		})
		.from(schema.authorshipVouch)
		.groupBy(schema.authorshipVouch.candidateId);

/** Distinct session holders whose session was touched inside the window. */
export const windowSessionsQuery = (db: DrizzleDb, window: RollupWindow) =>
	db
		.select({value: countDistinct(schema.session.userId)})
		.from(schema.session)
		.where(
			and(
				gte(schema.session.updatedAt, new Date(window.sinceMs)),
				lt(schema.session.updatedAt, new Date(window.untilMs)),
			),
		);

/** New activity-day rows inside the window; text `YYYY-MM-DD` buckets order lexicographically. */
export const windowNewActivityRowsQuery = (db: DrizzleDb, window: RollupWindow) =>
	db
		.select({value: count()})
		.from(schema.userActivityDay)
		.where(
			and(
				gte(schema.userActivityDay.day, utcDayBucket(new Date(window.sinceMs))),
				lt(schema.userActivityDay.day, utcDayBucket(new Date(window.untilMs))),
			),
		);

/**
 * The write: one transactional D1 batch that drops the table's contents and inserts
 * the freshly folded rows — the literal "rewrites identical rows" of the idempotence
 * contract, converged even if a past week's population vanished entirely.
 */
export const rewriteRollupStatements = (
	db: DrizzleDb,
	rows: ReadonlyArray<CohortRollupRow>,
): [Stmt, ...Stmt[]] => {
	const statements: [Stmt, ...Stmt[]] = [db.delete(schema.cohortWeekRollup)];
	for (const row of rows) statements.push(db.insert(schema.cohortWeekRollup).values(row));
	return statements;
};

// ---------------------------------------------------------------------------
// Ports + pass — the orchestration is wrong-or-right with no SQL engine, so it
// drives over in-memory ports in tests (the `scanReconcileChunks` idiom); real
// wiring happens once in `makeCohortRollupPorts`.
// ---------------------------------------------------------------------------

export interface CohortRollupPorts {
	readonly loadInputs: Effect.Effect<CohortRollupInputs>;
	readonly writeRollup: (rows: ReadonlyArray<CohortRollupRow>) => Effect.Effect<void>;
	readonly loadWindowCounts: (window: RollupWindow) => Effect.Effect<WindowCounts>;
	readonly reportSilence: (silence: CaptureSilence) => Effect.Effect<void>;
}

/**
 * One pass: fold → transactional rewrite → silence detection over the trailing week.
 * The silence error is REPORTED through the port (the real port logs into the worker
 * error pipeline) and otherwise swallowed — CronEventSource already swallows failures,
 * so a dead pass never crashes the scheduled invocation either way.
 */
export const rollupCohortWeeksPass = (ports: CohortRollupPorts, now: Date) =>
	Effect.gen(function* () {
		const rows = foldCohortRollup(yield* ports.loadInputs);
		yield* ports.writeRollup(rows);

		const window = rollupWindowEnding(now);
		const counts = yield* ports.loadWindowCounts(window);
		const silence = detectCaptureSilence(counts, window);
		if (silence !== null) yield* ports.reportSilence(silence);

		return {cohorts: rows.length};
	});

export const makeCohortRollupPorts = (
	run: DrizzleAccessOrDie["run"],
	batch: DrizzleAccessOrDie["batch"],
): CohortRollupPorts => ({
	loadInputs: Effect.gen(function* () {
		const users = yield* run((db) => cohortUsersQuery(db));
		const activityDays = yield* run((db) => activityDaysQuery(db));
		const definitions = yield* run((db) => definitionFirstContributionQuery(db));
		const posts = yield* run((db) => postFirstContributionQuery(db));
		const comments = yield* run((db) => commentFirstContributionQuery(db));
		const vouches = yield* run((db) => firstVouchQuery(db));
		return {
			users: users.flatMap((u) =>
				u.createdAt === null
					? []
					: [
							{
								id: u.id,
								createdAtMs: u.createdAt.getTime(),
								promotedAtMs: u.promotedAt?.getTime() ?? null,
							},
						],
			),
			activityDays,
			firstContributionAt: [...definitions, ...posts, ...comments].flatMap((row) =>
				row.firstAt === null ? [] : [{key: row.key, firstAtMs: row.firstAt.getTime()}],
			),
			firstVouchAt: vouches.flatMap((row) =>
				row.firstAt === null ? [] : [{key: row.key, firstAtMs: row.firstAt.getTime()}],
			),
		};
	}),
	writeRollup: (rows) => Effect.asVoid(batch((db) => rewriteRollupStatements(db, rows))),
	loadWindowCounts: (window) =>
		Effect.gen(function* () {
			const sessions = yield* run((db) => windowSessionsQuery(db, window));
			const rows = yield* run((db) => windowNewActivityRowsQuery(db, window));
			return {
				sessionsPresent: sessions[0]?.value ?? 0,
				newActivityRows: rows[0]?.value ?? 0,
			};
		}),
	reportSilence: (silence) =>
		Effect.logError(
			"[funnel.cohortRollup] capture silence — sessions present inside the window but zero new user_activity_day rows landed",
			silence,
		),
});

/** The service method the cron calls; built once at layer build, like `makePersistPanoStats`. */
export const makeRollupWeeklyCohorts = (
	run: DrizzleAccessOrDie["run"],
	batch: DrizzleAccessOrDie["batch"],
) =>
	Effect.fn("Funnel.rollupWeeklyCohorts")(function* (now: Date) {
		return yield* rollupCohortWeeksPass(makeCohortRollupPorts(run, batch), now);
	});
