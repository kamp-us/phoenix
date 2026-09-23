/**
 * The `task_updated` frame, which is the only thing that ever says a worker *moved* to the
 * background after starting in the foreground.
 *
 * `SDKTaskStartedMessage.is_backgrounded` names three ways a task becomes a background one, and the
 * third is this frame: "A later move to the background arrives as task_updated patch.is_backgrounded"
 * (`sdk.d.ts`, 0.3.259). Unmarked, such a worker keeps #9587's whole symptom —
 * `settleRunningSubagents` (`../../ai-agent/core/state.ts`) flips its slot to `finished` at the end
 * of the turn that spawned it, and the operator loses the row of a worker that is still writing
 * (#9594).
 *
 * **The run is captured; the move is declared.** Every frame below is `subagent-turn.json`'s — the
 * whole 74-frame capture of a turn that spawns one **foreground** worker (`fixtures/PROVENANCE.md`)
 * — and it carries all three frames this behaviour turns on: the `task_started` that pairs the task
 * id with the spawning call, a `task_updated` that carries `task_id` and `patch` and **no
 * `tool_use_id`**, and the `task_notification` that settles it. The one thing no capture holds is a
 * worker actually being moved, because forcing one means driving a live CLI with real credentials
 * and real spend, so `patch.is_backgrounded: true` is set onto the captured frame here and nothing
 * else is — the same route `./task-started.unit.test.ts` takes for its own unforceable field.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {foldEvent} from "@kampus/tuval-sdk/kernel/ai-agent/core/fold";
import {initialState, settleTurn} from "@kampus/tuval-sdk/kernel/ai-agent/core/state";
import type {AgentEvent} from "@kampus/tuval-sdk/kernel/ai-agent/events";
import {describe, expect, it} from "vitest";
import {toAgentEvents} from "./events.ts";
import {loadFixture} from "./fixtures/load.ts";
import {emptyMapping, type Mapping} from "./map.ts";

const AT = 1_700_000_000_000;

/** The `Agent` call that spawned the worker, and the task the backend registered under it. */
const SPAWN = "toolu_000000000000000000000001";
const TASK = "agent000000000001";

const capture = (): Array<SDKMessage> =>
	structuredClone(loadFixture("subagent-turn")) as Array<SDKMessage>;

/** Frame 23 of the capture: the foreground registration that pairs the task with its call. */
const STARTED = 23;
/** Frame 33: the captured update, whose patch says the task completed and names no call. */
const UPDATED = 33;
/** Frame 34: the notification that settles the task. */
const NOTIFIED = 34;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const frameAt = (stream: ReadonlyArray<SDKMessage>, index: number): SDKMessage => {
	const frame = stream[index];
	if (frame === undefined) throw new Error(`the capture carries no frame ${index}`);
	return frame;
};

/** Write the declared half of a case onto one captured frame, in place. */
const setOn = (frame: SDKMessage, fields: Record<string, unknown>): SDKMessage => {
	if (isRecord(frame)) Object.assign(frame, fields);
	return frame;
};

/** The same, onto that frame's `patch` — which is where a move to the background is stated. */
const setOnPatch = (frame: SDKMessage, fields: Record<string, unknown>): SDKMessage => {
	// Read through `unknown`, because the union's other members declare no `patch` at all.
	const open: unknown = frame;
	if (isRecord(open) && isRecord(open.patch)) Object.assign(open.patch, fields);
	return frame;
};

/** The captured run up to and including the registration, which is where the pairing is learned. */
const registered = (): Array<SDKMessage> => capture().slice(0, STARTED + 1);

/**
 * The captured `task_updated` frame with the field no capture could carry set on its patch. The
 * rest of the frame — its task id, its uuid, the captured patch fields — is untouched.
 */
const moveToBackground = (patch: Record<string, unknown> = {is_backgrounded: true}): SDKMessage =>
	setOnPatch(capturedUpdate(), patch);

/** The captured update as it stands, whose patch says nothing about backgroundedness. */
const capturedUpdate = (): SDKMessage => frameAt(capture(), UPDATED);

const notified = (): SDKMessage => frameAt(capture(), NOTIFIED);

const run = (stream: ReadonlyArray<SDKMessage>, mapping: Mapping = emptyMapping) => {
	const events: AgentEvent[] = [];
	let current = mapping;
	for (const one of stream) {
		const step = toAgentEvents(one, current, {at: AT});
		current = step.mapping;
		events.push(...step.events);
	}
	return {events, mapping: current};
};

/** The state a window holds after these events, which is what the running list is read off. */
const folded = (events: ReadonlyArray<AgentEvent>) =>
	events.reduce((state, one) => foldEvent(state, one, {}), initialState("/repo"));

const rows = (events: ReadonlyArray<AgentEvent>) =>
	events.flatMap((event) => (event.kind === "item" ? [event.item] : []));

/** The line the collapsed notice row at `index` carries, or `null` when that row is not one. */
const noticeText = (events: ReadonlyArray<AgentEvent>, index: number): string | null => {
	const row = rows(events).at(index);
	return row !== undefined && row.kind === "system" ? row.text : null;
};

const moved = (): ReadonlyArray<SDKMessage> => [...registered(), moveToBackground()];

