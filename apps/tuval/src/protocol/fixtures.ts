/** One of each message, valid, for the tests to encode, decode and patch. */

import {CallId, ProcessId, ProgramId, WindowId, WorkspaceId} from "./ids.ts";
import {Patch, PROTOCOL_VERSION, Snapshot, SpellCall, SpellReply} from "./messages.ts";
import type {ProcessRow} from "./process-row.ts";
import type {SpellDescription} from "./registry-description.ts";

export const workspace = WorkspaceId.make("ws-1");
export const leftWindow = WindowId.make("w-1");
export const rightWindow = WindowId.make("w-2");
export const counterProcess = ProcessId.make("p-1");

export const counterRow: ProcessRow = {
	id: counterProcess,
	programId: ProgramId.make("counter"),
	parentId: null,
	ports: {increment: {kind: "count", direction: "in"}},
	stateSummary: {lifecycle: "running", revision: 3},
};

export const spellDescription: SpellDescription = {
	path: ["window", "split"],
	describe: "Split the focused window.",
	params: {type: "object", properties: {orientation: {type: "string"}}},
	capabilities: [{family: "process-control"}],
};

export const spellCall = new SpellCall({
	type: "spell.call",
	version: PROTOCOL_VERSION,
	id: CallId.make("call-1"),
	path: ["window", "split"],
	args: {orientation: "row"},
	window: leftWindow,
});

export const spellReply = new SpellReply({
	type: "spell.reply",
	version: PROTOCOL_VERSION,
	id: CallId.make("call-1"),
	outcome: {ok: true, result: {window: rightWindow}},
});

export const spellRefusal = new SpellReply({
	type: "spell.reply",
	version: PROTOCOL_VERSION,
	id: CallId.make("call-2"),
	outcome: {
		ok: false,
		error: {
			tag: "tuval/UnknownSpell",
			message: 'no spell is registered at "window splt"',
			path: ["window", "splt"],
			didYouMean: "window split",
		},
	},
});

export const snapshot = new Snapshot({
	type: "snapshot",
	version: PROTOCOL_VERSION,
	rev: 7,
	desk: {
		workspaces: {
			[workspace]: {
				id: workspace,
				name: "main",
				layout: {
					kind: "split",
					orientation: "row",
					children: [
						{kind: "leaf", window: leftWindow},
						{kind: "leaf", window: rightWindow},
					],
				},
				focused: leftWindow,
			},
		},
		activeWorkspace: workspace,
	},
	windows: {
		[leftWindow]: {id: leftWindow, process: counterProcess},
		[rightWindow]: {id: rightWindow},
	},
	processes: [counterRow],
	registry: [spellDescription],
});

export const patch = new Patch({
	type: "patch",
	version: PROTOCOL_VERSION,
	rev: 8,
	changes: [{op: "replace", path: ["desk", "workspaces", workspace, "name"], value: "renamed"}],
});
