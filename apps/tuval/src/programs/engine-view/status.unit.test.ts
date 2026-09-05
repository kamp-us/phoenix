/**
 * `engine-view`'s status segments: the three the issue names, and nothing the shell owns. Pure, so
 * there is no host and no jsdom here — that the renderer these are minted into resolves off the
 * program row is `../desk-renderers.unit.test.tsx`'s.
 */

import {describe, expect, it} from "vitest";
import {ProcessId} from "../../protocol/ids.ts";
import {row, twoRootForest} from "../ps/fixtures.ts";
import {engineViewStatusSegments} from "./status.ts";

describe("engine-view status segments", () => {
	it("states the process count and the edge count the projection emitted", () => {
		expect(engineViewStatusSegments({processes: twoRootForest, state: {selected: null}})).toEqual([
			{id: "processes", text: "6 processes"},
			// Two roots, so four of the six rows carry a parent that resolves.
			{id: "edges", text: "4 edges"},
		]);
	});

	it("counts an edge only where the parent is a row of the same table", () => {
		const orphan = row("child-x", {parent: "gone-parent"});
		expect(engineViewStatusSegments({processes: [orphan], state: {selected: null}})).toEqual([
			{id: "processes", text: "1 process"},
			{id: "edges", text: "0 edges"},
		]);
	});

	it("adds the selection when there is one and states nothing about it when there is not", () => {
		const selected = ProcessId.make("root-a");
		expect(engineViewStatusSegments({processes: twoRootForest, state: {selected}})).toEqual([
			{id: "processes", text: "6 processes"},
			{id: "edges", text: "4 edges"},
			{id: "selected", text: "selected root-a"},
		]);
		expect(
			engineViewStatusSegments({processes: twoRootForest, state: {selected: null}}).map(
				(segment) => segment.id,
			),
		).toEqual(["processes", "edges"]);
	});

	it("states nothing the shell owns: no workspace, no kernel revision, no region", () => {
		const segments = engineViewStatusSegments({
			processes: twoRootForest,
			state: {selected: ProcessId.make("root-b")},
		});
		expect(segments.flatMap((segment) => Object.keys(segment)).sort()).toEqual([
			"id",
			"id",
			"id",
			"text",
			"text",
			"text",
		]);
		expect(segments.map((segment) => segment.id)).toEqual(["processes", "edges", "selected"]);
	});

	it("is a pure function of its facts: two calls on one input agree", () => {
		const facts = {processes: twoRootForest, state: {selected: ProcessId.make("root-a")}};
		expect(engineViewStatusSegments(facts)).toEqual(engineViewStatusSegments(facts));
	});
});
