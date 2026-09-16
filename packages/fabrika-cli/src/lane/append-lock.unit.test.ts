/**
 * The append lock's own contract at unit tier: a writer that finds the lock held refuses
 * {@link CONCURRENT_WRITE} — distinguishable from an ordinary machine refusal — with the log left
 * byte-identical, while the uncontended path behaves exactly as it did before the lock existed.
 *
 * The stale-lock half is here too, and it is the one with four answers rather than two: a lock aged
 * past the horizon is stolen, a younger one is not, a second waiter already past that horizon still
 * does not get the lock the first one just took, and an explicit budget refuses before any of it is
 * asked. Only the second of those was ever covered.
 *
 * Contention here is scripted (`mkdirExisting`, `duringStat`), not raced: the point is the
 * *deterministic* half of the guarantee, down to placing one writer's whole run inside the other's
 * check-then-act window. The probabilistic half — that two live processes actually collide often
 * enough for the guard to matter — lives in [`append-race.cli.test.ts`](append-race.cli.test.ts),
 * which races real processes against one ledger.
 */
import {Effect, FileSystem} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {acquireLedgerLock, releaseLedgerLock} from "./append-lock.ts";
import {CONCURRENT_WRITE, EVENT_REFUSED, LANE_ABSENT} from "./codes.ts";
import {coderTemplateText, fakeProver, parkCauseRead} from "./fixtures.test-support.ts";
import {runTransition} from "./transition-verb.ts";

const ROOT = ".fabrika/lanes";
const WORKFLOW = `${ROOT}/42/workflow.json`;
const LOG = `${ROOT}/42/events.jsonl`;
const LOCK = `${ROOT}/42/events.lock`;
const HOLDER = `${LOCK}/holder`;

