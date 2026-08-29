import {Result, Schema} from "effect";
import {SessionIdentity, sessionIdentity} from "./discovery.js";

export const LineageNode = Schema.Struct({
	id: SessionIdentity,
	piSessionId: Schema.String,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
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
	observedAt: Schema.Finite,
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
	observedAt: Schema.Finite,
});
export type ContinuityObservation = (typeof ContinuityObservation)["Type"];

export const AuthoritativeParentReference = Schema.Union([
	Schema.Struct({kind: Schema.Literal("none")}),
	Schema.Struct({kind: Schema.Literal("run"), value: Schema.String}),
	Schema.Struct({kind: Schema.Literal("session"), value: Schema.String}),
]);
export type AuthoritativeParentReference = (typeof AuthoritativeParentReference)["Type"];

export const RunOwnership = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("wrapper"),
		runId: Schema.String,
		session: SessionIdentity,
		parentReference: AuthoritativeParentReference,
		observedAt: Schema.Finite,
	}),
	Schema.Struct({
		kind: Schema.Literal("direct"),
		runId: Schema.String,
		session: SessionIdentity,
		parentReference: AuthoritativeParentReference,
		observedAt: Schema.Finite,
	}),
	Schema.Struct({
		kind: Schema.Literal("observation"),
		runId: Schema.String,
		session: SessionIdentity,
		parentReference: AuthoritativeParentReference,
		parent: Schema.optionalKey(SessionIdentity),
		observedAt: Schema.Finite,
	}),
]);
export type RunOwnership = (typeof RunOwnership)["Type"];

export const LineageStoreDocument = Schema.Struct({
	version: Schema.Literal(2),
	nodes: Schema.Array(LineageNode),
	edges: Schema.Array(LineageEdge),
	continuity: Schema.Array(ContinuityObservation),
	ownership: Schema.Array(RunOwnership),
});
export type LineageStoreDocument = (typeof LineageStoreDocument)["Type"];

