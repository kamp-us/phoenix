/**
 * The weekly cohort-rollup coverage (#7030, epic #6767): stage math, idempotence,
 * and silence detection, all decided with no engine (ADR 0082). Query builders render
 * `.toSQL()` over a no-op D1; the pass orchestration drives over in-memory ports
 * (the `scanReconcileChunks` idiom).
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, relations} from "../../db/Drizzle.ts";
import {
	activityDaysQuery,
	type CohortRollupInputs,
	type CohortRollupPorts,
	type CohortRollupRow,
	cohortUsersQuery,
	cohortWeekStart,
	commentFirstContributionQuery,
	dayOffset,
	definitionFirstContributionQuery,
	detectCaptureSilence,
	firstVouchQuery,
	foldCohortRollup,
	postFirstContributionQuery,
	rewriteRollupStatements,
	rollupCohortWeeksPass,
	rollupWindowEnding,
	windowNewActivityRowsQuery,
	windowSessionsQuery,
} from "./cohort-rollup.ts";
import {Funnel, FunnelLive} from "./Funnel.ts";

const DAY_MS = 86_400_000;
/** A Monday, so most fixture signups share one cohort week. */
const MONDAY = Date.parse("2026-08-03T10:00:00Z");

const dayBucket = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** Signup-day-relative UTC day bucket, `offset` days after the Monday fixture instant. */
const signupDayPlus = (offset: number): string => dayBucket(MONDAY + offset * DAY_MS);

// A real drizzle client over a no-op D1, used ONLY to render `.toSQL()`; nothing executes.
// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; nothing here executes against it.
const noopD1 = {
	prepare: () => ({
		bind() {
			return this;
		},
		async all() {
			return {results: []};
		},
		async first() {
			return null;
		},
		async run() {
			return {};
		},
		async raw() {
			return [];
		},
	}),
	async batch() {
		return [];
	},
} as unknown as D1Database;
const renderDb = drizzle(noopD1, {relations});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("cohortWeekStart — the UTC-Monday signup bucket", () => {
	it("buckets midweek instants back to their Monday", () => {
		assert.strictEqual(cohortWeekStart(MONDAY), "2026-08-03");
		assert.strictEqual(cohortWeekStart(Date.parse("2026-08-07T23:59:59Z")), "2026-08-03");
		assert.strictEqual(cohortWeekStart(Date.parse("2026-08-09T00:00:00Z")), "2026-08-03");
	});

	it("Sunday belongs to the week that started the Monday before", () => {
		assert.strictEqual(cohortWeekStart(Date.parse("2026-08-09T12:00:00Z")), "2026-08-03");
		assert.strictEqual(cohortWeekStart(Date.parse("2026-08-10T00:00:00Z")), "2026-08-10");
	});
});

describe("dayOffset — UTC day distance between buckets", () => {
	it("counts whole-day distances", () => {
		assert.strictEqual(dayOffset("2026-08-03", "2026-08-04"), 1);
		assert.strictEqual(dayOffset("2026-08-03", "2026-08-10"), 7);
		assert.strictEqual(dayOffset("2026-08-05", "2026-08-03"), -2);
	});
});

// ---------------------------------------------------------------------------
// foldCohortRollup — the five-stage funnel + D1/D7 return math
// ---------------------------------------------------------------------------

const user = (id: string, createdAtMs: number, promotedAtMs: number | null = null) => ({
	id,
	createdAtMs,
	promotedAtMs,
});

