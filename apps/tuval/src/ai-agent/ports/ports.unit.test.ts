import {assert, describe, expect, it} from "@effect/vitest";
import {Effect} from "effect";
import {agentSide, windowSide} from "../../ai-agent-fixtures/programs.ts";
import {compile} from "../../ports/compile.ts";
import {IncompatibleRoute} from "../../ports/errors.ts";
import type {Graph} from "../../ports/graph.ts";
import {NodeId} from "../../ports/graph.ts";
import {statusPort, titlePort} from "../../process/self-report.ts";
import {ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {
	agentPorts,
	mode,
	permission,
	prompt,
	status,
	title,
	transcript,
	transcriptPage,
} from "./ports.ts";

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

/** The ends a port is played from: one for a one-way port, two for a two-way one. */
const endsOf = (port: (typeof agentPorts)[number]) =>
	"ends" in port ? Object.values(port.ends) : [port];

describe("the ports a Tuval AI agent row declares", () => {
	it("declares seven ports, each with its own kind", () => {
		expect(agentPorts.map((port) => port.name)).toEqual([
			"transcript",
			"transcript-page",
			"prompt",
			"permission",
			"mode",
			"title",
			"status",
		]);
		expect(new Set(agentPorts.map((port) => port.kind)).size).toBe(7);
	});

	// The two generic ones are the kernel's, carried rather than restated: a copied kind string is
	// how one program's title stops routing to a board that takes every other program's (#8715).
	it("carries the kernel's own kind and predicate onto title and status", () => {
		expect(title.kind).toBe(titlePort.kind);
		expect(status.kind).toBe(statusPort.kind);
		expect(title.outbound().accepts("claude-session · Opus 5 · phoenix")).toBe(true);
		expect(status.is(42)).toBe(false);
	});

	it("declares a bounded queue on every end of every port, inbound and by default", () => {
		for (const port of agentPorts) {
			expect(Number.isInteger(port.bound.capacity)).toBe(true);
			expect(port.bound.capacity).toBeGreaterThan(0);
			for (const end of endsOf(port)) {
				expect(end.inbound()).toMatchObject({
					kind: port.kind,
					direction: "in",
					bound: port.bound,
				});
				expect(end.outbound()).toMatchObject({kind: port.kind, direction: "out"});
			}
		}
	});

	it("lets one program override a bound without changing the kind", () => {
		const tighter = prompt.inbound({capacity: 1, overflow: "dropping"});
		expect(tighter.bound).toEqual({capacity: 1, overflow: "dropping"});
		expect(tighter.kind).toBe(prompt.kind);
	});

	it("carries a one-way port's own predicate onto both directions", () => {
		expect(
			transcript.outbound().accepts({items: [], omitted: {items: 0, bytes: 0, reason: "none"}}),
		).toBe(true);
		expect(prompt.inbound().accepts({text: "go", key: "k1", timestamp: 1})).toBe(true);
		expect(prompt.inbound().accepts({items: []})).toBe(false);
	});
});

/**
 * The three two-way kinds, each end admitting one direction (#8235). The wrong direction is a
 * payload the kind itself carries, so the union predicate says yes and only the end says no —
 * which is the whole point: the refusal happens at the send, where the caller reads it.
 */
describe("what each end of a two-way port admits", () => {
	const page = {
		kind: "page",
		items: [],
		omitted: {items: 0, bytes: 0, reason: "none"},
		next: null,
	};
	const pageRequest = {kind: "request", before: null, limit: 20};
	const decision = {kind: "decision", request: "r-1", decision: "allow-once"};
	const pending = {kind: "pending", requests: {}};
	const set = {kind: "set", mode: "plan"};
	const state = {kind: "state", current: null, available: []};

	const crossings = [
		{
			takes: "transcript-page request",
			end: transcriptPage.ends.request,
			right: pageRequest,
			wrong: page,
		},
		{takes: "transcript-page page", end: transcriptPage.ends.page, right: page, wrong: pageRequest},
		{takes: "permission decision", end: permission.ends.decision, right: decision, wrong: pending},
		{takes: "permission pending", end: permission.ends.pending, right: pending, wrong: decision},
		{takes: "mode set", end: mode.ends.set, right: set, wrong: state},
		{takes: "mode state", end: mode.ends.state, right: state, wrong: set},
	];

	it.each(crossings)("the $takes end takes its own direction and no other", (crossing) => {
		const {end, right, wrong} = crossing;
		expect(end.inbound().accepts(right)).toBe(true);
		expect(end.inbound().accepts(wrong)).toBe(false);
		expect(end.outbound().accepts(right)).toBe(true);
		expect(end.outbound().accepts(wrong)).toBe(false);
	});

	it("admits the wrong direction on the kind itself, so only the end refuses it", () => {
		expect(transcriptPage.is(page) && transcriptPage.is(pageRequest)).toBe(true);
		expect(permission.is(pending) && permission.is(decision)).toBe(true);
		expect(mode.is(state) && mode.is(set)).toBe(true);
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
