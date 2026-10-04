import type {TuvalConfig} from "@kampus/tuval-sdk/config";
import {featuresDefault} from "@kampus/tuval-sdk/kernel/features";
import {NodeId} from "@kampus/tuval-sdk/kernel/ports/graph";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {describe, expect, it} from "vitest";
import {admitRows} from "./sdk-admission.ts";

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
	recommends: [],
});

describe("admitRows", () => {
	it("answers the layer untouched when every row's range admits the desk's SDK", () => {
		const layer = config([{id: "a", sdk: "^1"}, {id: "b"}], [node("n", "a")]);
		const admitted = admitRows(layer, {sdk: "1.2.0", features: featuresDefault});
		expect(admitted.config).toBe(layer);
		expect(admitted.refused).toStrictEqual([]);
	});

	it("refuses a row out of range and a malformed one, keeping an absent one on the desk's major", () => {
		const admitted = admitRows(
			config([{id: "old", sdk: "^1"}, {id: "bad", sdk: "one point oh"}, {id: "plain"}], []),
			{sdk: "2.0.0", features: featuresDefault},
		);
		expect(admitted.config.programs).toStrictEqual([{id: "plain"}]);
		expect(admitted.refused.map((refusal) => [refusal._tag, refusal.program])).toStrictEqual([
			["tuval/SdkOutOfRange", "old"],
			["tuval/SdkRangeMalformed", "bad"],
		]);
	});

	it("takes a refused row's nodes, their children and every route into them with it", () => {
		const admitted = admitRows(
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
			{sdk: "2.0.0", features: featuresDefault},
		);
		expect(admitted.config.graph.nodes).toStrictEqual([node("feeder", "ok"), node("stays", "ok")]);
		expect(admitted.removed).toStrictEqual({
			programs: new Set(["new"]),
			nodes: new Set(["gone", "under", "deeper"]),
		});
	});

	it("drops what connects to an upstream layer's removals, though none of this layer's rows is refused", () => {
		const upstream = {programs: new Set(["refused"]), nodes: new Set(["far"])};
		const admitted = admitRows(
			config(
				[{id: "ok"}],
				[
					node("runs", "refused"),
					node("under-far", "ok", {parent: NodeId.make("far")}),
					node("under-runs", "ok", {parent: NodeId.make("runs")}),
					node("feeder", "ok", {on: [{port: "out", to: {node: NodeId.make("far"), port: "in"}}]}),
				],
			),
			{sdk: "2.0.0", upstream, features: featuresDefault},
		);
		expect(admitted.refused).toStrictEqual([]);
		expect(admitted.config.programs).toStrictEqual([{id: "ok"}]);
		expect(admitted.config.graph.nodes).toStrictEqual([node("feeder", "ok")]);
		expect(admitted.removed.programs).toStrictEqual(new Set());
	});
});

describe("admitRows and the flags a row needs (#9687)", () => {
	const flags = {...featuresDefault, processBoard: true, windowTitles: false};

	it("refuses a row needing an off flag or an unknown one, naming the row and the flag", () => {
		const admitted = admitRows(
			config(
				[
					{id: "board", needsFeatures: ["processBoard"]},
					{id: "titles", needsFeatures: ["processBoard", "windowTitles"]},
					{id: "typo", needsFeatures: ["procesBoard"]},
					{id: "plain"},
				],
				[node("titled", "titles"), node("kept", "board")],
			),
			{features: flags},
		);
		expect(admitted.config.programs).toStrictEqual([
			{id: "board", needsFeatures: ["processBoard"]},
			{id: "plain"},
		]);
		expect(admitted.config.graph.nodes).toStrictEqual([node("kept", "board")]);
		expect(admitted.refused.map((refusal) => refusal.message)).toStrictEqual([
			'program "titles" needs feature flag "windowTitles", which the global config leaves off; it was not loaded',
			'program "typo" needs feature flag "procesBoard", which this desk does not have; it was not loaded',
		]);
	});
});
