/**
 * The append lock's own contract at unit tier: a writer that finds the lock held refuses
 * {@link CONCURRENT_WRITE} — distinguishable from an ordinary machine refusal — with the log left
 * byte-identical, while the uncontended path behaves exactly as it did before the lock existed.
 *
 * The stale-lock half is here too, and it is the one with three answers rather than two: a lock aged
 * past the horizon is stolen, a younger one is not, and an explicit budget refuses before either
 * question is asked. Only the middle of those was ever covered.
 *
 * Contention here is scripted (`mkdirExisting`), not raced: the point is the *deterministic* half
 * of the guarantee. The probabilistic half — that two live processes actually collide often enough
 * for the guard to matter — lives in [`append-race.cli.test.ts`](append-race.cli.test.ts), which
 * races real processes against one ledger.
 */
import {Effect, FileSystem} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {acquireLedgerLock} from "./append-lock.ts";
import {CONCURRENT_WRITE, EVENT_REFUSED, LANE_ABSENT} from "./codes.ts";
import {coderTemplateText, fakeProver, parkCauseRead} from "./fixtures.test-support.ts";
import {runTransition} from "./transition-verb.ts";

const ROOT = ".fabrika/lanes";
const WORKFLOW = `${ROOT}/42/workflow.json`;
const LOG = `${ROOT}/42/events.jsonl`;
const LOCK = `${ROOT}/42/events.lock`;

const freshLane = (extra: Parameters<typeof fakeFs>[0] = {}) =>
	fakeFs({
		files: {[WORKFLOW]: coderTemplateText()},
		...extra,
	});

const run = (fs: ReturnType<typeof fakeFs>) =>
	Effect.runPromise(
		Effect.provide(
			runTransition(
				{
					root: ROOT,
					lane: "42",
					event: "WIP",
					task: null,
					cause: null,
					parkCause: parkCauseRead(),
					classes: [],
					waitGrant: null,
					rationale: null,
					repo: "o/r",
					cwd: "/checkout",
					env: {},
				},
				fakeProver().prove,
			),
			fs.layer,
		),
	);

const SHORT_LOCK_MS = "120";

