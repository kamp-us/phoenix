/**
 * `user_activity_day` capture (#7029, epic #6767): the upsert builder's rendered SQL
 * (no engine), the memo gate's exactly-one-write-per-day contract at the
 * `validateSession` seam, and the never-fail-a-login guarantee under an injected D1
 * failure — the error logged into the worker pipeline, the session returned unchanged.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer, Logger} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, DrizzleError} from "../../db/Drizzle.ts";
import {type BetterAuthInstance, makePasaportLive, Pasaport, type Session} from "./Pasaport.ts";
import {
	recordCaptured,
	resetActivityMemoForTests,
	shouldCapture,
	upsertUserActivityDay,
	utcDayBucket,
} from "./user-activity-day.ts";

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

const USER = "u-1";
const DAY = "2026-08-24";

// The validated-session double `makePasaportLive` reads through better-auth; the
// identity of THIS object is what "returned unchanged" asserts below.
// biome-ignore lint/plugin: a better-auth session is a host-shaped object; only its identity matters here.
const session = {user: {id: USER}, session: {userId: USER}} as unknown as Session;
// Matches the repo idiom (`{} as BetterAuthInstance`) — only `api.getSession` is read.
const authReturning = (value: Session | null): BetterAuthInstance =>
	({api: {getSession: async () => value}}) as BetterAuthInstance;

/**
 * Scripts `run` responses positionally and records how many runs each effect consumed:
 * call 0 on a valid session is the ban-state read, call 1 (when it happens) is the
 * activity-day upsert. A `null` response makes that call fail with `DrizzleError`,
 * which `orDieAccess` turns into a defect — exactly what an injected capture failure
 * must survive.
 */
const scriptedAccess = (responses: ReadonlyArray<unknown | null>) => {
	let call = 0;
	const runsPerEffect: number[] = [];
	let runs = 0;
	const access: DrizzleAccess = {
		run: (<A>(_fn: (db: DrizzleDb) => Promise<A>) => {
			runs++;
			const response = responses[call++];
			return response === null
				? Effect.fail(new DrizzleError({cause: new Error("d1 down")}))
				: Effect.succeed(response as A);
		}) as DrizzleAccess["run"],
		batch: () => Effect.die(new Error("validateSession issues no batch")),
	};
	let marked = 0;
	return {
		access,
		/** Snapshots the runs consumed since the previous mark, per validation. */
		markEffect: () =>
			Effect.sync(() => {
				runsPerEffect.push(runs - marked);
				marked = runs;
			}),
		tally: () => runsPerEffect as ReadonlyArray<number>,
	};
};

/** Captures error-level log lines so a swallowed cause is provably on the pipeline. */
const captureErrors = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<{value: A; errors: ReadonlyArray<string>}, E, R> =>
	Effect.suspend(() => {
		const lines: string[] = [];
		const capture = Logger.layer([
			Logger.make(({logLevel, message}) => {
				if (logLevel !== "Error") return;
				lines.push(String(Array.isArray(message) ? message[0] : message));
			}),
		]);
		return effect.pipe(
			Effect.provide(capture),
			Effect.map((value) => ({value, errors: lines as ReadonlyArray<string>})),
		);
	});

const pasaportOver = (access: DrizzleAccess) =>
	makePasaportLive(authReturning(session)).pipe(Layer.provide(Layer.succeed(Drizzle, access)));

describe("user-activity-day — the upsert builder (#7029)", () => {
	it("renders INSERT … ON CONFLICT DO NOTHING with no engine (.toSQL())", () => {
		const {sql, params} = upsertUserActivityDay(renderDb, USER, DAY).toSQL();
		assert.include(sql.toLowerCase(), 'insert into "user_activity_day"');
		assert.include(sql.toLowerCase(), '"user_id"');
		assert.include(sql.toLowerCase(), '"day"');
		assert.include(sql.toLowerCase(), "on conflict do nothing");
		assert.deepEqual(params, [USER, DAY]);
	});
});

describe("user-activity-day — the UTC day bucket (#7029)", () => {
	it("buckets by UTC calendar day, not local time", () => {
		assert.strictEqual(utcDayBucket(new Date("2026-08-24T23:59:59Z")), "2026-08-24");
		assert.strictEqual(utcDayBucket(new Date("2026-08-25T00:00:00Z")), "2026-08-25");
	});
});

describe("user-activity-day — the isolate-local memo (#7029)", () => {
	it("first touch captures; same day skips; next day captures again", () => {
		resetActivityMemoForTests();
		assert.isTrue(shouldCapture(USER, DAY), "a fresh user/day pair is uncaptured");
		recordCaptured(USER, DAY);
		assert.isFalse(shouldCapture(USER, DAY), "same-day repeat must be skipped");
		assert.isTrue(shouldCapture(USER, "2026-08-25"), "next day is a new bucket");
		resetActivityMemoForTests();
	});
});

describe("Pasaport.validateSession — capture wiring (#7029, epic #6767)", () => {
	it.effect("writes once per user/day; repeated same-isolate validations write nothing", () =>
		Effect.gen(function* () {
			resetActivityMemoForTests();
			// Two validations scripted: ban-read + capture, then ban-read only.
			const scripted = scriptedAccess([[], {}, []]);
			const pasaport = yield* Pasaport.pipe(Effect.provide(pasaportOver(scripted.access)));

			const first = yield* pasaport.validateSession(new Headers());
			yield* scripted.markEffect();
			const second = yield* pasaport.validateSession(new Headers());
			yield* scripted.markEffect();

			assert.strictEqual(first, session);
			assert.strictEqual(second, session);
			// Validation 1 spent two runs (ban read + upsert); validation 2 spent one
			// (ban read alone) — no further writes that day.
			assert.deepEqual(scripted.tally(), [2, 1]);
			resetActivityMemoForTests();
		}),
	);

	it.effect("an injected capture failure leaves the session unchanged, error on the pipeline", () =>
		Effect.gen(function* () {
			resetActivityMemoForTests();
			// Call 0 = ban read (fine); call 1 = the upsert, forced to fail via DrizzleError.
			const scripted = scriptedAccess([[], null]);
			const pasaport = yield* Pasaport.pipe(Effect.provide(pasaportOver(scripted.access)));

			const {value, errors} = yield* captureErrors(pasaport.validateSession(new Headers()));

			assert.strictEqual(value, session, "capture failure must not fail the login");
			assert.include(errors, "[pasaport.captureUserActivityDay]");
			resetActivityMemoForTests();
		}),
	);
});
