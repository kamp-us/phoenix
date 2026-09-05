/**
 * One of each message, valid, for the tests to encode, decode and patch.
 *
 * `spellDescription.params` is written at the shape `Schema.toJsonSchemaDocument` emits, because
 * that is the only shape `SpellDescription` decodes; `registry-description.unit.test.ts` pins it
 * against the real renderer.
 */

import {Schema} from "effect";
import {CallId, ProcessId, ProgramId, WindowId, WorkspaceId} from "./ids.ts";
import type {JsonSchemaDocument} from "./json-schema-document.ts";
import {
	Patch,
	PROTOCOL_VERSION,
	Snapshot,
	SpellCall,
	SpellReplyError,
	SpellReplyOk,
} from "./messages.ts";
import type {ProcessRow} from "./process-row.ts";
import type {SpellDescription} from "./registry-description.ts";

/**
 * The document a parameterless spell renders to, for a row that needs one and means nothing by it.
 * Rendered rather than written out: `Schema.Struct({})` emits an `anyOf`, not the `type: "object"`
 * a guess reaches for.
 */
export const emptyParams: JsonSchemaDocument = Schema.toJsonSchemaDocument(Schema.Struct({}));

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
	recency: 2,
};

export const spellDescription: SpellDescription = {
	path: ["window", "split"],
	describe: "Split the focused window.",
	params: {
		dialect: "draft-2020-12",
		schema: {
			type: "object",
			properties: {orientation: {type: "string"}},
			required: ["orientation"],
			additionalProperties: false,
		},
		definitions: {},
	},
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

export const spellReply = new SpellReplyOk({
	type: "spell.reply",
	version: PROTOCOL_VERSION,
	id: CallId.make("call-1"),
	ok: true,
	result: {window: rightWindow},
});

export const spellRefusal = new SpellReplyError({
	type: "spell.reply",
	version: PROTOCOL_VERSION,
	id: CallId.make("call-2"),
	ok: false,
	error: {
		tag: "tuval/UnknownSpell",
		message: 'no spell is registered at "window splt"',
		path: ["window", "splt"],
		didYouMean: "window split",
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
		[leftWindow]: {id: leftWindow, process: counterProcess, recency: 3},
		[rightWindow]: {id: rightWindow, recency: 1},
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