describe("foldCohortRollup — stage math within 7 days of signup (#7030)", () => {
	const inputs: CohortRollupInputs = {
		users: [
			user("u1", MONDAY),
			user("u2", MONDAY),
			user("u3", MONDAY, MONDAY + 2 * DAY_MS),
			user("u4", MONDAY),
			// Tuesday next week → its own cohort week ("2026-08-10").
			user("u5", Date.parse("2026-08-11T09:00:00Z")),
			// Boundary rider: every stage lands EXACTLY on the 7-day edge.
			user("u6", MONDAY, MONDAY + 7 * DAY_MS),
		],
		activityDays: [
			{userId: "u1", day: signupDayPlus(1)},
			{userId: "u2", day: signupDayPlus(3)},
			{userId: "u3", day: signupDayPlus(8)}, // past the window — no stage credits it
			{userId: "u6", day: signupDayPlus(7)}, // exactly day 7 still counts
		],
		firstContributionAt: [
			{key: "u2", firstAtMs: MONDAY + 5 * DAY_MS},
			{key: "u4", firstAtMs: MONDAY + 8 * DAY_MS}, // just past the horizon
			{key: "u6", firstAtMs: MONDAY + 7 * DAY_MS}, // exactly on the horizon
		],
		firstVouchAt: [
			{key: "u3", firstAtMs: MONDAY + 6 * DAY_MS},
			{key: "u4", firstAtMs: MONDAY + 9 * DAY_MS},
		],
	};

	it("counts each stage per cohort week, boundaries inclusive", () => {
		const rows = foldCohortRollup(inputs);

		assert.deepStrictEqual(
			rows.map((r) => r.cohortWeek),
			["2026-08-03", "2026-08-10"],
			"rows come out deterministically ordered by week",
		);

		assert.deepStrictEqual(rows[0], {
			cohortWeek: "2026-08-03",
			signedUp: 5,
			returnedDays2to7: 2, // u2 (day 3) + u6 (day 7); u1's day-1 return is NOT days 2–7
			firstContributed7d: 2, // u2 + u6-on-the-horizon; u4's day-8 contribution is out
			vouched7d: 1, // u3; u4's day-9 vouch is out
			promoted7d: 2, // u3 (+2d) and u6 (exactly +7d)
			d1Returned: 1, // only u1
			d7Returned: 3, // u1, u2, u6; u3's day-8 visit is out
			d1ReturnRate: 1 / 5,
			d7ReturnRate: 3 / 5,
		});
	});

	it("an untouched cohort reads all-zero stages with zero rates (never NaN)", () => {
		const rows = foldCohortRollup(inputs);
		assert.deepStrictEqual(rows[1], {
			cohortWeek: "2026-08-10",
			signedUp: 1,
			returnedDays2to7: 0,
			firstContributed7d: 0,
			vouched7d: 0,
			promoted7d: 0,
			d1Returned: 0,
			d7Returned: 0,
			d1ReturnRate: 0,
			d7ReturnRate: 0,
		});
	});

	it("is an idempotent fold: re-running over unchanged inputs writes byte-identical rows", () => {
		const first = foldCohortRollup(inputs);
		const second = foldCohortRollup(inputs);
		assert.deepStrictEqual(second, first);
		assert.deepStrictEqual(
			foldCohortRollup({...inputs, users: [...inputs.users].reverse()}),
			first,
			"user iteration order never leaks into the output",
		);
	});

	it("no users ⇒ no rows", () => {
		assert.deepStrictEqual(
			foldCohortRollup({users: [], activityDays: [], firstContributionAt: [], firstVouchAt: []}),
			[],
		);
	});
});

// ---------------------------------------------------------------------------
// detectCaptureSilence — founder ruling R1.2 on #7028
// ---------------------------------------------------------------------------

describe("detectCaptureSilence — sessions present but zero new activity rows", () => {
	const window = rollupWindowEnding(new Date(MONDAY));

	it("raises when sessions exist and zero new rows landed", () => {
		assert.deepStrictEqual(detectCaptureSilence({sessionsPresent: 5, newActivityRows: 0}, window), {
			sessionsPresent: 5,
			newActivityRows: 0,
			...window,
		});
	});

	it("stays silent on a healthy window (rows landed)", () => {
		assert.isNull(detectCaptureSilence({sessionsPresent: 5, newActivityRows: 3}, window));
	});

	it("zero SESSIONS is nobody-came-by, not a capture failure", () => {
		assert.isNull(detectCaptureSilence({sessionsPresent: 0, newActivityRows: 0}, window));
	});
});

// ---------------------------------------------------------------------------
// rollupCohortWeeksPass — orchestration over in-memory ports
// ---------------------------------------------------------------------------

interface Harness {
	readonly ports: CohortRollupPorts;
	readonly writes: Array<ReadonlyArray<CohortRollupRow>>;
	readonly silences: Array<ReturnType<typeof detectCaptureSilence>>;
}

function harness(
	inputs: CohortRollupInputs,
	counts: {sessionsPresent: number; newActivityRows: number},
): Harness {
	const writes: Array<ReadonlyArray<CohortRollupRow>> = [];
	const silences: Array<ReturnType<typeof detectCaptureSilence>> = [];
	const ports: CohortRollupPorts = {
		loadInputs: Effect.sync(() => inputs),
		writeRollup: (rows) =>
			Effect.sync(() => {
				writes.push(rows);
			}),
		loadWindowCounts: () => Effect.sync(() => counts),
		reportSilence: (silence) =>
			Effect.sync(() => {
				silences.push(silence);
			}),
	};
	return {ports, writes, silences};
}

const emptyInputs: CohortRollupInputs = {
	users: [],
	activityDays: [],
	firstContributionAt: [],
	firstVouchAt: [],
};

