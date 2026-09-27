/**
 * The SDK range check where the desk admits a config layer's rows (#9686, ruling #9668 R2.2). The
 * desk supplies its one `@kampus/tuval-sdk` to every program, so a row whose declared range excludes
 * that copy's version is refused here and the rest of the layer still runs. A refused row's graph
 * nodes go with it, and so do their child nodes and every route into them, because a node naming a
 * program the registry does not hold would refuse the whole graph at compile.
 */

import type {TuvalConfig} from "@kampus/tuval-sdk/config";
import {admitSdk, type SdkRefused} from "@kampus/tuval-sdk/kernel/registry/sdk-range";
import sdkPackage from "@kampus/tuval-sdk/package.json" with {type: "json"};
import {Result} from "effect";

/** The version of the one SDK this desk runs and hands every program. */
export const DESK_SDK_VERSION: string = sdkPackage.version;

/** A layer as it runs once its out-of-range rows are refused, beside why each one was. */
export interface SdkAdmission {
	readonly config: TuvalConfig;
	readonly refused: ReadonlyArray<SdkRefused>;
}

interface DeclaredRow {
	readonly id: string;
	readonly sdk?: unknown;
}

/** Every node that runs a refused program, then every node under one of those, in authoring order. */
const droppedNodes = (config: TuvalConfig, refused: ReadonlySet<string>): ReadonlySet<string> => {
	const dropped = new Set<string>();
	// A parent is declared before its child, so one pass in authoring order reaches every descendant.
	for (const node of config.graph.nodes) {
		if (refused.has(node.program) || (node.parent !== undefined && dropped.has(node.parent))) {
			dropped.add(node.id);
		}
	}
	return dropped;
};

/** `config` with every row whose SDK range excludes `sdk` refused, and its graph taken with it. */
export const admitBySdk = (config: TuvalConfig, sdk: string = DESK_SDK_VERSION): SdkAdmission => {
	const refused: Array<SdkRefused> = [];
	const programs = config.programs.filter((row) => {
		const {id, sdk: declared} = row as DeclaredRow;
		const admitted = admitSdk(id, declared, sdk);
		if (Result.isFailure(admitted)) refused.push(admitted.failure);
		return Result.isSuccess(admitted);
	});
	if (refused.length === 0) return {config, refused};
	const dropped = droppedNodes(config, new Set(refused.map((refusal) => refusal.program)));
	const nodes = config.graph.nodes
		.filter((node) => !dropped.has(node.id))
		.map((node) => ({...node, on: node.on.filter((route) => !dropped.has(route.to.node))}));
	return {config: {...config, programs, graph: {nodes}}, refused};
};