describe("a worker moved to the background mid-run", () => {
	it("marks the slot the frame's task id names", () => {
		const {mapping} = run(moved());
		expect(mapping.subagents.get(SPAWN)).toMatchObject({
			id: SPAWN,
			type: "general-purpose",
			status: "running",
			outlivesTurn: true,
		});
	});

	it("emits a subagent event carrying that slot", () => {
		const {events} = run(moved());
		expect(events.at(-1)).toMatchObject({
			kind: "subagent",
			slot: {id: SPAWN, outlivesTurn: true},
		});
	});

	/** #9594's whole symptom, and #9587's before it: the turn's end took a live worker's row out. */
	it("stays running across the end of the turn that spawned it", () => {
		const state = settleTurn(folded(run(moved()).events));
		expect(state.subagents[SPAWN]?.status).toBe("running");
		expect(state.subagents[SPAWN]?.outlivesTurn).toBe(true);
	});

	it("draws the collapsed notice row the frame already drew, and takes none away", () => {
		const before = rows(run(registered()).events);
		const after = rows(run(moved()).events);
		expect(after).toHaveLength(before.length + 1);
		expect(noticeText(run(moved()).events, -1)).toBe("task updated");
	});

	it("ends on its own notice, the way every marked slot does", () => {
		const {mapping} = run([...moved(), notified()]);
		expect(mapping.subagents.get(SPAWN)?.status).toBe("finished");
	});

	it("marks nothing twice: a second move re-emits no slot", () => {
		const {events} = run([...moved(), moveToBackground()]);
		const marks = events.filter((event) => event.kind === "subagent" && event.slot.outlivesTurn);
		expect(marks).toHaveLength(1);
	});
});

/**
 * The index the arm needs: `SDKTaskUpdatedMessage` declares `task_id`, `patch`, `uuid` and
 * `session_id` and no `tool_use_id` (`sdk.d.ts`, 0.3.259), and the captured frame carries exactly
 * those — so without a pairing learned elsewhere the frame reaches no slot at all.
 */
describe("the task-to-call correlation the frame has no id of its own for", () => {
	it("is not something the update frame itself could carry", () => {
		expect(capturedUpdate()).not.toHaveProperty("tool_use_id");
	});

	it("is learned from the task_started frame that carries both ids", () => {
		const {mapping} = run(registered());
		expect(mapping.tasks.get(TASK)).toBe(SPAWN);
	});

	it("is learned from the task_notification frame too", () => {
		const {mapping} = run([...capture().slice(0, STARTED), notified()]);
		expect(mapping.tasks.get(TASK)).toBe(SPAWN);
	});

	it("is not written from a registration carrying a task id and no call", () => {
		const stream = registered();
		setOn(frameAt(stream, STARTED), {tool_use_id: undefined});
		expect(run(stream).mapping.tasks.size).toBe(0);
	});
});

describe("a task_updated frame that must leave the slot exactly as it was", () => {
	const unchanged = (stream: ReadonlyArray<SDKMessage>) => {
		const {mapping, events} = run(stream);
		expect(mapping.subagents.get(SPAWN)?.outlivesTurn).toBeUndefined();
		expect(events.every((event) => event.kind !== "subagent" || !event.slot.outlivesTurn)).toBe(
			true,
		);
		// The notice row is never the thing withheld: the arm adds a slot and takes no row away.
		expect(noticeText(events, -1)).toBe("task updated");
	};

	it("carries no is_backgrounded at all, which is what the capture itself carries", () => {
		unchanged([...registered(), capturedUpdate()]);
	});

	it("carries is_backgrounded false", () => {
		unchanged([...registered(), moveToBackground({is_backgrounded: false})]);
	});

	it("names a task no frame ever paired with a call", () => {
		unchanged([...registered(), setOn(moveToBackground(), {task_id: "agent000000000099"})]);
	});

	it("names a call this mapping opened no slot for", () => {
		// The registration is re-keyed onto a call the capture never made, so the pairing lands on a
		// call with no slot — which is every backgrounded `local_bash` task, none of which is a worker.
		const stream = registered();
		setOn(frameAt(stream, STARTED), {tool_use_id: "toolu_000000000000000000000099"});
		const {mapping} = run([...stream, moveToBackground()]);
		expect(mapping.subagents.get("toolu_000000000000000000000099")).toBeUndefined();
		expect(mapping.subagents.get(SPAWN)?.outlivesTurn).toBeUndefined();
	});

	it("names a slot that already finished", () => {
		// The whole captured run settles the foreground worker on its own `tool_result`.
		const {mapping} = run([...capture(), moveToBackground()]);
		expect(mapping.subagents.get(SPAWN)?.status).toBe("finished");
		expect(mapping.subagents.get(SPAWN)?.outlivesTurn).toBeUndefined();
	});
});

describe("every other frame the dispatch still routes where it did", () => {
	it("sends an unrecognized system subtype to the collapsed notice", () => {
		const thinking = capture().find(
			(frame) => (frame as {subtype?: string}).subtype === "thinking_tokens",
		);
		const step = toAgentEvents(thinking as SDKMessage, emptyMapping, {at: AT});
		expect(step.mapping).toBe(emptyMapping);
		expect(noticeText(step.events, 0)).toBe("thinking tokens");
	});
});