describe("rollupCohortWeeksPass — one pass: fold → rewrite → silence check", () => {
	it.effect("a healthy window rewrites the fold and stays silent", () =>
		Effect.gen(function* () {
			const h = harness(emptyInputs, {sessionsPresent: 4, newActivityRows: 2});
			const result = yield* rollupCohortWeeksPass(h.ports, new Date(MONDAY));

			assert.deepStrictEqual(result, {cohorts: 0});
			assert.deepStrictEqual(h.writes, [[]]);
			assert.deepStrictEqual(h.silences, [], "a healthy window raises nothing");
		}),
	);

	it.effect("a silent window reports the capture failure exactly once", () =>
		Effect.gen(function* () {
			const h = harness(emptyInputs, {sessionsPresent: 5, newActivityRows: 0});
			yield* rollupCohortWeeksPass(h.ports, new Date(MONDAY));

			assert.deepStrictEqual(h.silences, [
				{
					sessionsPresent: 5,
					newActivityRows: 0,
					sinceMs: MONDAY - 7 * DAY_MS,
					untilMs: MONDAY,
				},
			]);
		}),
	);

	it.effect("two passes over unchanged inputs produce identical rewrites (idempotence)", () =>
		Effect.gen(function* () {
			const inputs = foldFixtureInputs();
			const h = harness(inputs, {sessionsPresent: 1, newActivityRows: 1});
			yield* rollupCohortWeeksPass(h.ports, new Date(MONDAY));
			yield* rollupCohortWeeksPass(h.ports, new Date(MONDAY));

			assert.deepStrictEqual(h.writes[0], h.writes[1]);
			assert.deepStrictEqual(h.silences, []);
		}),
	);
});

function foldFixtureInputs(): CohortRollupInputs {
	return {
		users: [user("u1", MONDAY), user("u2", MONDAY)],
		activityDays: [{userId: "u2", day: signupDayPlus(2)}],
		firstContributionAt: [],
		firstVouchAt: [],
	};
}

// ---------------------------------------------------------------------------
// Rendered-SQL assertions — each predicate `.toSQL()`-inspectable, no engine
// ---------------------------------------------------------------------------

describe("cohortUsersQuery — humans with a registration stamp (rendered SQL)", () => {
	const {sql, params} = cohortUsersQuery(renderDb).toSQL();

	it("selects over the user table, filtered to humans with created_at", () => {
		assert.match(sql, /from\s+"user"/i);
		assert.match(sql, /"user"\."type"\s*=\s*\?/i);
		assert.match(sql, /"user"\."created_at"\s+is\s+not\s+null/i);
		assert.include(params, "human");
	});
});

describe("activityDaysQuery — the full activity-day table (rendered SQL)", () => {
	const {sql} = activityDaysQuery(renderDb).toSQL();

	it("reads every row — full pass, no sampling window", () => {
		assert.match(sql, /from\s+"user_activity_day"/i);
		assert.isFalse(/where/i.test(sql));
	});
});

