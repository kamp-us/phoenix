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
	nestedUnder,
	randomStream,
	systemItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import type {AgentEvent, Phase} from "../events.ts";
import {groupBytes, nestedLimitsFor} from "../history/index.ts";
import {isNestedItem, Mode, type PermissionDecision, type TranscriptItem} from "../ports/index.ts";
import {aiAgentSessionMachine} from "./machine.ts";
import type {AiAgentSessionCmd, AiAgentSessionMsg} from "./messages.ts";
import {isAiAgentSessionState} from "./snapshot.ts";
import {type AiAgentSessionState, initialState} from "./state.ts";

const ITEM_LIMIT = 8;
const BYTE_LIMIT = 4_000;
const SENT_AT = 1_700_000_000_000;
const NESTED_LIMIT = nestedLimitsFor({items: ITEM_LIMIT, bytes: BYTE_LIMIT});

/**
 * Longest run of rows one spawned worker emits before the generator ends it.
 *
 * Well under `NESTED_LIMIT.items`, for the reason the own bounds are asserted strictly too: the
 * newest group in range is carried whole past every ceiling, so a generator that could put a whole
 * ceiling's worth of rows in one group would be asserting the exception rather than the bound.
 */
const WORKER_ROWS = 6;

/**
 * How often an item event opens a spawn rather than being the agent's own row.
 *
 * High enough that every fixed seed below carries worker rows — the run asserts that it did, and a
 * seed that happened to spawn nothing would assert the nested ceiling over an empty set.
 */
const SPAWN_CHANCE = 0.35;

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
	spawn: Spawn,
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
						turn: `turn-${random.int(1_000)}`,
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
			return {msg: {type: "interrupt", at: SENT_AT + step}, newItem: false};
		default:
			return {
				msg: {type: "event", sessionId: "session-1", event: randomItem(random, id, spawn)},
				newItem: true,
			};
	}
};

/** The spawn currently in flight, if any: the call id its worker's rows are tagged with. */
interface Spawn {
	open: string | null;
	left: number;
}

const plainItem = (random: ReturnType<typeof randomStream>, id: string): TranscriptItem => {
	const text = "x".repeat(random.int(300));
	switch (random.int(4)) {
		case 0:
			return userItem(id, text);
		case 1:
			return assistantItem(id, text);
		case 2:
			return toolItem(id, text);
		default:
			return systemItem(id, text);
	}
};

/**
 * One transcript item, sometimes a spawned worker's rather than the agent's own.
 *
 * A worker's rows arrive as ordinary items tagged with the call they ran inside, and they answer to
 * a ceiling of their own rather than the agent's (#8814) — so a generator that never emits one
 * leaves that ceiling unasserted and the bounds test passes vacuously over every session that
 * spawns anything.
 */
const randomItem = (
	random: ReturnType<typeof randomStream>,
	id: string,
	spawn: Spawn,
): AgentEvent => {
	if (spawn.open === null) {
		if (!random.chance(SPAWN_CHANCE)) return {kind: "item", item: plainItem(random, id)};
		spawn.open = id;
		spawn.left = 1 + random.int(WORKER_ROWS);
		return {kind: "item", item: toolItem(id, "spawning")};
	}
	const parent = spawn.open;
	spawn.left -= 1;
	if (spawn.left <= 0) spawn.open = null;
	return {kind: "item", item: nestedUnder(plainItem(random, id), parent)};
};

interface Run {
	readonly state: AiAgentSessionState;
	readonly items: number;
	/** How many of those items a spawned worker emitted, so a test can refuse a vacuous run. */
	readonly nested: number;
}

const drive = (seed: number, steps: number): Run => {
	const random = randomStream(seed);
	const spawn: Spawn = {open: null, left: 0};
	let state = initialState("/repo");
	let items = 0;
	let nested = 0;
	for (let step = 0; step < steps; step += 1) {
		const {msg, newItem} = randomMsg(random, step, spawn);
		if (msg.type === "event" && msg.event.kind === "item" && isNestedItem(msg.event.item)) {
			nested += 1;
		}
		const [next, cmds] = applyCellChecked<
			AiAgentSessionState,
			AiAgentSessionMsg,
			AiAgentSessionCmd
		>(machine, state, msg);
		// An admitted prompt records the operator's own turn (#7978), which is an item the tail has to
		// account for exactly like one a layer reported. The Cmd is the predicate rather than the Msg,
		// because a prompt written during a turn is admitted later, out of the queue (#8159).
		const recorded = cmds.some((cmd) => cmd.type === "aiAgent.prompt");
		if ((newItem || recorded) && next.phase !== "gone") items += 1;
		state = next;
	}
	return {state, items, nested};
};

const seeds = [1, 7, 42, 99, 1_337, 20_260_903, 6_553_601, 8_675_309];

describe("driving random messages through the table", () => {
	it("never grows the tail past the planner's bounds", () => {
		for (const seed of seeds) {
			const {state} = drive(seed, 200);
			const own = state.transcript.items.filter((item) => !isNestedItem(item));
			expect({seed, items: own.length <= ITEM_LIMIT}).toEqual({seed, items: true});
			expect({seed, bytes: groupBytes(own) <= BYTE_LIMIT}).toEqual({seed, bytes: true});
		}
	});

	it("holds a spawned worker's rows to a ceiling of their own", () => {
		for (const seed of seeds) {
			const run = drive(seed, 200);
			// The stream has to have carried worker rows for the two bounds below to mean anything —
			// before #8814 added the spawn arm the generator emitted none, and every bound over them
			// passed vacuously. Asserted on what the run emitted, not on what survived: a tail that
			// evicted them all is exactly the case the ceiling is allowed to produce.
			expect({seed, spawned: run.nested > 0}).toEqual({seed, spawned: true});
			const nested = run.state.transcript.items.filter(isNestedItem);
			expect({seed, items: nested.length <= NESTED_LIMIT.items}).toEqual({seed, items: true});
			expect({seed, bytes: groupBytes(nested) <= NESTED_LIMIT.bytes}).toEqual({seed, bytes: true});
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
