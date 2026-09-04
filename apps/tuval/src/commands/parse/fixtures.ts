/**
 * One registry and one snapshot for the parser's tests.
 *
 * `params` is written as the JSON Schema document `Schema.toJsonSchemaDocument` emits, because that
 * is what a `SpellDescription` carries on the wire; `spell-index.unit.test.ts` pins the two shapes
 * against a real `Schema.Struct` so this hand-written form cannot quietly drift from it.
 */

import {ProcessId, ProgramId, WindowId, WorkspaceId} from "../../protocol/ids.ts";
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
): unknown => ({
	dialect: "draft-2020-12",
	schema: {type: "object", properties, required, additionalProperties: false},
	definitions: {},
});

const text: Property = {type: "string"};
const direction: Property = {type: "string", enum: ["left", "right", "up", "down"]};

const spell = (
	path: ReadonlyArray<string>,
	describe: string,
	params: unknown,
): SpellDescription => ({path, describe, params, capabilities: []});

export const descriptions: RegistryDescription = [
	spell(["window", "close"], "Close the focused window.", jsonSchema({}, [])),
	spell(["window", "move"], "Move the focused window.", jsonSchema({direction}, ["direction"])),
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
export const leftWindow = WindowId.make("w-left");
export const rightWindow = WindowId.make("w-right");
export const counterProcess = ProcessId.make("p-counter");
export const clientProcess = ProcessId.make("p-client");

const row = (id: ProcessId, programId: string): ProcessRow => ({
	id,
	programId: ProgramId.make(programId),
	parentId: null,
	ports: {},
	stateSummary: {lifecycle: "running", revision: 1},
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
		},
		activeWorkspace: main,
	},
	windows: {
		[leftWindow]: {id: leftWindow},
		[rightWindow]: {id: rightWindow},
	},
	// `tea-client` holds `c`, but not at its front: a program id is a system name, so it is reached
	// by prefix or not at all.
	processes: [row(counterProcess, "counter"), row(clientProcess, "tea-client")],
	registry: descriptions,
});
