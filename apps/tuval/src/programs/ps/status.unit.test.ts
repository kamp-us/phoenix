/**
 * `ps`'s status segments: the three the issue names, and nothing the shell owns. Pure, so there is
 * no host and no jsdom here — that the renderer these are minted into resolves off the program row
 * is `../desk-renderers.unit.test.tsx`'s.
 */

import {describe, expect, it} from "vitest";
import {ProcessId} from "../../protocol/ids.ts";
import {twoRootForest} from "./fixtures.ts";
import {psInitialState} from "./state.ts";
import {psStatusSegments} from "./status.ts";

describe("ps status segments", () => {
	it("names the forest walk rather than spelling it as a column that is not sorted", () => {
		expect(psStatusSegments({processes: twoRootForest, state: psInitialState})).toEqual([
			{id: "processes", text: "6 processes"},
			{id: "order", text: "default order"},
		]);
	});

	it("states the sorted column by its own header, and the direction", () => {
		expect(
			psStatusSegments({
				processes: twoRootForest,
				state: {sortColumn: "program", sortDirection: "descending", selectedProcessId: null},
			}),
		).toEqual([
			{id: "processes", text: "6 processes"},
			{id: "order", text: "sorted by Program, descending"},
		]);
	});

	it("adds the selection when there is one and states nothing about it when there is not", () => {
		const selectedProcessId = ProcessId.make("child-a1");
		expect(
			psStatusSegments({
				processes: twoRootForest,
				state: {...psInitialState, selectedProcessId},
			}),
		).toEqual([
			{id: "processes", text: "6 processes"},
			{id: "order", text: "default order"},
			{id: "selected", text: "selected child-a1"},
		]);
	});

	it("agrees with a one-row table's singular", () => {
		const one = twoRootForest.slice(0, 1);
		expect(psStatusSegments({processes: one, state: psInitialState})[0]).toEqual({
			id: "processes",
			text: "1 process",
		});
	});

	it("states nothing the shell owns: no workspace, no kernel revision, no region", () => {
		const segments = psStatusSegments({
			processes: twoRootForest,
			state: {...psInitialState, selectedProcessId: ProcessId.make("root-a")},
		});
		expect(segments.flatMap((segment) => Object.keys(segment)).sort()).toEqual([
			"id",
			"id",
			"id",
			"text",
			"text",
			"text",
		]);
		expect(segments.map((segment) => segment.id)).toEqual(["processes", "order", "selected"]);
	});

	it("is a pure function of its facts: two calls on one input agree", () => {
		const facts = {processes: twoRootForest, state: psInitialState};
		expect(psStatusSegments(facts)).toEqual(psStatusSegments(facts));
	});
});
