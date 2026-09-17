/** The store under a name key — a chore lane placed, read back, and refused when one is there. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {choreTemplateText} from "./fixtures.test-support.ts";
import {laneRef, parseKey} from "./key.ts";
import {DEFAULT_CHORES_ROOT, loadLane, placeMachine} from "./store.ts";

const CHORE = "park-sweep";
const DIR = `${DEFAULT_CHORES_ROOT}/${CHORE}`;
const WORKFLOW = `${DIR}/workflow.json`;
const LOG = `${DIR}/events.jsonl`;

const ref = () => {
	const parsed = parseKey(`chore:${CHORE}`);
	if (parsed._tag !== "Key") throw new Error(parsed.reason);
	return laneRef(parsed.key, null);
};

describe("the lane store under a name key", () => {
	it("places a chore lane's machine under the chores root", async () => {
		const fs = fakeFs({files: {}});
		const placed = await Effect.runPromise(
			Effect.provide(placeMachine(ref(), choreTemplateText()), fs.layer),
		);

		expect(placed).toMatchObject({_tag: "Placed", dir: DIR, workflow: WORKFLOW});
		expect(fs.written.get(WORKFLOW)).toBe(choreTemplateText());
	});

	it("loads a placed chore lane back as a fresh, event-less lane", async () => {
		const fs = fakeFs({files: {[WORKFLOW]: choreTemplateText()}});
		const loaded = await Effect.runPromise(Effect.provide(loadLane(ref()), fs.layer));

		expect(loaded._tag).toBe("Loaded");
		if (loaded._tag !== "Loaded") return;
		expect(loaded.logPath).toBe(LOG);
		expect(loaded.entries).toEqual([]);
		expect(Object.keys(loaded.lane.tasks)).toEqual(["park_sweep"]);
	});

	it("refuses a collision with an existing chore lane and writes nothing", async () => {
		const fs = fakeFs({files: {}, directories: [DIR]});
		const placed = await Effect.runPromise(
			Effect.provide(placeMachine(ref(), choreTemplateText()), fs.layer),
		);

		expect(placed).toEqual({_tag: "Exists", dir: DIR});
		expect(fs.written.size).toBe(0);
	});

	it("proves a chore lane absent by its own directory, never by the issue lanes root", async () => {
		const fs = fakeFs({files: {}});
		const loaded = await Effect.runPromise(Effect.provide(loadLane(ref()), fs.layer));

		expect(loaded).toEqual({_tag: "Absent", dir: DIR});
	});

	it("keeps an unreadable chore lane UNKNOWN rather than absent", async () => {
		const fs = fakeFs({files: {[WORKFLOW]: choreTemplateText()}, unreadable: [WORKFLOW]});
		const loaded = await Effect.runPromise(Effect.provide(loadLane(ref()), fs.layer));

		expect(loaded).toMatchObject({_tag: "Unreadable", path: WORKFLOW});
		if (loaded._tag !== "Unreadable") return;
		expect(loaded.reason).toContain("PermissionDenied");
	});
});

/**
 * The split between absence and UNKNOWN is the read's own failure, so a probe that CONTRADICTS the
 * read is what a test has to script: a filesystem whose `exists` says the path is there, or cannot
 * answer at all, while the read said `NotFound`. Under a second sample both of these were
 * `Unreadable` — the false exit `11` a racing writer earned.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9315
 */
describe("the lane store's absent-versus-unreadable split", () => {
	it("proves the workflow absent off its own NotFound while the path reads present", async () => {
		const fs = fakeFs({files: {}, directories: [WORKFLOW]});
		const loaded = await Effect.runPromise(Effect.provide(loadLane(ref()), fs.layer));

		expect(loaded).toEqual({_tag: "Absent", dir: DIR});
	});

	it("proves the workflow absent off its own NotFound while the path cannot be probed", async () => {
		const fs = fakeFs({files: {}, unprobeable: [WORKFLOW]});
		const loaded = await Effect.runPromise(Effect.provide(loadLane(ref()), fs.layer));

		expect(loaded).toEqual({_tag: "Absent", dir: DIR});
	});

	it("loads an event-less lane off the log's own NotFound while the log reads present", async () => {
		const fs = fakeFs({files: {[WORKFLOW]: choreTemplateText()}, directories: [LOG]});
		const loaded = await Effect.runPromise(Effect.provide(loadLane(ref()), fs.layer));

		expect(loaded._tag).toBe("Loaded");
		if (loaded._tag !== "Loaded") return;
		expect(loaded.entries).toEqual([]);
	});

	it("loads an event-less lane off the log's own NotFound while the log cannot be probed", async () => {
		const fs = fakeFs({files: {[WORKFLOW]: choreTemplateText()}, unprobeable: [LOG]});
		const loaded = await Effect.runPromise(Effect.provide(loadLane(ref()), fs.layer));

		expect(loaded._tag).toBe("Loaded");
		if (loaded._tag !== "Loaded") return;
		expect(loaded.entries).toEqual([]);
	});

	it("keeps a log that failed for any other reason UNKNOWN, carrying that reason", async () => {
		const fs = fakeFs({
			files: {[WORKFLOW]: choreTemplateText(), [LOG]: ""},
			unreadable: [LOG],
		});
		const loaded = await Effect.runPromise(Effect.provide(loadLane(ref()), fs.layer));

		expect(loaded).toMatchObject({_tag: "Unreadable", path: LOG});
		if (loaded._tag !== "Unreadable") return;
		expect(loaded.reason).toContain("PermissionDenied");
	});
});
