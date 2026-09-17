/**
 * Lane admission — what a `lane` argument is allowed to reach.
 *
 * The run each verb would perform is substituted here, so "the refusal happened first" is an
 * assertion rather than a reading of the source: a refused key leaves the substituted run
 * uninvoked and the substituted filesystem unwritten.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {answer, type VerbOutcome} from "../verb.ts";
import {admitBoardKey, admitKey} from "./admission.ts";
import {KEY_MALFORMED} from "./codes.ts";
import type {LaneKey} from "./key.ts";
import type {LaneRef} from "./store.ts";

const REPO = "/work/repo";
const ROOT = "/work/repo/.fabrika/lanes";

interface Spy {
	readonly keys: Array<LaneKey>;
	readonly refs: Array<LaneRef>;
}

const spy = (): Spy => ({keys: [], refs: []});

/** A stand-in for whatever the verb would have done — it records that it ran, and nothing else. */
const recording =
	(into: Spy) =>
	(key: LaneKey, ref: LaneRef): Effect.Effect<VerbOutcome> => {
		into.keys.push(key);
		into.refs.push(ref);
		return Effect.succeed(answer(""));
	};

const admit = (raw: string, into: Spy, fs: ReturnType<typeof fakeFs>) =>
	Effect.runPromise(Effect.provide(admitKey("open", raw, ROOT, REPO, recording(into)), fs.layer));

const grounded = () => fakeFs({files: {}, directories: [`${REPO}/.git`, ROOT]});

describe("a keyed lane verb's admission", () => {
	it("refuses a traversal before the verb runs and before anything is written", async () => {
		const ran = spy();
		const fs = grounded();
		const out = await admit("../chores/park-sweep", ran, fs);

		expect(out.code).toBe(KEY_MALFORMED);
		expect(ran.keys).toEqual([]);
		expect(fs.written.size).toBe(0);
	});

	it("refuses an empty key the same way rather than resolving it to the root itself", async () => {
		const ran = spy();
		const fs = grounded();
		const out = await admit("", ran, fs);

		expect(out.code).toBe(KEY_MALFORMED);
		expect(ran.keys).toEqual([]);
		expect(fs.written.size).toBe(0);
	});

	it("hands the verb the canonical leaf, so a padded key addresses the lane 5673 already owns", async () => {
		const ran = spy();
		const out = await admit("05673", ran, grounded());

		expect(out.code).toBe(0);
		expect(ran.refs).toEqual([{root: ROOT, lane: "5673"}]);
		expect(ran.keys).toEqual([{_tag: "Issue", lane: "5673"}]);
	});

	it("leaves a canonical key reaching exactly the lane it always did", async () => {
		const ran = spy();
		const out = await admit("5673", ran, grounded());

		expect(out.code).toBe(0);
		expect(ran.refs).toEqual([{root: ROOT, lane: "5673"}]);
	});

	it("keeps a chore key on the chores root the caller named", async () => {
		const ran = spy();
		const out = await admit("chore:park-sweep", ran, grounded());

		expect(out.code).toBe(0);
		expect(ran.refs).toEqual([{root: ROOT, lane: "park-sweep"}]);
	});
});

describe("a board-ground lane verb's admission", () => {
	const board = (raw: string, seen: Array<LaneKey>) =>
		Effect.runPromise(
			admitBoardKey(raw, (key) => {
				seen.push(key);
				return Effect.succeed(answer(""));
			}),
		);

	it("refuses a traversal before any board operation is reached", async () => {
		const seen: Array<LaneKey> = [];
		const out = await board("../chores/park-sweep", seen);

		expect(out.code).toBe(KEY_MALFORMED);
		expect(seen).toEqual([]);
	});

	it("races a padded spelling on the issue it drives, not on a second identity", async () => {
		const seen: Array<LaneKey> = [];
		const out = await board("05673", seen);

		expect(out.code).toBe(0);
		expect(seen).toEqual([{_tag: "Issue", lane: "5673"}]);
	});
});
