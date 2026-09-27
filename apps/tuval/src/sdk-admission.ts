/**
 * The SDK range check where the desk admits a config layer's rows (#9686, ruling #9668 R2.2). The
 * desk supplies its one `@kampus/tuval-sdk` to every program, so a row whose declared range excludes
 * that copy's version is refused here and the rest of the layer still runs. A refused row's graph
 * nodes go with it, and so do their child nodes and every route into them, because a node naming a
 * program the registry does not hold would refuse the whole graph at compile.
 *
 * A project node reaches a global row or node by its bare id (`./config-scope.ts`), so what the
 * global layer's refusals removed is handed to each project layer, and the project's connections to
 * it go the same way its own do.
 */

import type {TuvalConfig} from "@kampus/tuval-sdk/config";
import {admitSdk, type SdkRefused} from "@kampus/tuval-sdk/kernel/registry/sdk-range";
import sdkPackage from "@kampus/tuval-sdk/package.json" with {type: "json"};
import {Result} from "effect";

/** The version of the one SDK this desk runs and hands every program. */
export const DESK_SDK_VERSION: string = sdkPackage.version;

/** What a layer's refusals took out: the refused rows' ids and the graph nodes that went with them. */
export interface SdkRemoved {
	readonly programs: ReadonlySet<string>;
	readonly nodes: ReadonlySet<string>;
}

export const nothingRemoved: SdkRemoved = {programs: new Set(), nodes: new Set()};

/** A layer as it runs once its out-of-range rows are refused, beside why each one was. */
export interface SdkAdmission {
	readonly config: TuvalConfig;
	readonly refused: ReadonlyArray<SdkRefused>;
	/** This layer's own removals, which a layer connecting to it by bare id is admitted against. */
	readonly removed: SdkRemoved;
}

export interface SdkAdmissionOptions {
	/** The SDK version rows are checked against; the desk's own by default. */
	readonly sdk?: string;
	/** What the layer this one connects to removed; nothing by default. */
	readonly upstream?: SdkRemoved;
}

interface DeclaredRow {
	readonly id: string;
	readonly sdk?: unknown;
}

/** Every node of this layer that runs a removed program or sits under a removed node. */
const droppedNodes = (
	config: TuvalConfig,
	programs: ReadonlySet<string>,
	upstream: ReadonlySet<string>,
): ReadonlySet<string> => {
	const dropped = new Set<string>();
	// A parent is declared before its child, so one pass in authoring order reaches every descendant.
	for (const node of config.graph.nodes) {
		const {parent} = node;
		if (
			programs.has(node.program) ||
			(parent !== undefined && (dropped.has(parent) || upstream.has(parent)))
		) {
			dropped.add(node.id);
		}
	}
	return dropped;
};

/** `config` with every row whose SDK range excludes the desk's refused, and its graph taken with it. */
export const admitBySdk = (
	config: TuvalConfig,
	{sdk = DESK_SDK_VERSION, upstream = nothingRemoved}: SdkAdmissionOptions = {},
): SdkAdmission => {
	const refused: Array<SdkRefused> = [];
	const programs = config.programs.filter((row) => {
		const {id, sdk: declared} = row as DeclaredRow;
		const admitted = admitSdk(id, declared, sdk);
		if (Result.isFailure(admitted)) refused.push(admitted.failure);
		return Result.isSuccess(admitted);
	});
	const own = new Set(refused.map((refusal) => refusal.program));
	const dropped = droppedNodes(config, new Set([...upstream.programs, ...own]), upstream.nodes);
	const gone = (node: string) => dropped.has(node) || upstream.nodes.has(node);
	const removed: SdkRemoved = {programs: own, nodes: dropped};
	const touched =
		refused.length > 0 ||
		dropped.size > 0 ||
		config.graph.nodes.some((node) => node.on.some((route) => gone(route.to.node)));
	if (!touched) return {config, refused, removed};
	const nodes = config.graph.nodes
		.filter((node) => !dropped.has(node.id))
		.map((node) => ({...node, on: node.on.filter((route) => !gone(route.to.node))}));
	return {config: {...config, programs, graph: {nodes}}, refused, removed};
};