describe("lane append lock", {timeout: 10_000}, () => {
	afterEach(() => {
		delete process.env.FABRIKA_LANE_LOCK_BUDGET_MS;
	});
	it("a writer that finds the lock held refuses CONCURRENT_WRITE and leaves the log untouched", async () => {
		process.env.FABRIKA_LANE_LOCK_BUDGET_MS = SHORT_LOCK_MS;
		const fs = freshLane({mkdirExisting: [LOCK]});

		const out = await run(fs);
		expect(out.code).toBe(CONCURRENT_WRITE);
		expect(out.stderr.join(" ")).toContain("another writer holds");
		expect(out.stderr.join(" ")).toContain(LOCK);
		// Byte-identical: no events.jsonl was ever created by the losing writer.
		expect(fs.written.get(LOG)).toBeUndefined();
	});

	it("the refusal is distinguishable from an ordinary machine refusal on the same event", async () => {
		process.env.FABRIKA_LANE_LOCK_BUDGET_MS = SHORT_LOCK_MS;
		const heldLock = freshLane({mkdirExisting: [LOCK]});
		const machineRefusal = freshLane({
			files: {
				[WORKFLOW]: coderTemplateText(),
				[LOG]: `${JSON.stringify({task: "issue", event: "ISSUE.WIP", at: "2026-08-16T00:00:00.000Z"})}\n`,
			},
		});

		const lockedOut = await run(heldLock);
		const refused = await run(machineRefusal);
		// Same event, two different seats: "retry me" versus "this event is invalid".
		expect(lockedOut.code).toBe(CONCURRENT_WRITE);
		expect(refused.code).toBe(EVENT_REFUSED);
		expect(lockedOut.code).not.toBe(refused.code);
		// And the wording itself carries the distinction, not just the number.
		expect(lockedOut.stderr.join(" ")).toContain("retry this exact event");
	});

	it("a lock whose parent directory is absent reports absent, without spending the budget", async () => {
		const fs = fakeFs({mkdirMissingParent: [LOCK]});
		const started = Date.now();

		const attempt = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const filesystem = yield* FileSystem.FileSystem;
					return yield* acquireLedgerLock(filesystem, LOCK, 5_000);
				}),
				fs.layer,
			),
		);

		expect(attempt).toBe("absent");
		// The whole defect was polling this one out: an ENOENT read as contention waits for a holder
		// that cannot arrive.
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("an appending verb on an absent lane refuses LANE_ABSENT, writing and creating nothing", async () => {
		process.env.FABRIKA_LANE_LOCK_BUDGET_MS = SHORT_LOCK_MS;
		const fs = fakeFs({});

		const out = await run(fs);
		expect(out.code).toBe(LANE_ABSENT);
		expect(out.stderr.join(" ")).toContain("no lane at");
		expect(fs.written.size).toBe(0);
		// The lane directory stays absent: a ledger nobody booted is not this verb's to manufacture.
		const made = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const filesystem = yield* FileSystem.FileSystem;
					return yield* filesystem.exists(`${ROOT}/42`);
				}),
				fs.layer,
			),
		);
		expect(made).toBe(false);
	});

	it("a lane that goes away after the probe still refuses LANE_ABSENT, not a held lock", async () => {
		process.env.FABRIKA_LANE_LOCK_BUDGET_MS = SHORT_LOCK_MS;
		// The probe passes and the mkdir then hits ENOENT — the window between the two, which only the
		// lock's own reason read can answer.
		const fs = freshLane({mkdirMissingParent: [LOCK]});

		const out = await run(fs);
		expect(out.code).toBe(LANE_ABSENT);
		expect(fs.written.get(LOG)).toBeUndefined();
	});

	it("an absent lane and a held lock keep their own seats", async () => {
		process.env.FABRIKA_LANE_LOCK_BUDGET_MS = SHORT_LOCK_MS;

		const absent = await run(fakeFs({}));
		const held = await run(freshLane({mkdirExisting: [LOCK]}));

		expect(absent.code).toBe(LANE_ABSENT);
		expect(held.code).toBe(CONCURRENT_WRITE);
		expect(held.stderr.join(" ")).toContain("another writer holds");
	});

	it("a lock aged past the stale horizon is stolen by a waiting writer, not refused", async () => {
		// The crashed holder: the sidecar is there, its mtime is a minute old, and nothing will ever
		// release it. Before the fix the waiter reached a `stale` verdict, never removed the
		// directory, and polled to its deadline against a lock nobody held.
		const fs = freshLane({
			mkdirExisting: [LOCK],
			mtimes: {[LOCK]: new Date(Date.now() - 60_000)},
		});

		const attempt = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const filesystem = yield* FileSystem.FileSystem;
					return yield* acquireLedgerLock(filesystem, LOCK, 5_000);
				}),
				fs.layer,
			),
		);

		expect(attempt).toBe("acquired");
	});

	it("a lock younger than the stale horizon is still held at deadline, so live contention refuses", async () => {
		const fs = freshLane({
			mkdirExisting: [LOCK],
			mtimes: {[LOCK]: new Date(Date.now() - 200)},
		});

		const attempt = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const filesystem = yield* FileSystem.FileSystem;
					return yield* acquireLedgerLock(filesystem, LOCK, 200);
				}),
				fs.layer,
			),
		);

		// A live writer's lock is not this waiter's to take: stealing it is the silent double-append
		// the whole lock exists to prevent.
		expect(attempt).toBe("held");
	});

	it("a small FABRIKA_LANE_LOCK_BUDGET_MS refuses fast instead of waiting out the derived default", async () => {
		process.env.FABRIKA_LANE_LOCK_BUDGET_MS = SHORT_LOCK_MS;
		const fs = freshLane({mkdirExisting: [LOCK], mtimes: {[LOCK]: new Date()}});
		const started = Date.now();

		const out = await run(fs);

		expect(out.code).toBe(CONCURRENT_WRITE);
		// The override is the whole point of the knob: the default budget now outlasts the stale
		// horizon, and a test or interactive shell must not inherit that wait.
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("the uncontended path appends exactly as before the lock existed", async () => {
		const fs = freshLane();

		const out = await run(fs);
		expect(out.code).toBe(0);
		const appended = fs.written.get(LOG);
		expect(appended).toBeDefined();
		expect(JSON.parse(appended?.trim() ?? "")).toMatchObject({task: "issue", event: "ISSUE.WIP"});
	});
});
