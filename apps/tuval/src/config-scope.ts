/**
 * Project scoping for the config layers (#9684, ruling #9668 R4.1). A project's rows and graph nodes
 * run under `<project>/<id>`, so a project row with a global row's id sits beside that row rather
 * than replacing it. A project's connections — a node's program, its parent, and each route's
 * target — name a bare id, which resolves to the project's own row or node when one exists and to
 * the global one otherwise. A connection to another project is refused, and so is a global one into
 * any project: the global layer reaches a project only through a connection that project declares.
 *
 * Each check answers the refusal's reason, or the layer as it runs; the loader turns a reason into
 * a `ConfigLoadError` naming the module.
 */

import type {TuvalConfig} from "@kampus/tuval-sdk/config";
import {type GraphNode, NodeId} from "@kampus/tuval-sdk/kernel/ports/graph";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {SCOPE_SEPARATOR, scopedIdParts} from "@kampus/tuval-sdk/kernel/registry/scoped-id";
import {Result} from "effect";
import type {ProjectId} from "./project-id.ts";

type Node = TuvalConfig["graph"]["nodes"][number];

const rowId = (row: unknown): string => (row as {readonly id: string}).id;

const scoped = (id: string): boolean => id.includes(SCOPE_SEPARATOR);

/** Every id a node connects to: its program, its parent, and the target of each of its routes. */
const connections = (node: Node): ReadonlyArray<string> => [
	node.program,
	...(node.parent === undefined ? [] : [node.parent]),
	...node.on.map((route) => route.to.node),
];

/**
 * Why a layer may not declare what it declares: a row or node id carrying the scope separator. A
 * declared id is always local, whichever layer it is in, so a global row can never pass for a
 * project's.
 */
export const reservedSeparator = (config: TuvalConfig): Result.Result<TuvalConfig, string> => {
	const row = config.programs.map(rowId).find(scoped);
	if (row !== undefined) {
		return Result.fail(
			`declares program row "${row}"; "${SCOPE_SEPARATOR}" is reserved for project-scoped ids`,
		);
	}
	const node = config.graph.nodes.find((candidate) => scoped(candidate.id));
	return node === undefined
		? Result.succeed(config)
		: Result.fail(
				`declares graph node "${node.id}"; "${SCOPE_SEPARATOR}" is reserved for project-scoped ids`,
			);
};

/**
 * The global layer as it runs: unchanged, once no node of it connects into a project and it
 * recommends nothing. A recommendation is a project's suggestion to whoever opens it (#9695), and
 * nobody opens the home config.
 */
export const globalLayer = (config: TuvalConfig): Result.Result<TuvalConfig, string> => {
	if (config.recommends.length > 0) {
		return Result.fail(
			`recommends ${config.recommends.join(", ")}; only a project's config recommends packages, because nobody opens the global one`,
		);
	}
	for (const node of config.graph.nodes) {
		const into = connections(node).find(scoped);
		if (into !== undefined) {
			return Result.fail(
				`global node "${node.id}" connects to "${into}", a project's; a global program reaches a project only through a connection that project's config declares`,
			);
		}
	}
	return Result.succeed(config);
};

/**
 * The project layer as it runs: every row and node under `project`'s scope, and every connection
 * resolved against the project first and the global layer second. A subproject's `parent` is named
 * so its refusal says which boundary it hit: a subproject's config cannot connect up (#9689).
 */
export const projectLayer = (
	project: ProjectId,
	config: TuvalConfig,
	parent?: ProjectId,
): Result.Result<TuvalConfig, string> => {
	const rows = new Set(config.programs.map(rowId));
	const nodes = new Set<string>(config.graph.nodes.map((node) => node.id));
	const resolve = (from: Node, id: string, own: ReadonlySet<string>) => {
		const {scope} = scopedIdParts(id);
		if (scope === undefined) return Result.succeed(own.has(id) ? project.scope(id) : id);
		if (scope === project.key) return Result.succeed(id);
		if (scope === parent?.key) {
			return Result.fail(
				`subproject node "${project.scope(from.id)}" connects to "${id}", its parent ${parent.name}'s; a subproject's config cannot connect up to its parent`,
			);
		}
		return Result.fail(
			`project node "${project.scope(from.id)}" connects to "${id}", another project's; a project connects only to its own programs and global ones`,
		);
	};
	const scopeNode = (node: Node): Result.Result<GraphNode, string> =>
		Result.gen(function* () {
			const program = yield* resolve(node, node.program, rows);
			const parent =
				node.parent === undefined ? undefined : yield* resolve(node, node.parent, nodes);
			const on: Array<GraphNode["on"][number]> = [];
			for (const route of node.on) {
				const target = yield* resolve(node, route.to.node, nodes);
				on.push({port: route.port, to: {node: NodeId.make(target), port: route.to.port}});
			}
			return {
				id: NodeId.make(project.scope(node.id)),
				program: ProgramId.make(program),
				...(parent === undefined ? {} : {parent: NodeId.make(parent)}),
				on,
			};
		});
	return Result.map(Result.all(config.graph.nodes.map(scopeNode)), (scopedNodes) => ({
		...config,
		// Config rows are trusted local code, opaque past their id (#7484 R1.1): the copy changes the
		// id and nothing else.
		programs: config.programs.map((row) => ({
			...(row as object),
			id: project.scope(rowId(row)),
		})),
		graph: {nodes: scopedNodes},
	}));
};
