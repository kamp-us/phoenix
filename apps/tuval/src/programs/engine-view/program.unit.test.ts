/**
 * The `engine-view` row and its machine, driven with no runtime: the cells are pure, so a test is a
 * state and a Msg in, a state out.
 */

import {applyCell, msgKeysOf} from "@demlik/tea";
import {describe, expect, it} from "vitest";
import {ProcessId} from "../../protocol/ids.ts";
import {
	ENGINE_VIEW_RENDERER_REF,
	type EngineViewMsg,
	type EngineViewState,
	engineViewCore,
	engineViewId,
	engineViewInitial,
	engineViewProgram,
} from "./program.ts";

const pid = (id: string): ProcessId => ProcessId.make(id);

const apply = (state: EngineViewState, msg: EngineViewMsg): EngineViewState =>
	applyCell<EngineViewState, EngineViewMsg, never>(engineViewCore, state, msg)[0];

describe("engine-view: the registry row", () => {
	it("is an ordinary program row naming a window renderer", () => {
		const row = engineViewProgram();
		expect(row.id).toBe(engineViewId);
		expect(row.renderer).toEqual({kind: "host-native", ref: ENGINE_VIEW_RENDERER_REF});
		expect(row.placement).toEqual({host: "local"});
	});

	it("declares no ports, so it subscribes to no process-table port of its own", () => {
		expect(engineViewProgram().ports).toEqual({});
	});

	it("has one cell per Msg and no more", () => {
		expect(msgKeysOf(engineViewCore).toSorted()).toEqual(["clear", "select", "tableChanged"]);
	});
});

describe("engine-view: selection", () => {
	it("starts pointing at nothing", () => {
		expect(engineViewInitial).toEqual({selected: null});
	});

	it("`select` writes the process id into the state the Snapshot carries", () => {
		expect(apply(engineViewInitial, {type: "select", processId: pid("p-1")})).toEqual({
			selected: pid("p-1"),
		});
	});

	it("selecting the already-selected process returns the same state, so no revision moves", () => {
		const selected = apply(engineViewInitial, {type: "select", processId: pid("p-1")});
		expect(apply(selected, {type: "select", processId: pid("p-1")})).toBe(selected);
	});

	it("`clear` deselects, and is a no-op when nothing is selected", () => {
		const selected = apply(engineViewInitial, {type: "select", processId: pid("p-1")});
		expect(apply(selected, {type: "clear"})).toEqual({selected: null});
		expect(apply(engineViewInitial, {type: "clear"})).toBe(engineViewInitial);
	});
});

describe("engine-view: a process that leaves the table", () => {
	const selected = apply(engineViewInitial, {type: "select", processId: pid("p-1")});

	it("clears a selection naming a process no longer in the table", () => {
		expect(apply(selected, {type: "tableChanged", present: [pid("p-2")]})).toEqual({
			selected: null,
		});
	});

	it("keeps a selection whose process is still there", () => {
		expect(apply(selected, {type: "tableChanged", present: [pid("p-1"), pid("p-2")]})).toBe(
			selected,
		);
	});

	it("clears against an empty table too", () => {
		expect(apply(selected, {type: "tableChanged", present: []})).toEqual({selected: null});
	});
});
