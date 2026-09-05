/**
 * One registry and one snapshot for the parser's tests.
 *
 * `params` is written as the JSON Schema document `Schema.toJsonSchemaDocument` emits, because that
 * is what a `SpellDescription` carries on the wire; `spell-index.unit.test.ts` pins the two shapes
 * against a real `Schema.Struct` so this hand-written form cannot quietly drift from it.
 */

import {ProcessId, ProgramId, WindowId, WorkspaceId} from "../../protocol/ids.ts";
import type {JsonSchemaDocument} from "../../protocol/json-schema-document.ts";
import {PROTOCOL_VERSION, Snapshot} from "../../protocol/messages.ts";
import type {ProcessRow} from "../../protocol/process-row.ts";
import type {RegistryDescription, SpellDescription} from "../../protocol/registry-description.ts";
import {buildSpellIndex, type SpellIndex} from "./spell-index.ts";

interface Property {
	readonly type: "string";
	readonly enum?: ReadonlyArray<string>;
}

export const jsonSchema = (
	properties: Readonly<Record<string, Property>>,
	required: ReadonlyArray<string>,
): JsonSchemaDocument => ({
	dialect: "draft-2020-12",
	schema: {type: "object", properties, required, additionalProperties: false},
	definitions: {},
});

const text: Property = {type: "string"};
const direction: Property = {type: "string", enum: ["left", "right", "up", "down"]};

const spell = (
	path: ReadonlyArray<string>,
	describe: string,
	params: JsonSchemaDocument,
): SpellDescription => ({path, describe, params, capabilities: []});

export const descriptions: RegistryDescription = [
	spell(["window", "close"], "Close the focused window.", jsonSchema({}, [])),
	spell(["window", "move"], "Move the focused window.", jsonSchema({direction}, ["direction"])),
	spell(["window", "focus"], "Focus a window by id.", jsonSchema({windowId: text}, ["windowId"])),
	spell(
		["workspace", "activate"],
		"Switch to a workspace.",
		jsonSchema({workspace: text}, ["workspace"]),
	),
	spell(
		["workspace", "rename"],
		"Rename a workspace.",
		jsonSchema({workspace: text, name: text}, ["workspace", "name"]),
	),
	spell(["process", "kill"], "Stop a process.", jsonSchema({processId: text}, ["processId"])),
	spell(["process", "spawn"], "Start a program.", jsonSchema({programId: text}, ["programId"])),
	// A segment `win` reaches as a subsequence but never as a prefix: the proof that a system name
	// is recalled, not searched.
	spell(["wizard-inspect"], "Inspect the wiring of a program.", jsonSchema({}, [])),
];

export const registry: SpellIndex = buildSpellIndex(descriptions);

const carrier = WorkspaceId.make("ws-1");
const scratch = WorkspaceId.make("ws-2");
const main = WorkspaceId.make("ws-3");
const tightLate = WorkspaceId.make("ws-4");
const looseEarly = WorkspaceId.make("ws-5");
export const leftWindow = WindowId.make("w-left");
export const rightWindow = WindowId.make("w-right");
export const counterProcess = ProcessId.make("p-counter");
export const clientProcess = ProcessId.make("p-client");

const row = (id: ProcessId, programId: string, recency: number): ProcessRow => ({
	id,
	programId: ProgramId.make(programId),
	parentId: null,
	ports: {},
	stateSummary: {lifecycle: "running", revision: 1},
	recency,
});

const workspace = (id: WorkspaceId, name: string) => ({
	id,
	name,
	layout: {kind: "leaf", window: leftWindow} as const,
	focused: leftWindow,
});

export const snapshot = new Snapshot({
	type: "snapshot",
	version: PROTOCOL_VERSION,
	rev: 1,
	desk: {
		// `super-carrier` is listed before `scratch` on purpose: both hold `scr` as a subsequence, so
		// a `scratch`-first answer proves the ranking rather than the collection order.
		workspaces: {
			[carrier]: workspace(carrier, "super-carrier"),
			[scratch]: workspace(scratch, "scratch"),
			[main]: workspace(main, "main"),
			// The greedy-scorer case of #7757, verbatim: `a-xb-ab` holds `ab` scattered at 0-3 and
			// contiguous at 5-6, and `a-b` holds one looser run. Ranked by the tightest run,
			// `a-xb-ab` (1005) comes first; ranked by the first run found, `a-b` (2000) would.
			[tightLate]: workspace(tightLate, "a-xb-ab"),
			[looseEarly]: workspace(looseEarly, "a-b"),
		},
		activeWorkspace: main,
	},
	// `w-right` was focused after `w-left`, so a tie between the two ranks it first.
	windows: {
		[leftWindow]: {id: leftWindow, recency: 4},
		[rightWindow]: {id: rightWindow, recency: 9},
	},
	// `tea-client` holds `c`, but not at its front: a program id is a system name, so it is reached
	// by prefix or not at all.
	// `p-client` spawned after `p-counter`, so a tie between the two ranks it first — the ruled
	// recency tie-break (#7617 R1.5), which is the reverse of this collection order on purpose.
	processes: [row(counterProcess, "counter", 5), row(clientProcess, "tea-client", 8)],
	registry: descriptions,
});
