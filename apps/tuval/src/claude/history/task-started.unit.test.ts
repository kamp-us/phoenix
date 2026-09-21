/**
 * The `task_started` frame, which is the only thing that ever names a *resumed* background worker.
 *
 * A resume is a message to an agent that is already alive: no `Agent` call is made, so no call
 * carries `subagent_type`, so nothing in `assistantEvents` opens a slot and the running list drew
 * nothing at all for such a worker (#9587). `SDKTaskStartedMessage.is_backgrounded` is what says the
 * task is one — "A resumed subagent is always registered in the background" (`sdk.d.ts`, 0.3.259).
 *
 * **These frames are declaration-derived, not captured.** Forcing one means driving a live CLI with
 * real credentials and real spend, and the CLI records the frame as an `attachment` row rather than
 * the SDK's own envelope (`fixtures/PROVENANCE.md`, "What is not captured"). Each frame below is
 * `SDKTaskStartedMessage` as `sdk.d.ts` declares it at the `0.3.259` catalog pin, and nothing else —
 * the same route `../agent/conversation-reset.unit.test.ts` takes for its own uncapturable frame.
 * The captured half of this behaviour, the background *launch*, is asserted in `events.unit.test.ts`
 * against `fixtures/background-subagent-turn.json`.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {describe, expect, it} from "vitest";
import {foldEvent} from "../../ai-agent/core/fold.ts";
import {initialState, settleTurn} from "../../ai-agent/core/state.ts";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {toAgentEvents} from "./events.ts";
import {emptyMapping, type Mapping} from "./map.ts";

const AT = 1_700_000_000_000;
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
/** The resuming `SendMessage` call: a resumed worker's task is registered under its id. */
const RESUME = "toolu_000000000000000000000009";

interface StartedFields {
	readonly tool_use_id?: string;
	readonly subagent_type?: string;
	readonly is_backgrounded?: boolean;
	readonly task_type?: string;
	readonly ambient?: boolean;
	readonly skip_transcript?: boolean;
}

const started = (fields: StartedFields): SDKMessage =>
	({
		type: "system",
		subtype: "task_started",
		task_id: "a0000000000000009",
		description: "Capture probe worker",
		uuid: "00000000-0000-4000-8000-000000000091",
		session_id: SESSION_ID,
		...fields,
	}) as SDKMessage;

const notice = (toolUseId: string): SDKMessage =>
	({
		type: "system",
		subtype: "task_notification",
		task_id: "a0000000000000009",
		tool_use_id: toolUseId,
		status: "completed",
		output_file: "/tmp/tuval-capture/state/tasks/a0000000000000009.output",
		summary: 'Agent "Capture probe worker" finished',
		uuid: "00000000-0000-4000-8000-000000000092",
		session_id: SESSION_ID,
	}) as SDKMessage;

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

describe("a background task the backend registers", () => {
	const resumed = started({
		tool_use_id: RESUME,
		task_type: "local_agent",
		is_backgrounded: true,
	});

	it("opens a slot for a worker no spawning call ever named", () => {
		const {mapping} = run([resumed]);
		expect(mapping.subagents.get(RESUME)).toMatchObject({
			id: RESUME,
			status: "running",
			outlivesTurn: true,
		});
	});

	it("draws the collapsed notice row the frame already drew, and takes none away", () => {
		const {events} = run([resumed]);
		const rows = events.flatMap((event) => (event.kind === "item" ? [event.item] : []));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind === "system" && rows[0].text).toBe("task started");
	});

	/**
	 * #9587's whole symptom: the slot was there for seconds and the turn's end took it out. A
	 * `running` slot is what the list draws its row from — `runningSubagents` over exactly this shape
	 * is `../../shell/chat/subagents.unit.test.ts`'s, which is the project that may import the shell.
	 */
	it("leaves the worker running across the end of the turn that registered it", () => {
		const state = settleTurn(folded(run([resumed]).events));
		expect(state.subagents[RESUME]?.status).toBe("running");
		expect(state.subagents[RESUME]?.outlivesTurn).toBe(true);
	});

	it("ends that slot on the task notice for the same call", () => {
		const {mapping} = run([resumed, notice(RESUME)]);
		expect(mapping.subagents.get(RESUME)?.status).toBe("finished");
	});

	it("names the worker by its subagent type when the frame carries one", () => {
		const {mapping} = run([
			started({tool_use_id: RESUME, subagent_type: "Explore", is_backgrounded: true}),
		]);
		expect(mapping.subagents.get(RESUME)?.type).toBe("Explore");
	});
});

/**
 * What this frame must *not* open a row for. `is_backgrounded` is set for `local_bash` tasks too,
 * and a foreground worker already has its slot from its own call — a mark here would keep that one
 * in the list a frame past the `tool_result` that ends it.
 */
describe("a task that is not a background worker of this session's", () => {
	it.each([
		["a foreground registration", {tool_use_id: RESUME, task_type: "local_agent"}],
		[
			"a backgrounded Bash, which names no subagent type",
			{tool_use_id: RESUME, task_type: "local_bash", is_backgrounded: true},
		],
		[
			"an ambient housekeeping task",
			{tool_use_id: RESUME, task_type: "local_agent", is_backgrounded: true, ambient: true},
		],
		[
			"a task the CLI keeps out of the transcript",
			{
				tool_use_id: RESUME,
				task_type: "local_agent",
				is_backgrounded: true,
				skip_transcript: true,
			},
		],
		[
			"a frame naming no call, which is the slot's key",
			{task_type: "local_agent", is_backgrounded: true},
		],
	] as ReadonlyArray<readonly [string, StartedFields]>)("opens no slot for %s", (_name, fields) => {
		const {mapping, events} = run([started(fields)]);
		expect(mapping.subagents.size).toBe(0);
		expect(events.every((event) => event.kind === "item")).toBe(true);
	});
});
