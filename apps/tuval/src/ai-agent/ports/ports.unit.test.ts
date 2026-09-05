import {assert, describe, expect, it} from "@effect/vitest";
import {Effect} from "effect";
import {agentSide, windowSide} from "../../ai-agent-fixtures/programs.ts";
import {compile} from "../../ports/compile.ts";
import {IncompatibleRoute} from "../../ports/errors.ts";
import type {Graph} from "../../ports/graph.ts";
import {NodeId} from "../../ports/graph.ts";
import {ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {agentPorts, mode, permission, prompt, transcript, transcriptPage} from "./ports.ts";

const rows = [agentSide, windowSide];
const registry = Registry.layer(rows);

const node = (id: string, program: string, on: Graph["nodes"][number]["on"] = []) => ({
	id: NodeId.make(id),
	program: ProgramId.make(program),
	on,
});

const to = (node: string, port: string) => ({node: NodeId.make(node), port});

const compiled = (graph: Graph) => Effect.provide(compile(graph), registry);
const refusal = (graph: Graph) => Effect.flip(Effect.provide(compile(graph), registry));

describe("the five AI agent ports", () => {
	it("declares five ports, each with its own kind", () => {
		expect(agentPorts.map((port) => port.name)).toEqual([
			"transcript",
			"transcript-page",
			"prompt",
			"permission",
			"mode",
		]);
		expect(new Set(agentPorts.map((port) => port.kind)).size).toBe(5);
	});

	it("declares a bounded queue on every port, inbound and by default", () => {
		for (const port of agentPorts) {
			expect(Number.isInteger(port.bound.capacity)).toBe(true);
			expect(port.bound.capacity).toBeGreaterThan(0);
			expect(port.inbound()).toMatchObject({
				kind: port.kind,
				direction: "in",
				bound: port.bound,
			});
			expect(port.outbound()).toMatchObject({kind: port.kind, direction: "out"});
		}
	});

	it("lets one program override a bound without changing the kind", () => {
		const tighter = prompt.inbound({capacity: 1, overflow: "dropping"});
		expect(tighter.bound).toEqual({capacity: 1, overflow: "dropping"});
		expect(tighter.kind).toBe(prompt.kind);
	});

	it("carries each port's own predicate onto both directions", () => {
		expect(
			transcript.outbound().accepts({items: [], omitted: {items: 0, bytes: 0, reason: "none"}}),
		).toBe(true);
		expect(prompt.inbound().accepts({text: "go"})).toBe(true);
		expect(prompt.inbound().accepts({items: []})).toBe(false);
	});
});

describe("route compatibility over the five ports", () => {
	it.effect("compiles the whole interface when the two halves mirror each other", () =>
		Effect.gen(function* () {
			const graph = yield* compiled({
				nodes: [
					node("agent", "ai-agent-fixture", [
						{port: "transcript", to: to("window", "transcript")},
						{port: "pageReply", to: to("window", "pageReply")},
						{port: "permissionPending", to: to("window", "permissionPending")},
						{port: "modeState", to: to("window", "modeState")},
					]),
					node("window", "ai-agent-window-fixture", [
						{port: "prompt", to: to("agent", "prompt")},
						{port: "pageRequest", to: to("agent", "pageRequest")},
						{port: "permissionDecision", to: to("agent", "permissionDecision")},
						{port: "modeSet", to: to("agent", "modeSet")},
					]),
				],
			});
			assert.deepStrictEqual(
				graph.routes.map((route) => route.kind),
				[
					transcript.kind,
					transcriptPage.kind,
					permission.kind,
					mode.kind,
					prompt.kind,
					transcriptPage.kind,
					permission.kind,
					mode.kind,
				],
			);
		}),
	);

	const agentNode = {node: "agent", program: "ai-agent-fixture"} as const;
	const windowNode = {node: "window", program: "ai-agent-window-fixture"} as const;

	const crossings = [
		{
			at: agentNode,
			from: "transcript",
			to: windowNode,
			into: "pageReply",
			src: transcript,
			dst: transcriptPage,
		},
		{
			at: agentNode,
			from: "transcript",
			to: windowNode,
			into: "permissionPending",
			src: transcript,
			dst: permission,
		},
		{
			at: agentNode,
			from: "pageReply",
			to: windowNode,
			into: "transcript",
			src: transcriptPage,
			dst: transcript,
		},
		{
			at: agentNode,
			from: "permissionPending",
			to: windowNode,
			into: "modeState",
			src: permission,
			dst: mode,
		},
		{
			at: agentNode,
			from: "modeState",
			to: windowNode,
			into: "transcript",
			src: mode,
			dst: transcript,
		},
		{
			at: windowNode,
			from: "prompt",
			to: agentNode,
			into: "pageRequest",
			src: prompt,
			dst: transcriptPage,
		},
		{at: windowNode, from: "prompt", to: agentNode, into: "modeSet", src: prompt, dst: mode},
		{at: windowNode, from: "modeSet", to: agentNode, into: "prompt", src: mode, dst: prompt},
	] as const;

	it.effect.each(crossings)(
		"refuses $from routed into a $into port before boot, naming both kinds",
		({at, from, to: target, into, src, dst}) =>
			Effect.gen(function* () {
				const error = yield* refusal({
					nodes: [
						node(at.node, at.program, [{port: from, to: to(target.node, into)}]),
						node(target.node, target.program),
					],
				});
				assert.instanceOf(error, IncompatibleRoute);
				assert.deepStrictEqual(error.source, {
					program: ProgramId.make(at.program),
					port: from,
					kind: src.kind,
				});
				assert.deepStrictEqual(error.target, {
					program: ProgramId.make(target.program),
					port: into,
					kind: dst.kind,
				});
				assert.include(error.message, src.kind);
				assert.include(error.message, dst.kind);
			}),
	);
});