/** The stamp a holder leaves inside the lock: who, and when it took it. */
const stamp = (who: string, ageMs: number) => `${who} ${Date.now() - ageMs}`;

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

	it("a second waiter past the same stale horizon does not take the lock the first one just stole", async () => {
		// Two writers polling one orphaned lock. The loser's staleness verdict is already reached when
		// the winner's whole steal lands, so a steal that acts on that stale verdict takes a *live*
		// lock and both writers append — the silent interleaved read-modify-write the lock exists to
		// refuse. The winner's run is placed inside the loser's `stat` window rather than raced for.
		const appended: string[] = [];
		const seam: Record<string, Effect.Effect<void>> = {};
		const fs = freshLane({
			mkdirExisting: [LOCK],
			mtimes: {[LOCK]: new Date(Date.now() - 60_000)},
			duringStat: seam,
		});
		const waiter = (name: string) =>
			Effect.gen(function* () {
				const filesystem = yield* FileSystem.FileSystem;
				// No release: a holder is mid-body, which is what makes the other one's steal a defect
				// rather than an ordinary hand-off.
				if ((yield* acquireLedgerLock(filesystem, LOCK, 300)) === "acquired") appended.push(name);
			});
		let overtaken = false;
		seam[LOCK] = Effect.suspend(() => {
			if (overtaken) return Effect.void;
			overtaken = true;
			return Effect.provide(waiter("winner"), fs.layer);
		});

		await Effect.runPromise(Effect.provide(waiter("loser"), fs.layer));

		expect(appended).toEqual(["winner"]);
	});

	it("a second waiter over a stamped lock loses it to the writer that took the stamp", async () => {
		// The same pair, one lock older: this one names its holder, so the loser's verdict is the
		// stamp's bytes rather than a directory age. The winner's whole take-over lands inside the
		// loser's read window, and the loser has to notice that what it carries off is no longer the
		// claim it judged.
		const appended: string[] = [];
		const seam: Record<string, Effect.Effect<void>> = {};
		const fs = freshLane({
			mkdirExisting: [LOCK],
			files: {[WORKFLOW]: coderTemplateText(), [HOLDER]: stamp("crashed", 60_000)},
			duringRead: seam,
		});
		const waiter = (name: string) =>
			Effect.gen(function* () {
				const filesystem = yield* FileSystem.FileSystem;
				if ((yield* acquireLedgerLock(filesystem, LOCK, 300)) === "acquired") appended.push(name);
			});
		let overtaken = false;
		seam[HOLDER] = Effect.suspend(() => {
			if (overtaken) return Effect.void;
			overtaken = true;
			return Effect.provide(waiter("winner"), fs.layer);
		});

		await Effect.runPromise(Effect.provide(waiter("loser"), fs.layer));

		expect(appended).toEqual(["winner"]);
	});

	it("a third writer gets nothing while a stealer is putting a live holder's stamp back", async () => {
		// One waiter further out than the pair above. The loser reaches a live holder's stamp, carries
		// it off and has to put it back — and a take-over that carried the *directory* off instead
		// leaves the lock path vacant for exactly that long, so a third writer's mkdir lands and
		// appends beside the holder. Here the directory never moves, so the third writer only ever
		// sees a lock somebody holds.
		const appended: string[] = [];
		const attempts: string[] = [];
		const reads: Record<string, Effect.Effect<void>> = {};
		const renames: Record<string, Effect.Effect<void>> = {};
		const fs = freshLane({
			mkdirExisting: [LOCK],
			files: {[WORKFLOW]: coderTemplateText(), [HOLDER]: stamp("crashed", 60_000)},
			duringRead: reads,
			duringRename: renames,
		});
		const waiter = (name: string) =>
			Effect.gen(function* () {
				const filesystem = yield* FileSystem.FileSystem;
				const attempt = yield* acquireLedgerLock(filesystem, LOCK, 300);
				attempts.push(`${name}:${attempt}`);
				if (attempt === "acquired") appended.push(name);
			});
		let overtaken = false;
		reads[HOLDER] = Effect.suspend(() => {
			if (overtaken) return Effect.void;
			overtaken = true;
			return Effect.provide(waiter("winner"), fs.layer);
		});
		// The winner's own take is the first rename of the stamp; the loser's — the one it must undo —
		// is the second, and that is the instant the third writer asks.
		let moves = 0;
		renames[HOLDER] = Effect.suspend(() => {
			moves += 1;
			return moves === 2 ? Effect.provide(waiter("third"), fs.layer) : Effect.void;
		});

		await Effect.runPromise(Effect.provide(waiter("loser"), fs.layer));

		expect(appended).toEqual(["winner"]);
		expect(attempts).toContain("third:held");
	});

	it("a holder that cannot prove the lock is still its own refuses instead of appending", async () => {
		process.env.FABRIKA_LANE_LOCK_BUDGET_MS = SHORT_LOCK_MS;
		// The last moment a hand-off can still be answered by refusing: the stamp is unreadable, so
		// this writer cannot say the lock is the one it took, and a body that appends anyway is the
		// double-append nobody detects.
		const fs = freshLane({unreadable: [HOLDER]});

		const out = await run(fs);

		expect(out.code).toBe(CONCURRENT_WRITE);
		// It got the lock — the stamp is there — and still refused, which is the whole distinction
		// from the waiter above that never acquired at all.
		expect(fs.written.has(HOLDER)).toBe(true);
		expect(fs.written.get(LOG)).toBeUndefined();
	});

	it("a writer that no longer holds the stamp releases nothing", async () => {
		// A holder slow enough to be taken over must not clear the lock on its way out: the sidecar is
		// the new holder's now, and removing it hands a third writer a lock while that holder appends.
		const fs = freshLane({
			mkdirExisting: [LOCK],
			files: {[WORKFLOW]: coderTemplateText(), [HOLDER]: stamp("someone-else", 0)},
		});

		const standing = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const filesystem = yield* FileSystem.FileSystem;
					yield* releaseLedgerLock(filesystem, LOCK, "a-writer-that-was-overtaken");
					return yield* filesystem.exists(LOCK);
				}),
				fs.layer,
			),
		);

		expect(standing).toBe(true);
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
