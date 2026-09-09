/**
 * Reading a settled tool row as a kernel spawn — the one thing that tells a kernel child from a
 * worker the backend spawned itself.
 *
 * Both harnesses' spellings are pinned here, because getting one wrong is invisible: the row simply
 * never opens, and nothing anywhere fails.
 */

import {describe, expect, it} from "vitest";
import {ItemId, type ToolItem} from "../ports/index.ts";
import {kernelSpawnOf} from "./kernel-spawn.ts";

const row = (overrides: Partial<ToolItem> = {}): ToolItem => ({
	kind: "tool",
	id: ItemId.make("call-1"),
	timestamp: 1_756_000_000_000,
	name: "mcp__tuval__spawn",
	input: {program: "tuval/claude"},
	status: "ok",
	result: {text: '{"process":"p-9"}', omitted: {bytes: 0}},
	...overrides,
});

describe("a settled tool row read as a kernel spawn", () => {
	it("reads the SDK's wire name and answers the program and the process", () => {
		expect(kernelSpawnOf(row())).toEqual({program: "tuval/claude", process: "p-9"});
	});

	it("reads Codex's `<server>.<tool>` spelling of the same call", () => {
		expect(kernelSpawnOf(row({name: "tuval.spawn"}))).toEqual({
			program: "tuval/claude",
			process: "p-9",
		});
	});

	it("finds the process inside the MCP envelopes each harness wraps the reply in", () => {
		const mcp = JSON.stringify({content: [{type: "text", text: '{"process":"p-9"}'}]});
		expect(kernelSpawnOf(row({result: {text: mcp, omitted: {bytes: 0}}}))?.process).toBe("p-9");
		const codex = JSON.stringify({contentItems: [{text: '{"process":"p-9"}'}]});
		expect(kernelSpawnOf(row({result: {text: codex, omitted: {bytes: 0}}}))?.process).toBe("p-9");
	});

	// A backend's own tool called `spawn` is not the kernel's, and a row that opened one would put a
	// process id in the list that names no process.
	it("is not a bare `spawn`, and not another tool of the kernel's", () => {
		expect(kernelSpawnOf(row({name: "spawn"}))).toBeNull();
		expect(kernelSpawnOf(row({name: "mcp__tuval__send"}))).toBeNull();
		expect(kernelSpawnOf(row({name: "Task"}))).toBeNull();
	});

	it("is nothing while the call is still running, and nothing when it failed", () => {
		expect(
			kernelSpawnOf(row({status: "running", result: {text: "", omitted: {bytes: 0}}})),
		).toBeNull();
		expect(
			kernelSpawnOf(
				row({status: "error", result: {text: "UnknownProgram: no such row", omitted: {bytes: 0}}}),
			),
		).toBeNull();
	});

	it("is nothing when the answer carries no process, whatever else it carries", () => {
		expect(kernelSpawnOf(row({result: {text: "", omitted: {bytes: 0}}}))).toBeNull();
		expect(kernelSpawnOf(row({result: {text: "started it", omitted: {bytes: 0}}}))).toBeNull();
		expect(kernelSpawnOf(row({result: {text: '{"process":""}', omitted: {bytes: 0}}}))).toBeNull();
		expect(kernelSpawnOf(row({result: {text: '{"process":7}', omitted: {bytes: 0}}}))).toBeNull();
	});

	// The row still opens: the process is the fact the list needs, and the program is what it draws.
	it("falls back to the tool's own name when the call named no program", () => {
		expect(kernelSpawnOf(row({input: {}}))).toEqual({program: "spawn", process: "p-9"});
		expect(kernelSpawnOf(row({input: null}))).toEqual({program: "spawn", process: "p-9"});
	});
});
