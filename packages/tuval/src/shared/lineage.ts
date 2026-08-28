import {Result, Schema} from "effect";
import {SessionIdentity} from "./discovery.js";

export const LineageNode = Schema.Struct({
	id: SessionIdentity,
	piSessionId: Schema.String,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
	cwd: Schema.String,
	sourceFiles: Schema.Array(Schema.String),
});
export type LineageNode = (typeof LineageNode)["Type"];

export const SpawnLineageEdge = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("spawn"),
	parent: SessionIdentity,
	child: SessionIdentity,
	runId: Schema.String,
	observedAt: Schema.Number,
});
export type SpawnLineageEdge = (typeof SpawnLineageEdge)["Type"];

export const ForkLineageEdge = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("fork"),
	parent: SessionIdentity,
	child: SessionIdentity,
	source: Schema.Literals(["protocol", "header"]),
});
export type ForkLineageEdge = (typeof ForkLineageEdge)["Type"];

export const LineageEdge = Schema.Union([SpawnLineageEdge, ForkLineageEdge]);
export type LineageEdge = (typeof LineageEdge)["Type"];

export const ContinuityObservation = Schema.Struct({
	id: Schema.String,
	runId: Schema.String,
	session: SessionIdentity,
	observedAt: Schema.Number,
});
export type ContinuityObservation = (typeof ContinuityObservation)["Type"];

export const LineageStoreDocument = Schema.Struct({
	version: Schema.Literal(1),
	nodes: Schema.Array(LineageNode),
	edges: Schema.Array(LineageEdge),
	continuity: Schema.Array(ContinuityObservation),
});
export type LineageStoreDocument = (typeof LineageStoreDocument)["Type"];

export const LineageProblem = Schema.Struct({
	code: Schema.Literals([
		"malformed-run",
		"malformed-session",
		"unresolved-session",
		"retention-loss",
	]),
	source: Schema.String,
	message: Schema.String,
});
export type LineageProblem = (typeof LineageProblem)["Type"];

export const LineageProjection = Schema.Struct({
	graph: LineageStoreDocument,
	problems: Schema.Array(LineageProblem),
});
export type LineageProjection = (typeof LineageProjection)["Type"];

export interface LineageRecords {
	readonly nodes: ReadonlyArray<LineageNode>;
	readonly edges: ReadonlyArray<LineageEdge>;
	readonly continuity: ReadonlyArray<ContinuityObservation>;
}

export class LineageConflictError extends Schema.TaggedErrorClass<LineageConflictError>()(
	"tuval/LineageConflictError",
	{recordId: Schema.String, message: Schema.String},
) {}

export const emptyLineageStore = (): LineageStoreDocument => ({
	version: 1,
	nodes: [],
	edges: [],
	continuity: [],
});

const mergeNode = (
	left: LineageNode,
	right: LineageNode,
): Result.Result<LineageNode, LineageConflictError> => {
	if (left.piSessionId !== right.piSessionId) {
		return Result.fail(
			new LineageConflictError({
				recordId: left.id,
				message: `Session ${left.id} maps to conflicting pi session ids`,
			}),
		);
	}
	const latest =
		left.updatedAt > right.updatedAt ||
		(left.updatedAt === right.updatedAt && left.cwd.localeCompare(right.cwd) <= 0)
			? left
			: right;
	return Result.succeed({
		id: left.id,
		piSessionId: left.piSessionId,
		createdAt: Math.min(left.createdAt, right.createdAt),
		updatedAt: Math.max(left.updatedAt, right.updatedAt),
		cwd: latest.cwd,
		sourceFiles: [...new Set([...left.sourceFiles, ...right.sourceFiles])].sort(),
	});
};

const sameSpawn = (left: SpawnLineageEdge, right: SpawnLineageEdge): boolean =>
	left.parent === right.parent &&
	left.child === right.child &&
	left.runId === right.runId &&
	left.observedAt === right.observedAt;

const mergeFork = (
	left: ForkLineageEdge,
	right: ForkLineageEdge,
): Result.Result<ForkLineageEdge, LineageConflictError> => {
	if (left.child !== right.child) {
		return Result.fail(
			new LineageConflictError({
				recordId: left.id,
				message: `Fork edge ${left.id} maps to conflicting children`,
			}),
		);
	}
	if (left.parent === right.parent) {
		return Result.succeed(left.source === "protocol" ? left : right);
	}
	if (left.source !== right.source) {
		return Result.succeed(left.source === "protocol" ? left : right);
	}
	return Result.fail(
		new LineageConflictError({
			recordId: left.id,
			message: `Fork edge ${left.id} has conflicting ${left.source} parents`,
		}),
	);
};

const mergeEdge = (
	left: LineageEdge,
	right: LineageEdge,
): Result.Result<LineageEdge, LineageConflictError> => {
	if (left.kind === "fork" && right.kind === "fork") return mergeFork(left, right);
	if (left.kind === "spawn" && right.kind === "spawn" && sameSpawn(left, right)) {
		return Result.succeed(left);
	}
	return Result.fail(
		new LineageConflictError({
			recordId: left.id,
			message: `Lineage edge ${left.id} has conflicting observations`,
		}),
	);
};

const mergeContinuity = (
	left: ContinuityObservation,
	right: ContinuityObservation,
): Result.Result<ContinuityObservation, LineageConflictError> =>
	left.runId === right.runId &&
	left.session === right.session &&
	left.observedAt === right.observedAt
		? Result.succeed(left)
		: Result.fail(
				new LineageConflictError({
					recordId: left.id,
					message: `Continuity observation ${left.id} has conflicting values`,
				}),
			);

export const upsertLineageRecords = (
	current: LineageStoreDocument,
	incoming: LineageRecords,
): Result.Result<LineageStoreDocument, LineageConflictError> => {
	const nodes = new Map(current.nodes.map((node) => [node.id, node]));
	const sourceOwners = new Map(
		current.nodes.flatMap((node) => node.sourceFiles.map((source) => [source, node.id] as const)),
	);
	for (const node of incoming.nodes) {
		for (const source of node.sourceFiles) {
			const owner = sourceOwners.get(source);
			if (owner !== undefined && owner !== node.id) {
				return Result.fail(
					new LineageConflictError({
						recordId: source,
						message: `Session file ${source} maps to conflicting session identities`,
					}),
				);
			}
			sourceOwners.set(source, node.id);
		}
		const existing = nodes.get(node.id);
		if (existing === undefined) nodes.set(node.id, node);
		else {
			const merged = mergeNode(existing, node);
			if (Result.isFailure(merged)) return Result.fail(merged.failure);
			nodes.set(node.id, merged.success);
		}
	}

	const edges = new Map(current.edges.map((edge) => [edge.id, edge]));
	for (const edge of incoming.edges) {
		const existing = edges.get(edge.id);
		if (existing === undefined) edges.set(edge.id, edge);
		else {
			const merged = mergeEdge(existing, edge);
			if (Result.isFailure(merged)) return Result.fail(merged.failure);
			edges.set(edge.id, merged.success);
		}
	}

	const continuity = new Map(
		current.continuity.map((observation) => [observation.id, observation]),
	);
	for (const observation of incoming.continuity) {
		const existing = continuity.get(observation.id);
		if (existing === undefined) continuity.set(observation.id, observation);
		else {
			const merged = mergeContinuity(existing, observation);
			if (Result.isFailure(merged)) return Result.fail(merged.failure);
			continuity.set(observation.id, merged.success);
		}
	}

	return Result.succeed({
		version: 1,
		nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
		edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
		continuity: [...continuity.values()].sort((left, right) => left.id.localeCompare(right.id)),
	});
};
