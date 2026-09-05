/**
 * Property-style: random Msg streams through `update`, checking the invariants no single case can
 * establish — the tail stays inside the planner's bounds, no item is silently lost, and whatever
 * the stream does the state is still something a checkpoint could be read back from.
 *
 * The generator is the seeded one the history bounds already use, so a red run is reproducible
 * from the seed it prints and the suite takes on no property-testing dependency.
 */

import {applyCellChecked} from "@demlik/tea";
import {describe, expect, it} from "vitest";
import {
	assistantItem,
	randomStream,
	systemItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import type {AgentEvent, Phase} from "../events.ts";
import {groupBytes} from "../history/index.ts";
import {Mode, type PermissionDecision} from "../ports/index.ts";
import {aiAgentSessionMachine} from "./machine.ts";
import type {AiAgentSessionCmd, AiAgentSessionMsg} from "./messages.ts";
import {isAiAgentSessionState} from "./snapshot.ts";
import {type AiAgentSessionState, initialState} from "./state.ts";

const ITEM_LIMIT = 8;
const BYTE_LIMIT = 4_000;
const SENT_AT = 1_700_000_000_000;

const machine = aiAgentSessionMachine({
	cwd: "/repo",
	itemLimit: ITEM_LIMIT,
	byteLimit: BYTE_LIMIT,
});

const phases: ReadonlyArray<Phase> = [
	"idle",
	"starting",
	"ready",
	"prompting",
	"reconnecting",
	"gone",
];

const decisions: ReadonlyArray<PermissionDecision> = ["allow-once", "allow-always", "deny"];

/** One random Msg, plus whether it introduced a transcript item nothing had seen before. */
const randomMsg = (
	random: ReturnType<typeof randomStream>,
	step: number,
): {readonly msg: AiAgentSessionMsg; readonly newItem: boolean} => {
	const id = `i${step}`;
	switch (random.int(10)) {
		case 0:
			return {msg: {type: "start", cwd: "/repo", resume: null}, newItem: false};
		case 1:
			return {msg: {type: "started", sessionId: "session-1"}, newItem: false};
		case 2:
			// Whether this records an item depends on the phase it lands on, so `drive` decides it.
			// The text is keyed to the step so no random `user` item can read as this turn's echo.
			return {
				msg: {
					type: "prompt",
					text: `prompt ${id}: ${"x".repeat(random.int(80))}`,
					key: id,
					timestamp: SENT_AT + step,
				},
				newItem: false,
			};
		case 3:
			return {
				msg: {
					type: "event",
					sessionId: "session-1",
					event: {kind: "phase", phase: phases[random.int(phases.length)] ?? "ready"},
				},
				newItem: false,
			};
		case 4:
			return {
				msg: {
					type: "event",
					sessionId: "session-1",
					event: {
						kind: "permission",
						request: `req-${random.int(4)}`,
						detail: {
							title: "Write",
							displayName: "write_file",
							description: "d",
							input: {path: id},
							offersAlways: random.chance(0.5),
						},
					},
				},
				newItem: false,
			};
		case 5:
			return {
				msg: {
					type: "answer",
					request: `req-${random.int(4)}`,
					decision: decisions[random.int(decisions.length)] ?? "deny",
				},
				newItem: false,
			};
		case 6:
			return {
				msg: {
					type: "event",
					sessionId: "session-1",
					event: {
						kind: "usage",
						model: "claude-opus-5",
						inputTokens: random.int(500),
						outputTokens: random.int(500),
						cost: random.int(100) / 1_000,
					},
				},
				newItem: false,
			};
		case 7:
			return {
				msg: {
					type: "event",
					sessionId: "session-1",
					event: {
						kind: "mode",
						current: Mode.make("plan"),
						available: [Mode.make("plan"), Mode.make("build")],
					},
				},
				newItem: false,
			};
		case 8:
			return {msg: {type: "interrupt"}, newItem: false};
		default:
			return {
				msg: {type: "event", sessionId: "session-1", event: randomItem(random, id)},
				newItem: true,
			};
	}
};

const randomItem = (random: ReturnType<typeof randomStream>, id: string): AgentEvent => {
	const text = "x".repeat(random.int(300));
	switch (random.int(4)) {
		case 0:
			return {kind: "item", item: userItem(id, text)};
		case 1:
			return {kind: "item", item: assistantItem(id, text)};
		case 2:
			return {kind: "item", item: toolItem(id, text)};
		default:
			return {kind: "item", item: systemItem(id, text)};
	}
};

interface Run {
	readonly state: AiAgentSessionState;
	readonly items: number;
}

const drive = (seed: number, steps: number): Run => {
	const random = randomStream(seed);
	let state = initialState("/repo");
	let items = 0;
	for (let step = 0; step < steps; step += 1) {
		const {msg, newItem} = randomMsg(random, step);
		const [next] = applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(
			machine,
			state,
			msg,
		);
		// A prompt on a `ready` session records the operator's own turn (#7978), which is an item the
		// tail has to account for exactly like one a layer reported.
		const recorded = msg.type === "prompt" && state.phase === "ready";
		if ((newItem || recorded) && next.phase !== "gone") items += 1;
		state = next;
	}
	return {state, items};
};

const seeds = [1, 7, 42, 99, 1_337, 20_260_903, 6_553_601, 8_675_309];

describe("driving random messages through the table", () => {
	it("never grows the tail past the planner's bounds", () => {
		for (const seed of seeds) {
			const {state} = drive(seed, 200);
			expect({seed, items: state.transcript.items.length <= ITEM_LIMIT}).toEqual({
				seed,
				items: true,
			});
			expect({seed, bytes: groupBytes(state.transcript.items) <= BYTE_LIMIT}).toEqual({
				seed,
				bytes: true,
			});
		}
	});

	it("accounts for every item it saw — kept plus omitted, none silently dropped", () => {
		for (const seed of seeds) {
			const {state, items} = drive(seed, 200);
			expect({seed, total: state.transcript.items.length + state.transcript.omitted.items}).toEqual(
				{seed, total: items},
			);
		}
	});

	it("leaves a state a checkpoint could be read back from, whatever the stream did", () => {
		for (const seed of seeds) {
			const {state} = drive(seed, 200);
			const roundTripped: unknown = JSON.parse(JSON.stringify(state));
			expect({seed, readable: isAiAgentSessionState(roundTripped)}).toEqual({seed, readable: true});
		}
	});

	it("keeps the omission totals monotonic — they only ever grow", () => {
		for (const seed of seeds) {
			const short = drive(seed, 60).state.transcript.omitted;
			const long = drive(seed, 200).state.transcript.omitted;
			expect({seed, grew: long.items >= short.items && long.bytes >= short.bytes}).toEqual({
				seed,
				grew: true,
			});
		}
	});
});
