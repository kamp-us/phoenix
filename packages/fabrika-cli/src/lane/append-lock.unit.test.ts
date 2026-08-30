/**
 * The append lock's own contract at unit tier (#5994): a writer that finds the lock held refuses
 * {@link CONCURRENT_WRITE} — distinguishable from an ordinary machine refusal — with the log left
 * byte-identical, while the uncontended path behaves exactly as it did before the lock existed.
 *
 * Contention here is scripted (`mkdirExisting`), not raced: the point is the *deterministic* half
 * of the guarantee. The probabilistic half — that two live processes actually collide often enough
 * for the guard to matter — lives in [`append-race.cli.test.ts`](append-race.cli.test.ts), which
 * races real processes against one ledger.
 */
import {Effect} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {CONCURRENT_WRITE, EVENT_REFUSED} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
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
			runTransition({
				root: ROOT,
				lane: "42",
				event: "WIP",
				task: null,
				cause: null,
				classes: [],
				waitGrant: null,
			}),
			fs.layer,
		),
	);

const SHORT_LOCK_MS = "120";

describe("lane append lock (#5994)", {timeout: 10_000}, () => {
	afterEach(() => {
		delete process.env["FABRIKA_LANE_LOCK_BUDGET_MS"];
	});
	it("a writer that finds the lock held refuses CONCURRENT_WRITE and leaves the log untouched", async () => {
		process.env["FABRIKA_LANE_LOCK_BUDGET_MS"] = SHORT_LOCK_MS;
		const fs = freshLane({mkdirExisting: [LOCK]});

		const out = await run(fs);
		expect(out.code).toBe(CONCURRENT_WRITE);
		expect(out.stderr.join(" ")).toContain("another writer holds");
		expect(out.stderr.join(" ")).toContain(LOCK);
		// Byte-identical: no events.jsonl was ever created by the losing writer.
		expect(fs.written.get(LOG)).toBeUndefined();
	});

	it("the refusal is distinguishable from an ordinary machine refusal on the same event", async () => {
		process.env["FABRIKA_LANE_LOCK_BUDGET_MS"] = SHORT_LOCK_MS;
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

	it("the uncontended path appends exactly as before the lock existed", async () => {
		const fs = freshLane();

		const out = await run(fs);
		expect(out.code).toBe(0);
		const appended = fs.written.get(LOG);
		expect(appended).toBeDefined();
		expect(JSON.parse(appended?.trim() ?? "")).toMatchObject({task: "issue", event: "ISSUE.WIP"});
	});
});
