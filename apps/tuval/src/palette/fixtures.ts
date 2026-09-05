/**
 * One registry and one desk for the palette's tests.
 *
 * `params` is written as the JSON Schema document a `SpellDescription` carries on the wire, through
 * the parser's own `jsonSchema` helper, so this registry and the parser's are one shape and
 * `spell-index.unit.test.ts`'s pin against a real `Schema.Struct` covers both.
 */

import {jsonSchema} from "../commands/parse/fixtures.ts";
import {buildSpellIndex, type SpellIndex} from "../commands/parse/spell-index.ts";
import {ProcessId, ProgramId, WindowId, WorkspaceId} from "../protocol/ids.ts";
import {PROTOCOL_VERSION, Snapshot} from "../protocol/messages.ts";
import type {ProcessRow} from "../protocol/process-row.ts";
import type {RegistryDescription, SpellDescription} from "../protocol/registry-description.ts";

const text = {type: "string"} as const;
const direction = {type: "string", enum: ["left", "right", "up", "down"]} as const;

const spell = (
	path: ReadonlyArray<string>,
	describe: string,
	params: unknown,
): SpellDescription => ({path, describe, params, capabilities: []});

export const descriptions: RegistryDescription = [
	spell(["window", "close"], "Close the focused window.", jsonSchema({}, [])),
	spell(["window", "move"], "Move the focused window.", jsonSchema({direction}, ["direction"])),
	spell(["window", "focus"], "Focus a window by id.", jsonSchema({windowId: text}, ["windowId"])),
	spell(["workspace", "new"], "Create a workspace.", jsonSchema({name: text}, ["name"])),
	spell(
		["workspace", "activate"],
		"Switch to a workspace.",
		jsonSchema({workspace: text}, ["workspace"]),
	),
	spell(["help"], "List every spell this desk knows.", jsonSchema({}, [])),
	// A segment `win` reaches as a subsequence but never as a prefix: the proof that a system name is
	// recalled, not searched.
	spell(["wizard-inspect"], "Inspect the wiring of a program.", jsonSchema({}, [])),
];

export const registry: SpellIndex = buildSpellIndex(descriptions);

const carrier = WorkspaceId.make("ws-1");
const scratch = WorkspaceId.make("ws-2");
const main = WorkspaceId.make("ws-3");
export const leftWindow = WindowId.make("w-left");
export const rightWindow = WindowId.make("w-right");
const counterProcess = ProcessId.make("p-counter");

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
		},
		activeWorkspace: main,
	},
	windows: {
		[leftWindow]: {id: leftWindow, recency: 4},
		[rightWindow]: {id: rightWindow, recency: 9},
	},
	processes: [row(counterProcess, "counter", 5)],
	registry: descriptions,
});