export const LineageProblem = Schema.Struct({
	code: Schema.Literals([
		"malformed-run",
		"malformed-session",
		"unresolved-session",
		"retention-loss",
		"protocol-unavailable",
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
	readonly ownership?: ReadonlyArray<RunOwnership>;
}

export class LineageConflictError extends Schema.TaggedErrorClass<LineageConflictError>()(
	"tuval/LineageConflictError",
	{recordId: Schema.String, message: Schema.String},
) {}

export const emptyLineageStore = (): LineageStoreDocument => ({
	version: 2,
	nodes: [],
	edges: [],
	continuity: [],
	ownership: [],
});

const conflict = (recordId: string, message: string): Result.Result<never, LineageConflictError> =>
	Result.fail(new LineageConflictError({recordId, message}));

const decodeRecord = <A>(
	schema: Schema.Codec<A, unknown, never, never>,
	value: unknown,
	recordId: string,
): Result.Result<A, LineageConflictError> => {
	const decoded = Schema.decodeUnknownResult(schema)(value);
	return Result.isFailure(decoded)
		? conflict(recordId, `Lineage record ${recordId} is structurally invalid`)
		: Result.succeed(decoded.success);
};

export const compareLineageText = (left: string, right: string): number =>
	left === right ? 0 : left < right ? -1 : 1;

export const compareLineageObservation = (
	left: {readonly observedAt: number; readonly runId: string},
	right: {readonly observedAt: number; readonly runId: string},
): number => left.observedAt - right.observedAt || compareLineageText(left.runId, right.runId);

const canonicalDocument = (document: LineageStoreDocument): LineageStoreDocument => ({
	version: 2,
	nodes: document.nodes
		.map((node) => ({
			...node,
			sourceFiles: [...new Set(node.sourceFiles)].sort(compareLineageText),
		}))
		.sort((left, right) => compareLineageText(left.id, right.id)),
	edges: [...document.edges].sort((left, right) => compareLineageText(left.id, right.id)),
	continuity: [...document.continuity].sort((left, right) => compareLineageText(left.id, right.id)),
	ownership: [...document.ownership].sort((left, right) =>
		compareLineageText(left.runId, right.runId),
	),
});

const mergeNode = (
	left: LineageNode,
	right: LineageNode,
): Result.Result<LineageNode, LineageConflictError> => {
	if (left.piSessionId !== right.piSessionId) {
		return conflict(left.id, `Session ${left.id} maps to conflicting pi session ids`);
	}
	const latest =
		left.updatedAt > right.updatedAt ||
		(left.updatedAt === right.updatedAt && compareLineageText(left.cwd, right.cwd) <= 0)
			? left
			: right;
	return Result.succeed({
		id: left.id,
		piSessionId: left.piSessionId,
		createdAt: Math.min(left.createdAt, right.createdAt),
		updatedAt: Math.max(left.updatedAt, right.updatedAt),
		cwd: latest.cwd,
		sourceFiles: [...new Set([...left.sourceFiles, ...right.sourceFiles])].sort(compareLineageText),
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
		return conflict(left.id, `Fork edge ${left.id} maps to conflicting children`);
	}
	if (left.parent === right.parent)
		return Result.succeed(left.source === "protocol" ? left : right);
	if (left.source !== right.source)
		return Result.succeed(left.source === "protocol" ? left : right);
	return conflict(left.id, `Fork edge ${left.id} has conflicting ${left.source} parents`);
};

const mergeEdge = (
	left: LineageEdge,
	right: LineageEdge,
): Result.Result<LineageEdge, LineageConflictError> => {
	if (left.kind === "fork" && right.kind === "fork") return mergeFork(left, right);
	if (left.kind === "spawn" && right.kind === "spawn" && sameSpawn(left, right)) {
		return Result.succeed(left);
	}
	return conflict(left.id, `Lineage edge ${left.id} has conflicting observations`);
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
		: conflict(left.id, `Continuity observation ${left.id} has conflicting values`);

const sameParentReference = (
	left: AuthoritativeParentReference,
	right: AuthoritativeParentReference,
): boolean =>
	left.kind === right.kind &&
	(left.kind === "none" || (right.kind !== "none" && left.value === right.value));

const mergeOwnership = (
	left: RunOwnership,
	right: RunOwnership,
): Result.Result<RunOwnership, LineageConflictError> => {
	if (left.session !== right.session) {
		return conflict(left.runId, `Run ${left.runId} maps to conflicting sessions`);
	}
	if (!sameParentReference(left.parentReference, right.parentReference)) {
		return conflict(
			left.runId,
			`Run ${left.runId} has conflicting authoritative parent references`,
		);
	}
	if (left.observedAt !== right.observedAt) {
		return conflict(left.runId, `Run ${left.runId} has conflicting authoritative timestamps`);
	}
	if (left.kind === "wrapper" && right.kind === "wrapper") return Result.succeed(left);
	if (left.kind === "wrapper") return Result.succeed(right);
	if (right.kind === "wrapper") return Result.succeed(left);
	if (left.kind === "direct" && right.kind === "direct") return Result.succeed(left);
	if (left.kind === "observation" && right.kind === "direct") return Result.succeed(left);
	if (left.kind === "direct" && right.kind === "observation") return Result.succeed(right);
	if (left.kind !== "observation" || right.kind !== "observation") {
		return conflict(left.runId, `Run ${left.runId} has incompatible ownership records`);
	}
	return left.observedAt === right.observedAt && left.parent === right.parent
		? Result.succeed(left)
		: conflict(left.runId, `Run ${left.runId} has conflicting authoritative observations`);
};

const cycleFrom = (
	start: string,
	adjacency: ReadonlyMap<string, ReadonlyArray<string>>,
	visiting: Set<string>,
	visited: Set<string>,
): boolean => {
	if (visiting.has(start)) return true;
	if (visited.has(start)) return false;
	visiting.add(start);
	for (const child of adjacency.get(start) ?? []) {
		if (cycleFrom(child, adjacency, visiting, visited)) return true;
	}
	visiting.delete(start);
	visited.add(start);
	return false;
};

export const validateLineageStore = (
	document: LineageStoreDocument,
): Result.Result<LineageStoreDocument, LineageConflictError> => {
	const nodeIds = new Set<string>();
	const piSessionIds = new Set<string>();
	const sourceOwners = new Map<string, string>();
	for (const node of document.nodes) {
		if (!Number.isFinite(node.createdAt) || !Number.isFinite(node.updatedAt)) {
			return conflict(node.id, `Session node ${node.id} has a non-finite timestamp`);
		}
		if (node.createdAt > node.updatedAt) {
			return conflict(node.id, `Session node ${node.id} has a backward time interval`);
		}
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

	const ownershipByRun = new Map<string, RunOwnership>();
	for (const ownership of document.ownership) {
		if (ownership.runId.trim().length === 0) {
			return conflict(ownership.runId, "Run ownership has an empty run id");
		}
		if (ownershipByRun.has(ownership.runId)) {
			return conflict(ownership.runId, `Run ${ownership.runId} has duplicate durable ownership`);
		}
		if (!nodeIds.has(ownership.session)) {
			return conflict(ownership.runId, `Run ${ownership.runId} owns an unknown session`);
		}
		if (
			ownership.parentReference.kind !== "none" &&
			ownership.parentReference.value.trim().length === 0
		) {
			return conflict(ownership.runId, `Run ${ownership.runId} has an empty parent reference`);
		}
		if (!Number.isFinite(ownership.observedAt)) {
			return conflict(ownership.runId, `Run ${ownership.runId} has a non-finite timestamp`);
		}
		if (ownership.kind === "observation") {
			if (!Number.isFinite(ownership.observedAt)) {
				return conflict(ownership.runId, `Run ${ownership.runId} has a non-finite timestamp`);
			}
			if (ownership.parent !== undefined && !nodeIds.has(ownership.parent)) {
				return conflict(ownership.runId, `Run ${ownership.runId} has an unknown parent session`);
			}
			if (ownership.parentReference.kind === "none" && ownership.parent !== undefined) {
				return conflict(
					ownership.runId,
					`Run ${ownership.runId} has parent data but no parent reference`,
				);
			}
			if (ownership.parentReference.kind !== "none" && ownership.parent === undefined) {
				return conflict(ownership.runId, `Run ${ownership.runId} lost its resolved parent`);
			}
		}
		ownershipByRun.set(ownership.runId, ownership);
	}
	for (const ownership of document.ownership) {
		if (ownership.kind !== "observation" || ownership.parentReference.kind !== "run") continue;
		const referenced = ownershipByRun.get(ownership.parentReference.value);
		if (referenced === undefined) {
			return conflict(
				ownership.runId,
				`Run ${ownership.runId} references missing parent run ${ownership.parentReference.value}`,
			);
		}
		if (referenced.session !== ownership.parent) {
			return conflict(
				ownership.runId,
				`Run ${ownership.runId} disagrees with parent run ${ownership.parentReference.value}`,
			);
		}
	}

	const edgeIds = new Set<string>();
	const spawnChildren = new Map<string, SpawnLineageEdge>();
	const adjacency = new Map<string, Array<string>>();
	for (const edge of document.edges) {
		if (edgeIds.has(edge.id)) return conflict(edge.id, `Duplicate lineage edge ${edge.id}`);
		if (!nodeIds.has(edge.parent) || !nodeIds.has(edge.child)) {
			return conflict(edge.id, `Lineage edge ${edge.id} references an unknown session`);
		}
		if (edge.parent === edge.child)
			return conflict(edge.id, `Lineage edge ${edge.id} is a self edge`);
		const expectedId = edge.kind === "spawn" ? `spawn:${edge.runId}` : `fork:${edge.child}`;
		if (edge.id !== expectedId) {
			return conflict(edge.id, `Lineage edge ${edge.id} has a non-canonical identity`);
		}
		if (edge.kind === "spawn") {
			if (!Number.isFinite(edge.observedAt) || edge.runId.trim().length === 0) {
				return conflict(edge.id, `Spawn edge ${edge.id} has invalid run data`);
			}
			if (spawnChildren.has(edge.child)) {
				return conflict(edge.child, `Session ${edge.child} has multiple spawn origins`);
			}
			const ownership = ownershipByRun.get(edge.runId);
			if (
				ownership?.kind !== "observation" ||
				ownership.session !== edge.child ||
				ownership.parent !== edge.parent ||
				ownership.observedAt !== edge.observedAt
			) {
				return conflict(edge.runId, `Spawn edge ${edge.id} disagrees with durable run ownership`);
			}
			spawnChildren.set(edge.child, edge);
		}
		const children = adjacency.get(edge.parent) ?? [];
		children.push(edge.child);
		adjacency.set(edge.parent, children);
		edgeIds.add(edge.id);
	}
	const visited = new Set<string>();
	for (const nodeId of nodeIds) {
		if (cycleFrom(nodeId, adjacency, new Set(), visited)) {
			return conflict(nodeId, `Lineage graph contains a cycle through ${nodeId}`);
		}
	}

	const continuityIds = new Set<string>();
	for (const observation of document.continuity) {
		if (!Number.isFinite(observation.observedAt) || observation.runId.trim().length === 0) {
			return conflict(
				observation.id,
				`Continuity observation ${observation.id} has invalid run data`,
			);
		}
		if (continuityIds.has(observation.id)) {
			return conflict(observation.id, `Duplicate continuity observation ${observation.id}`);
		}
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
		const origin = spawnChildren.get(observation.session);
		if (
			origin === undefined ||
			observation.runId === origin.runId ||
			compareLineageObservation(observation, origin) <= 0
		) {
			return conflict(
				observation.id,
				`Continuity observation ${observation.id} precedes its spawn origin`,
			);
		}
		const ownership = ownershipByRun.get(observation.runId);
		if (
			ownership?.kind !== "observation" ||
			ownership.session !== observation.session ||
			ownership.parent !== observation.parent ||
			ownership.observedAt !== observation.observedAt
		) {
			return conflict(
				observation.runId,
				`Continuity ${observation.id} disagrees with durable run ownership`,
			);
		}
		continuityIds.add(observation.id);
	}
	return Result.succeed(canonicalDocument(document));
};

const validateIncoming = (records: LineageRecords): Result.Result<void, LineageConflictError> => {
	for (const node of records.nodes) {
		const decoded = decodeRecord(LineageNode, node, node.id);
		if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
		if (node.createdAt > node.updatedAt) {
			return conflict(node.id, `Session node ${node.id} has a backward time interval`);
		}
	}
	for (const edge of records.edges) {
		const decoded = decodeRecord(LineageEdge, edge, edge.id);
		if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
	}
	for (const observation of records.continuity) {
		const decoded = decodeRecord(ContinuityObservation, observation, observation.id);
		if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
	}
	for (const ownership of records.ownership ?? []) {
		const decoded = decodeRecord(RunOwnership, ownership, ownership.runId);
		if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
	}
	return Result.succeed(undefined);
};

export const upsertLineageRecords = (
	current: LineageStoreDocument,
	incoming: LineageRecords,
): Result.Result<LineageStoreDocument, LineageConflictError> => {
	const currentValidated = validateLineageStore(current);
	if (Result.isFailure(currentValidated)) return Result.fail(currentValidated.failure);
	const incomingValidated = validateIncoming(incoming);
	if (Result.isFailure(incomingValidated)) return Result.fail(incomingValidated.failure);
	const nodes = new Map(currentValidated.success.nodes.map((node) => [node.id, node]));
	const sourceOwners = new Map(
		currentValidated.success.nodes.flatMap((node) =>
			node.sourceFiles.map((source) => [source, node.id] as const),
		),
	);
	for (const node of incoming.nodes) {
		for (const source of node.sourceFiles) {
			const owner = sourceOwners.get(source);
			if (owner !== undefined && owner !== node.id) {
				return conflict(source, `Session file ${source} maps to conflicting session identities`);
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

	const edges = new Map(currentValidated.success.edges.map((edge) => [edge.id, edge]));
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
		currentValidated.success.continuity.map((observation) => [observation.id, observation]),
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

	const ownership = new Map(
		currentValidated.success.ownership.map((record) => [record.runId, record]),
	);
	for (const record of incoming.ownership ?? []) {
		const existing = ownership.get(record.runId);
		if (existing === undefined) ownership.set(record.runId, record);
		else {
			const merged = mergeOwnership(existing, record);
			if (Result.isFailure(merged)) return Result.fail(merged.failure);
			ownership.set(record.runId, merged.success);
		}
	}

	return validateLineageStore({
		version: 2,
		nodes: [...nodes.values()],
		edges: [...edges.values()],
		continuity: [...continuity.values()],
		ownership: [...ownership.values()],
	});
};
