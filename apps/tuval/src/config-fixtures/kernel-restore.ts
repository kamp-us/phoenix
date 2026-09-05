/**
 * A config whose graph plans no node, holding one row whose handler needs a kernel service outside
 * `restore`'s own four. Boot's launcher has nothing to bring back here, so a checkpointed process
 * of this row can only return through `restore` — and can only run its handler if the context
 * `boot.ts` hands `restore` still carries the kernel (`boot-restore-context.unit.test.ts`).
 */

import {defineMachine} from "@demlik/tea";
import {Effect} from "effect";
import {SpellBridge} from "../commands/bridge/index.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";

export const bridgeProbeId = ProgramId.make("bridge-probe");

/** `marks` is what the first boot writes; `spells` is what only a kernel-carrying restore can fill. */
export interface BridgeProbeState {
	readonly marks: number;
	readonly spells: number;
}

export type BridgeProbeMsg =
	| {readonly type: "mark"}
	| {readonly type: "resumed"}
	| {readonly type: "saw"; readonly spells: number};

type BridgeProbeCmd = {readonly type: "count-spells"};

const bridgeProbe = {
	id: bridgeProbeId,
	core: defineMachine<BridgeProbeState, BridgeProbeMsg, BridgeProbeCmd, never, unknown>({
		init: (loaded) => [loaded ?? {marks: 0, spells: 0}, []],
		update: {
			mark: (state) => [{...state, marks: state.marks + 1}, []],
			resumed: (state) => [state, [{type: "count-spells"}]],
			saw: (state, msg) => [{...state, spells: msg.spells}, []],
		},
		interpret: {"count-spells": () => Promise.resolve()},
	}),
	ports: {},
	handlers: {
		"count-spells": () =>
			Effect.map(
				Effect.flatMap(SpellBridge, (bridge) => bridge.list),
				(rows) => [{type: "saw", spells: rows.length}] as ReadonlyArray<BridgeProbeMsg>,
			),
	},
	// The spawner's own last step: what a restored process is sent, and the only thing that reaches
	// the handler above without a test dispatching into the process by hand.
	resume: () => [{type: "resumed"}] as ReadonlyArray<BridgeProbeMsg>,
	capabilities: [],
	identity: {
		package: "@kampus/tuval",
		program: "bridge-probe",
		version: "1.0.0",
		digest: "sha256:bridge-probe",
	},
	placement: {host: "local"},
} satisfies Program<
	BridgeProbeState,
	BridgeProbeMsg,
	BridgeProbeCmd,
	never,
	unknown,
	never,
	SpellBridge
>;

const programs: ReadonlyArray<AnyProgram> = [bridgeProbe];

export default {version: 1, programs};