describe("firstContribution builders — MIN(created_at) per author (rendered SQL)", () => {
	for (const [name, query, table] of [
		["definition", definitionFirstContributionQuery, "definition_record"],
		["post", postFirstContributionQuery, "post_record"],
		["comment", commentFirstContributionQuery, "comment_record"],
	] as const) {
		it(`${name}: min(created_at) grouped by author_id`, () => {
			const {sql} = query(renderDb).toSQL();
			assert.match(sql, new RegExp(`from\\s+"${table}"`, "i"));
			assert.match(sql, /min\(/i);
			assert.match(sql, new RegExp(`group by\\s+"${table}"\\."author_id"`, "i"));
		});
	}
});

describe("firstVouchQuery — earliest received vouch per candidate (rendered SQL)", () => {
	const {sql} = firstVouchQuery(renderDb).toSQL();

	it("mins authorship_vouch.created_at grouped by candidate_id", () => {
		assert.match(sql, /from\s+"authorship_vouch"/i);
		assert.match(sql, /min\(/i);
		assert.match(sql, /group by\s+"authorship_vouch"\."candidate_id"/i);
	});
});

describe("windowSessionsQuery — distinct session holders inside the window (rendered SQL)", () => {
	const window = rollupWindowEnding(new Date(MONDAY));
	const {sql, params} = windowSessionsQuery(renderDb, window).toSQL();

	it("ranges session.updated_at over [since, until)", () => {
		assert.match(sql, /count\(distinct "user_id"\)/i);
		assert.match(sql, /"session"\."updated_at"\s*>=\s*\?/i);
		assert.match(sql, /"session"\."updated_at"\s*<\s*\?/i);
		// sqlite `timestamp` mode renders as integer epoch SECONDS.
		assert.deepStrictEqual(params, [
			Math.floor(window.sinceMs / 1000),
			Math.floor(window.untilMs / 1000),
		]);
	});
});

describe("windowNewActivityRowsQuery — new activity-day rows inside the window (rendered SQL)", () => {
	const window = rollupWindowEnding(new Date(MONDAY));
	const {sql, params} = windowNewActivityRowsQuery(renderDb, window).toSQL();

	it("ranges the text day bucket over [sinceDay, untilDay)", () => {
		assert.match(sql, /from\s+"user_activity_day"/i);
		assert.match(sql, /count\(\*\)/i);
		assert.match(sql, /"user_activity_day"\."day"\s*>=\s*\?/i);
		assert.match(sql, /"user_activity_day"\."day"\s*<\s*\?/i);
		assert.deepStrictEqual(params, [dayBucket(window.sinceMs), dayBucket(window.untilMs)]);
	});
});

describe("rewriteRollupStatements — the transactional full rewrite (rendered SQL)", () => {
	const rows: Array<CohortRollupRow> = [
		{
			cohortWeek: "2026-08-03",
			signedUp: 5,
			returnedDays2to7: 2,
			firstContributed7d: 2,
			vouched7d: 1,
			promoted7d: 2,
			d1Returned: 1,
			d7Returned: 3,
			d1ReturnRate: 0.2,
			d7ReturnRate: 0.6,
		},
	];
	const statements = rewriteRollupStatements(renderDb, rows);
	// The batch tuple type erases the builders' common surface; every drizzle statement
	// renders, so the cast only recovers `.toSQL`.
	const rendered = statements.map(
		// biome-ignore lint/plugin: rendering-only cast over drizzle's erased batch tuple; nothing executes.
		(s) => (s as unknown as {toSQL(): {sql: string; params: unknown[]}}).toSQL(),
	);

	it("leads with the table-wide delete, then one insert per folded row", () => {
		assert.strictEqual(statements.length, 2);
		const [del = "", ins = ""] = rendered.map((r) => r.sql);
		assert.match(del, /delete\s+from\s+"cohort_week_rollup"/i);
		assert.match(ins, /insert\s+into\s+"cohort_week_rollup"/i);
		assert.match(ins, /"returned_days_2_to_7"/i);
		assert.deepStrictEqual(rendered[1]?.params.slice(0, 2), ["2026-08-03", 5]);
	});
});

// ---------------------------------------------------------------------------
// Funnel.rollupWeeklyCohorts — the service method wired over the Drizzle seam
// ---------------------------------------------------------------------------

// Dispenses queued responses in call order (users, activityDays, definitions, posts,
// comments, vouches, windowSessions, windowRows); `batch` captures its statement count.
const scriptedAccess = (
	responses: ReadonlyArray<ReadonlyArray<unknown>>,
): {
	access: DrizzleAccess;
	batches: Array<number>;
} => {
	let call = 0;
	const batches: Array<number> = [];
	// biome-ignore lint/plugin: `DrizzleAccess` is a service seam substituted directly, as `Funnel.unit.test.ts` does; nothing here touches a database.
	const access = {
		run: <A>(_fn: (db: never) => Promise<A>) => Effect.succeed((responses[call++] ?? []) as A),
		// The real client renders statements off the drizzle handle; here only the COUNT
		// matters (delete + one insert per folded row), so render over the no-op D1.
		batch: (fn: (db: never) => ReadonlyArray<unknown>) =>
			Effect.sync(() => {
				batches.push(fn(renderDb as never).length);
				return [];
			}),
	} as unknown as DrizzleAccess;
	return {access, batches};
};

const funnelLayer = (access: DrizzleAccess) =>
	FunnelLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

describe("Funnel.rollupWeeklyCohorts — the cron entry point through the seam", () => {
	it.effect("folds the reads into one transactional rewrite and returns the cohort count", () => {
		const {access, batches} = scriptedAccess([
			[{id: "u1", createdAt: new Date(MONDAY), promotedAt: null}], // cohortUsers
			[], // activityDays
			[], // definition first contributions
			[], // post first contributions
			[], // comment first contributions
			[], // first vouches
			[{value: 1}], // window sessions
			[{value: 0}], // window new activity rows
		]);
		return Effect.gen(function* () {
			const funnel = yield* Funnel;
			const result = yield* funnel.rollupWeeklyCohorts(new Date(MONDAY));

			assert.deepStrictEqual(result, {cohorts: 1});
			assert.deepStrictEqual(batches, [2], "one batch: the delete + the folded insert");
		}).pipe(Effect.provide(funnelLayer(access)));
	});
});
