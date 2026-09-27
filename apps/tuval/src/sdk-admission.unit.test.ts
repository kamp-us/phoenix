import type {TuvalConfig} from "@kampus/tuval-sdk/config";
import {NodeId} from "@kampus/tuval-sdk/kernel/ports/graph";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {describe, expect, it} from "vitest";
import {admitBySdk} from "./sdk-admission.ts";

const node = (
	id: string,
	program: string,
	extra: Partial<TuvalConfig["graph"]["nodes"][number]> = {},
) => ({
	id: NodeId.make(id),
	program: ProgramId.make(program),
	on: [],
	...extra,
});

const config = (
	programs: ReadonlyArray<unknown>,
	nodes: TuvalConfig["graph"]["nodes"],
): TuvalConfig => ({
	version: 1,
	features: {},
	programs: [...programs],
	graph: {nodes},
	keys: {},
});

describe("admitBySdk", () => {
	it("answers the layer untouched when every row's range admits the desk's SDK", () => {
		const layer = config([{id: "a", sdk: "^1"}, {id: "b"}], [node("n", "a")]);
		const admitted = admitBySdk(layer, "1.2.0");
		expect(admitted.config).toBe(layer);
		expect(admitted.refused).toStrictEqual([]);
	});

	it("refuses a row out of range and a malformed one, keeping an absent one on the desk's major", () => {
		const admitted = admitBySdk(
			config([{id: "old", sdk: "^1"}, {id: "bad", sdk: "one point oh"}, {id: "plain"}], []),
			"2.0.0",
		);
		expect(admitted.config.programs).toStrictEqual([{id: "plain"}]);
		expect(admitted.refused.map((refusal) => [refusal._tag, refusal.program])).toStrictEqual([
			["tuval/SdkOutOfRange", "old"],
			["tuval/SdkRangeMalformed", "bad"],
		]);
	});

	it("takes a refused row's nodes, their children and every route into them with it", () => {
		const admitted = admitBySdk(
			config(
				[{id: "new", sdk: ">=3"}, {id: "ok"}],
				[
					node("feeder", "ok", {on: [{port: "out", to: {node: NodeId.make("gone"), port: "in"}}]}),
					node("gone", "new"),
					node("under", "ok", {parent: NodeId.make("gone")}),
					node("deeper", "ok", {parent: NodeId.make("under")}),
					node("stays", "ok"),
				],
			),
			"2.0.0",
		);
		expect(admitted.config.graph.nodes).toStrictEqual([node("feeder", "ok"), node("stays", "ok")]);
	});
});
