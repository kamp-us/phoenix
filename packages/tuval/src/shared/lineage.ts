import {Result, Schema} from "effect";
import {SessionIdentity, sessionIdentity} from "./discovery.js";

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
	parent: Schema.optionalKey(SessionIdentity),
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
	left.parent === right.parent &&
	left.observedAt === right.observedAt
		? Result.succeed(left)
		: Result.fail(
				new LineageConflictError({
					recordId: left.id,
					message: `Continuity observation ${left.id} has conflicting values`,
				}),
			);

const conflict = (recordId: string, message: string): Result.Result<never, LineageConflictError> =>
	Result.fail(new LineageConflictError({recordId, message}));

export const validateLineageStore = (
	document: LineageStoreDocument,
): Result.Result<LineageStoreDocument, LineageConflictError> => {
	const nodeIds = new Set<string>();
	const piSessionIds = new Set<string>();
	const sourceOwners = new Map<string, string>();
	for (const node of document.nodes) {
		if (node.piSessionId.trim().length === 0) {
			return conflict(node.id, `Session node ${node.id} has an empty pi session id`);
		}
		if (nodeIds.has(node.id)) return conflict(node.id, `Duplicate session node ${node.id}`);
		if (piSessionIds.has(node.piSessionId)) {
			return conflict(node.piSessionId, `Duplicate pi session ${node.piSessionId}`);
		}
		if (node.id !== sessionIdentity(node.piSessionId)) {
			return conflict(node.id, `Session node ${node.id} has a non-canonical identity`);
		}
		nodeIds.add(node.id);
		piSessionIds.add(node.piSessionId);
		for (const source of node.sourceFiles) {
			const owner = sourceOwners.get(source);
			if (owner !== undefined) {
				return conflict(
					source,
					`Session file ${source} has duplicate owners ${owner} and ${node.id}`,
				);
			}
			sourceOwners.set(source, node.id);
		}
	}

	const edgeIds = new Set<string>();
	const runOwners = new Set<string>();
	const spawnChildren = new Set<string>();
	for (const edge of document.edges) {
		if (edgeIds.has(edge.id)) return conflict(edge.id, `Duplicate lineage edge ${edge.id}`);
		if (!nodeIds.has(edge.parent) || !nodeIds.has(edge.child)) {
			return conflict(edge.id, `Lineage edge ${edge.id} references an unknown session`);
		}
		if (edge.parent === edge.child) {
			return conflict(edge.id, `Lineage edge ${edge.id} is a self edge`);
		}
		const expectedId = edge.kind === "spawn" ? `spawn:${edge.runId}` : `fork:${edge.child}`;
		if (edge.kind === "spawn" && edge.runId.trim().length === 0) {
			return conflict(edge.id, `Spawn edge ${edge.id} has an empty run id`);
		}
		if (edge.kind === "spawn" && spawnChildren.has(edge.child)) {
			return conflict(edge.child, `Session ${edge.child} has multiple spawn origins`);
		}
		if (edge.kind === "spawn" && runOwners.has(edge.runId)) {
			return conflict(edge.runId, `Run ${edge.runId} has duplicate durable ownership`);
		}
		if (edge.kind === "spawn") {
			runOwners.add(edge.runId);
			spawnChildren.add(edge.child);
		}
		if (edge.id !== expectedId) {
			return conflict(edge.id, `Lineage edge ${edge.id} has a non-canonical identity`);
		}
		edgeIds.add(edge.id);
	}

	const continuityIds = new Set<string>();
	for (const observation of document.continuity) {
		if (observation.runId.trim().length === 0) {
			return conflict(
				observation.id,
				`Continuity observation ${observation.id} has an empty run id`,
			);
		}
		if (continuityIds.has(observation.id)) {
			return conflict(observation.id, `Duplicate continuity observation ${observation.id}`);
		}
		if (runOwners.has(observation.runId)) {
			return conflict(
				observation.runId,
				`Run ${observation.runId} has duplicate durable ownership`,
			);
		}
		runOwners.add(observation.runId);
		if (!nodeIds.has(observation.session)) {
			return conflict(
				observation.id,
				`Continuity observation ${observation.id} references an unknown session`,
			);
		}
		if (observation.parent !== undefined && !nodeIds.has(observation.parent)) {
			return conflict(
				observation.id,
				`Continuity observation ${observation.id} references an unknown parent session`,
			);
		}
		if (observation.id !== `resume:${observation.runId}`) {
			return conflict(observation.id, `Continuity observation ${observation.id} is non-canonical`);
		}
		continuityIds.add(observation.id);
	}
	return Result.succeed(document);
};

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

	return validateLineageStore({
		version: 1,
		nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
		edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
		continuity: [...continuity.values()].sort((left, right) => left.id.localeCompare(right.id)),
	});
};
