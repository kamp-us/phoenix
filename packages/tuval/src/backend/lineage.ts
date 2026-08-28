import {homedir, tmpdir} from "node:os";
import {Context, Effect, FileSystem, Layer, Option, Path, Result, Schema} from "effect";
import {type SessionIdentity, sessionIdentity} from "../shared/discovery.js";
import {
	type ContinuityObservation,
	emptyLineageStore,
	LineageConflictError,
	type LineageEdge,
	type LineageNode,
	type LineageProblem,
	type LineageProjection,
	type LineageRecords,
	LineageStoreDocument,
	type LineageStoreDocument as LineageStoreDocumentType,
	upsertLineageRecords,
} from "../shared/lineage.js";
import {PiDiscovery} from "./pi-discovery.js";

const STORE_VERSION = 1;
const FIRST_LINE_LIMIT = 64 * 1024;

const SessionHeader = Schema.Struct({
	type: Schema.Literal("session"),
	version: Schema.Number,
	id: Schema.String,
	timestamp: Schema.optionalKey(Schema.String),
	cwd: Schema.String,
	parentSession: Schema.optionalKey(Schema.String),
	parentSessionId: Schema.optionalKey(Schema.String),
});
type SessionHeader = (typeof SessionHeader)["Type"];

const SourceType = Schema.Struct({type: Schema.String});

const ProtocolSession = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.Number,
	updatedAt: Schema.optionalKey(Schema.Number),
	parentSessionId: Schema.optionalKey(Schema.String),
	cwd: Schema.optionalKey(Schema.String),
});
type ProtocolSession = (typeof ProtocolSession)["Type"];

const RawRunEntry = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	runId: Schema.optionalKey(Schema.String),
	parentRunId: Schema.optionalKey(Schema.String),
	parentWorkflowRunId: Schema.optionalKey(Schema.String),
	sessionFile: Schema.optionalKey(Schema.String),
	startedAt: Schema.optionalKey(Schema.Number),
	children: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	steps: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	results: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
type RawRunEntry = (typeof RawRunEntry)["Type"];

const RawRunStatus = Schema.Struct({
	lifecycleArtifactVersion: Schema.optionalKey(Schema.Number),
	id: Schema.optionalKey(Schema.String),
	runId: Schema.optionalKey(Schema.String),
	sessionId: Schema.optionalKey(Schema.String),
	sessionFile: Schema.optionalKey(Schema.String),
	startedAt: Schema.optionalKey(Schema.Number),
	steps: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	results: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	children: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	workflow: Schema.optionalKey(Schema.Unknown),
});

const RawWorkflow = Schema.Struct({
	value: Schema.optionalKey(
		Schema.Struct({results: Schema.optionalKey(Schema.Array(Schema.Unknown))}),
	),
});

interface SessionArtifact {
	readonly header: SessionHeader;
	readonly sourceFile: string;
	readonly updatedAt: number;
}

interface RunCandidate {
	readonly runId: string;
	readonly wrapperRunId?: string;
	readonly parentRunId?: string;
	readonly parentSessionRef?: string;
	readonly sessionRef: string;
	readonly observedAt: number;
	readonly source: string;
}

interface ScannedFiles {
	readonly files: ReadonlyArray<string>;
	readonly problems: ReadonlyArray<LineageProblem>;
}

export class LineageStoreReadError extends Schema.TaggedErrorClass<LineageStoreReadError>()(
	"tuval/LineageStoreReadError",
	{path: Schema.String, message: Schema.String},
) {}

export class LineageStoreVersionError extends Schema.TaggedErrorClass<LineageStoreVersionError>()(
	"tuval/LineageStoreVersionError",
	{path: Schema.String, found: Schema.Number, supported: Schema.Number},
) {}

class LineageSourceParseError extends Schema.TaggedErrorClass<LineageSourceParseError>()(
	"tuval/LineageSourceParseError",
	{message: Schema.String},
) {}

export interface RefreshLineageOptions {
	readonly runRoots: ReadonlyArray<string>;
	readonly sessionRoots: ReadonlyArray<string>;
	readonly storePath: string;
	readonly protocolSessions?: ReadonlyArray<unknown>;
}

export interface LineageIndexOptions {
	readonly runRoots?: ReadonlyArray<string>;
	readonly sessionRoots?: ReadonlyArray<string>;
	readonly storePath?: string;
	readonly protocolSessions?: ReadonlyArray<unknown>;
}

export class LineageIndexError extends Schema.TaggedErrorClass<LineageIndexError>()(
	"tuval/LineageIndexError",
	{message: Schema.String},
) {}

export interface LineageIndexService {
	readonly project: () => Effect.Effect<LineageProjection, LineageIndexError>;
}

export class LineageIndex extends Context.Service<LineageIndex, LineageIndexService>()(
	"tuval/LineageIndex",
) {}

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const parseJson = Effect.fn("Lineage.parseJson")((text: string) =>
	Effect.try({
		try: (): unknown => JSON.parse(text),
		catch: (error) => new LineageSourceParseError({message: messageOf(error)}),
	}),
);

const scanFiles = Effect.fn("Lineage.scanFiles")(function* (
	roots: ReadonlyArray<string>,
	matches: (name: string) => boolean,
	problemCode: LineageProblem["code"],
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const files: Array<string> = [];
	const problems: Array<LineageProblem> = [];

	const walk = (directory: string): Effect.Effect<void> =>
		Effect.gen(function* () {
			const entries = yield* Effect.result(fs.readDirectory(directory));
			if (Result.isFailure(entries)) {
				if (entries.failure.reason._tag !== "NotFound") {
					problems.push({
						code: problemCode,
						source: directory,
						message: messageOf(entries.failure),
					});
				}
				return;
			}
			for (const name of entries.success) {
				const entryPath = path.join(directory, name);
				if (yield* Effect.isSuccess(fs.readLink(entryPath))) continue;
				const info = yield* Effect.result(fs.stat(entryPath));
				if (Result.isFailure(info)) {
					if (matches(name)) {
						problems.push({
							code: problemCode,
							source: entryPath,
							message: messageOf(info.failure),
						});
					}
					continue;
				}
				if (info.success.type === "Directory") yield* walk(entryPath);
				else if (info.success.type === "File" && matches(name)) files.push(entryPath);
			}
		});

	for (const root of roots) yield* walk(path.resolve(root));
	return {
		files: files.sort(),
		problems: problems.sort((left, right) => left.source.localeCompare(right.source)),
	} satisfies ScannedFiles;
});

const readFirstLine = Effect.fn("Lineage.readFirstLine")(function* (sourceFile: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const file = yield* fs.open(sourceFile, {flag: "r"});
			const bytes = Option.getOrElse(
				yield* file.readAlloc(FIRST_LINE_LIMIT),
				() => new Uint8Array(),
			);
			const text = new TextDecoder().decode(bytes);
			const newline = text.indexOf("\n");
			if (newline === -1 && bytes.length === FIRST_LINE_LIMIT) {
				return yield* new LineageSourceParseError({message: "session header exceeds 64 KiB"});
			}
			return newline === -1 ? text : text.slice(0, newline);
		}),
	);
});

const readSessionArtifact = Effect.fn("Lineage.readSessionArtifact")(function* (
	sourceFile: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const firstLine = yield* readFirstLine(sourceFile).pipe(
		Effect.mapError((error) => new LineageSourceParseError({message: messageOf(error)})),
	);
	const parsed = yield* parseJson(firstLine);
	const type = yield* Schema.decodeUnknownEffect(SourceType)(parsed).pipe(Effect.option);
	if (Option.isNone(type) || type.value.type !== "session") return Option.none<SessionArtifact>();
	const header = yield* Schema.decodeUnknownEffect(SessionHeader)(parsed).pipe(
		Effect.mapError((error) => new LineageSourceParseError({message: messageOf(error)})),
	);
	if (header.id.length === 0) {
		return yield* new LineageSourceParseError({message: "session id is empty"});
	}
	const info = yield* fs.stat(sourceFile);
	const updatedAt = Option.getOrElse(info.mtime, () => new Date(0)).getTime();
	return Option.some({header, sourceFile, updatedAt} satisfies SessionArtifact);
});

const scanSessions = Effect.fn("Lineage.scanSessions")(function* (roots: ReadonlyArray<string>) {
	const scanned = yield* scanFiles(roots, (name) => name.endsWith(".jsonl"), "retention-loss");
	const artifacts: Array<SessionArtifact> = [];
	const problems: Array<LineageProblem> = [...scanned.problems];
	for (const sourceFile of scanned.files) {
		const artifact = yield* Effect.result(readSessionArtifact(sourceFile));
		if (Result.isFailure(artifact)) {
			problems.push({
				code: "malformed-session",
				source: sourceFile,
				message: messageOf(artifact.failure),
			});
		} else if (Option.isSome(artifact.success)) artifacts.push(artifact.success.value);
	}
	return {artifacts, problems};
});

const decodeProtocolSessions = Effect.fn("Lineage.decodeProtocolSessions")(function* (
	values: ReadonlyArray<unknown>,
) {
	const sessions: Array<ProtocolSession> = [];
	for (const value of values) {
		sessions.push(
			yield* Schema.decodeUnknownEffect(ProtocolSession)(value).pipe(
				Effect.mapError(
					(error) =>
						new LineageSourceParseError({
							message: `protocol session metadata is invalid: ${messageOf(error)}`,
						}),
				),
			),
		);
	}
	return sessions;
});

const sessionNodeFromArtifact = (artifact: SessionArtifact): LineageNode => {
	const headerTime =
		artifact.header.timestamp === undefined ? Number.NaN : Date.parse(artifact.header.timestamp);
	const createdAt = Number.isFinite(headerTime) ? Math.floor(headerTime) : artifact.updatedAt;
	return {
		id: sessionIdentity(artifact.header.id),
		piSessionId: artifact.header.id,
		createdAt,
		updatedAt: artifact.updatedAt,
		cwd: artifact.header.cwd,
		sourceFiles: [artifact.sourceFile],
	};
};

const sessionNodeFromProtocol = (
	session: ProtocolSession,
	artifact: SessionArtifact | undefined,
): LineageNode => ({
	id: sessionIdentity(session.id),
	piSessionId: session.id,
	createdAt: session.createdAt,
	updatedAt: session.updatedAt ?? session.createdAt,
	cwd: session.cwd ?? artifact?.header.cwd ?? "",
	sourceFiles: artifact === undefined ? [] : [artifact.sourceFile],
});

const firstSessionFile = (entry: RawRunEntry): string | undefined => {
	if (entry.sessionFile !== undefined) return entry.sessionFile;
	for (const value of entry.steps ?? []) {
		const decoded = Schema.decodeUnknownResult(RawRunEntry)(value);
		if (Result.isSuccess(decoded) && decoded.success.sessionFile !== undefined) {
			return decoded.success.sessionFile;
		}
	}
	return undefined;
};

const collectEntryCandidates = (
	values: ReadonlyArray<unknown>,
	input: {
		readonly source: string;
		readonly wrapperRunId?: string;
		readonly parentSessionRef?: string;
		readonly inheritedParentRunId?: string;
		readonly fallbackStartedAt: number;
	},
	candidates: Array<RunCandidate>,
): void => {
	for (const value of values) {
		const decoded = Schema.decodeUnknownResult(RawRunEntry)(value);
		if (Result.isFailure(decoded)) continue;
		const entry = decoded.success;
		const runId = entry.runId ?? entry.id;
		const sessionRef = firstSessionFile(entry);
		const explicitParentRunId = entry.parentRunId ?? input.inheritedParentRunId;
		const wrapperParent = entry.parentWorkflowRunId ?? input.wrapperRunId;
		if (runId !== undefined && sessionRef !== undefined) {
			candidates.push({
				runId,
				...(input.wrapperRunId === undefined ? {} : {wrapperRunId: input.wrapperRunId}),
				...(explicitParentRunId === undefined ? {} : {parentRunId: explicitParentRunId}),
				...(explicitParentRunId !== undefined || wrapperParent === undefined
					? {}
					: {parentRunId: wrapperParent}),
				...(input.parentSessionRef === undefined ? {} : {parentSessionRef: input.parentSessionRef}),
				sessionRef,
				observedAt: entry.startedAt ?? input.fallbackStartedAt,
				source: input.source,
			});
		}
		const inheritedParentRunId = runId ?? explicitParentRunId;
		collectEntryCandidates(
			entry.children ?? [],
			{
				...input,
				...(inheritedParentRunId === undefined ? {} : {inheritedParentRunId}),
			},
			candidates,
		);
		collectEntryCandidates(entry.results ?? [], input, candidates);
	}
};

const readRunCandidates = Effect.fn("Lineage.readRunCandidates")(function* (source: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(source);
	const parsed = yield* parseJson(text);
	const status = yield* Schema.decodeUnknownEffect(RawRunStatus)(parsed).pipe(
		Effect.mapError((error) => new LineageSourceParseError({message: messageOf(error)})),
	);
	const candidates: Array<RunCandidate> = [];
	const wrapperRunId = status.runId ?? status.id;
	const parentSessionRef = status.sessionId;
	const base = {
		source,
		...(wrapperRunId === undefined ? {} : {wrapperRunId}),
		...(parentSessionRef === undefined ? {} : {parentSessionRef}),
		fallbackStartedAt: status.startedAt ?? 0,
	};
	collectEntryCandidates(status.steps ?? [], base, candidates);
	collectEntryCandidates(status.results ?? [], base, candidates);
	collectEntryCandidates(status.children ?? [], base, candidates);
	if (status.workflow !== undefined) {
		const workflow = Schema.decodeUnknownResult(RawWorkflow)(status.workflow);
		if (Result.isSuccess(workflow)) {
			collectEntryCandidates(workflow.success.value?.results ?? [], base, candidates);
		}
	}
	return candidates;
});

const scanRuns = Effect.fn("Lineage.scanRuns")(function* (roots: ReadonlyArray<string>) {
	const scanned = yield* scanFiles(roots, (name) => name === "status.json", "retention-loss");
	const candidates: Array<RunCandidate> = [];
	const problems: Array<LineageProblem> = [...scanned.problems];
	for (const source of scanned.files) {
		const run = yield* Effect.result(readRunCandidates(source));
		if (Result.isFailure(run)) {
			problems.push({code: "malformed-run", source, message: messageOf(run.failure)});
		} else candidates.push(...run.success);
	}
	return {candidates, problems};
});

const resolveSession = (
	reference: string,
	byFile: ReadonlyMap<string, SessionIdentity>,
	byId: ReadonlyMap<string, LineageNode>,
	path: typeof Path.Path.Service,
): SessionIdentity | undefined => byFile.get(path.resolve(reference)) ?? byId.get(reference)?.id;

const lineageRecords = (
	current: LineageStoreDocumentType,
	sessionArtifacts: ReadonlyArray<SessionArtifact>,
	protocolSessions: ReadonlyArray<ProtocolSession>,
	candidates: ReadonlyArray<RunCandidate>,
	path: typeof Path.Path.Service,
): Result.Result<
	{readonly records: LineageRecords; readonly problems: ReadonlyArray<LineageProblem>},
	LineageConflictError
> => {
	const artifactsById = new Map(sessionArtifacts.map((artifact) => [artifact.header.id, artifact]));
	let sessionGraph = upsertLineageRecords(emptyLineageStore(), {
		nodes: sessionArtifacts.map(sessionNodeFromArtifact),
		edges: [],
		continuity: [],
	});
	if (Result.isFailure(sessionGraph)) return Result.fail(sessionGraph.failure);
	for (const session of protocolSessions) {
		sessionGraph = upsertLineageRecords(sessionGraph.success, {
			nodes: [sessionNodeFromProtocol(session, artifactsById.get(session.id))],
			edges: [],
			continuity: [],
		});
		if (Result.isFailure(sessionGraph)) return Result.fail(sessionGraph.failure);
	}
	const knownNodes = new Map([
		...current.nodes.map((node) => [node.piSessionId, node] as const),
		...sessionGraph.success.nodes.map((node) => [node.piSessionId, node] as const),
	]);
	const nodesByIdentity = new Map([...knownNodes.values()].map((node) => [node.id, node]));
	const byFile = new Map(
		[...knownNodes.values()].flatMap((node) =>
			node.sourceFiles.map((sourceFile) => [path.resolve(sourceFile), node.id] as const),
		),
	);
	const edges: Array<LineageEdge> = [];
	const problems: Array<LineageProblem> = [];

	const protocolParents = new Map<string, string>();
	for (const session of protocolSessions) {
		if (session.parentSessionId === undefined) continue;
		const existing = protocolParents.get(session.id);
		if (existing !== undefined && existing !== session.parentSessionId) {
			return Result.fail(
				new LineageConflictError({
					recordId: `fork:${sessionIdentity(session.id)}`,
					message: `Session ${session.id} has conflicting protocol parents`,
				}),
			);
		}
		protocolParents.set(session.id, session.parentSessionId);
	}

	for (const artifact of sessionArtifacts) {
		const child = sessionIdentity(artifact.header.id);
		const protocolParentId = protocolParents.get(artifact.header.id);
		const headerParent = artifact.header.parentSessionId ?? artifact.header.parentSession;
		const parent =
			protocolParentId === undefined
				? headerParent === undefined
					? undefined
					: resolveSession(headerParent, byFile, knownNodes, path)
				: knownNodes.get(protocolParentId)?.id;
		if (parent === undefined) {
			if (protocolParentId !== undefined || headerParent !== undefined) {
				problems.push({
					code: "retention-loss",
					source: artifact.sourceFile,
					message: `Fork parent for ${artifact.header.id} is not retained`,
				});
			}
			continue;
		}
		edges.push({
			id: `fork:${child}`,
			kind: "fork",
			parent,
			child,
			source: protocolParentId === undefined ? "header" : "protocol",
		});
	}
	for (const [childId, parentId] of protocolParents) {
		if (artifactsById.has(childId)) continue;
		const child = knownNodes.get(childId)?.id;
		const parent = knownNodes.get(parentId)?.id;
		if (child === undefined || parent === undefined) continue;
		edges.push({id: `fork:${child}`, kind: "fork", parent, child, source: "protocol"});
	}

	const runSessions = new Map<string, SessionIdentity>();
	for (const candidate of candidates) {
		const child = resolveSession(candidate.sessionRef, byFile, knownNodes, path);
		if (child === undefined) {
			problems.push({
				code: "unresolved-session",
				source: candidate.source,
				message: `Run ${candidate.runId} references an unknown session`,
			});
			continue;
		}
		const existing = runSessions.get(candidate.runId);
		if (existing !== undefined && existing !== child) {
			return Result.fail(
				new LineageConflictError({
					recordId: `spawn:${candidate.runId}`,
					message: `Run ${candidate.runId} maps to conflicting sessions`,
				}),
			);
		}
		runSessions.set(candidate.runId, child);
	}
	for (const candidate of candidates) {
		if (candidate.parentSessionRef === undefined || candidate.wrapperRunId === undefined) continue;
		const parent = resolveSession(candidate.parentSessionRef, byFile, knownNodes, path);
		if (parent !== undefined) runSessions.set(candidate.wrapperRunId, parent);
	}

	const candidateByRun = new Map<string, {candidate: RunCandidate; child: SessionIdentity}>();
	for (const candidate of candidates) {
		const child = runSessions.get(candidate.runId);
		if (child === undefined) continue;
		const existing = candidateByRun.get(candidate.runId);
		if (existing === undefined) candidateByRun.set(candidate.runId, {candidate, child});
		else {
			const leftParent = existing.candidate.parentRunId ?? existing.candidate.parentSessionRef;
			const rightParent = candidate.parentRunId ?? candidate.parentSessionRef;
			if (existing.child !== child || leftParent !== rightParent) {
				return Result.fail(
					new LineageConflictError({
						recordId: `spawn:${candidate.runId}`,
						message: `Run ${candidate.runId} has conflicting parentage`,
					}),
				);
			}
		}
	}

	const existingSpawnIds = new Set(
		current.edges.filter((edge) => edge.kind === "spawn").map((edge) => edge.id),
	);
	const origins = new Set(
		current.edges.filter((edge) => edge.kind === "spawn").map((edge) => edge.child),
	);
	const continuity: Array<ContinuityObservation> = [];
	const ordered = [...candidateByRun.values()].sort(
		(left, right) =>
			left.candidate.observedAt - right.candidate.observedAt ||
			left.candidate.runId.localeCompare(right.candidate.runId),
	);
	for (const {candidate, child} of ordered) {
		const spawnId = `spawn:${candidate.runId}`;
		if (existingSpawnIds.has(spawnId)) continue;
		const parent =
			candidate.parentRunId === undefined
				? candidate.parentSessionRef === undefined
					? undefined
					: resolveSession(candidate.parentSessionRef, byFile, knownNodes, path)
				: (runSessions.get(candidate.parentRunId) ??
					(candidate.parentSessionRef === undefined
						? undefined
						: resolveSession(candidate.parentSessionRef, byFile, knownNodes, path)));
		if (origins.has(child) || parent === child) {
			continuity.push({
				id: `resume:${candidate.runId}`,
				runId: candidate.runId,
				session: child,
				observedAt: candidate.observedAt,
			});
			continue;
		}
		if (parent === undefined || !nodesByIdentity.has(parent)) {
			problems.push({
				code: "retention-loss",
				source: candidate.source,
				message: `Spawn parent for run ${candidate.runId} is not retained`,
			});
			continue;
		}
		edges.push({
			id: spawnId,
			kind: "spawn",
			parent,
			child,
			runId: candidate.runId,
			observedAt: candidate.observedAt,
		});
		origins.add(child);
	}

	return Result.succeed({
		records: {
			nodes: sessionGraph.success.nodes,
			edges,
			continuity,
		},
		problems,
	});
};

export const loadLineageStore = Effect.fn("LineageStore.load")(function* (storePath: string) {
	const fs = yield* FileSystem.FileSystem;
	const read = yield* Effect.result(fs.readFileString(storePath));
	if (Result.isFailure(read)) {
		if (read.failure.reason._tag === "NotFound") return emptyLineageStore();
		return yield* new LineageStoreReadError({path: storePath, message: messageOf(read.failure)});
	}
	const text = read.success;
	const parsed = yield* parseJson(text).pipe(
		Effect.mapError(
			(error) => new LineageStoreReadError({path: storePath, message: error.message}),
		),
	);
	const version = yield* Schema.decodeUnknownEffect(Schema.Struct({version: Schema.Number}))(
		parsed,
	).pipe(
		Effect.mapError(
			(error) => new LineageStoreReadError({path: storePath, message: messageOf(error)}),
		),
	);
	if (version.version !== STORE_VERSION) {
		return yield* new LineageStoreVersionError({
			path: storePath,
			found: version.version,
			supported: STORE_VERSION,
		});
	}
	return yield* Schema.decodeUnknownEffect(LineageStoreDocument)(parsed).pipe(
		Effect.mapError(
			(error) => new LineageStoreReadError({path: storePath, message: messageOf(error)}),
		),
	);
});

const writeLineageStore = Effect.fn("LineageStore.write")(function* (
	storePath: string,
	document: LineageStoreDocumentType,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const encoded = yield* Schema.encodeEffect(LineageStoreDocument)(document);
	const text = `${JSON.stringify(encoded, null, 2)}\n`;
	yield* fs.makeDirectory(path.dirname(storePath), {recursive: true});
	const temporaryPath = `${storePath}.tmp`;
	yield* fs.writeFileString(temporaryPath, text);
	yield* fs.rename(temporaryPath, storePath);
});

export const refreshLineage = Effect.fn("Lineage.refresh")(function* (
	options: RefreshLineageOptions,
) {
	const path = yield* Path.Path;
	const current = yield* loadLineageStore(options.storePath);
	const sessions = yield* scanSessions(options.sessionRoots);
	const runs = yield* scanRuns(options.runRoots);
	const protocolSessions = yield* decodeProtocolSessions(options.protocolSessions ?? []);
	const normalized = lineageRecords(
		current,
		sessions.artifacts,
		protocolSessions,
		runs.candidates,
		path,
	);
	if (Result.isFailure(normalized)) return yield* normalized.failure;
	const merged = upsertLineageRecords(current, normalized.success.records);
	if (Result.isFailure(merged)) return yield* merged.failure;
	yield* writeLineageStore(options.storePath, merged.success);
	return {
		graph: merged.success,
		problems: [...sessions.problems, ...runs.problems, ...normalized.success.problems].sort(
			(left, right) =>
				left.source.localeCompare(right.source) || left.code.localeCompare(right.code),
		),
	} satisfies LineageProjection;
});

const tempScope = (
	environment: NodeJS.ProcessEnv = process.env,
	getuid: (() => number) | undefined = process.getuid?.bind(process),
): string => {
	if (getuid !== undefined) return `uid-${getuid()}`;
	const candidate = environment.USERNAME ?? environment.USER ?? environment.LOGNAME ?? "shared";
	const sanitized = candidate
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `user-${sanitized.length === 0 ? "unknown" : sanitized}`;
};

export const defaultLineageOptions = Effect.fn("Lineage.defaultOptions")(function* (
	options: LineageIndexOptions = {},
	environment: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	temporaryDirectory: string = tmpdir(),
) {
	const path = yield* Path.Path;
	const configuredTempRoot = environment.PI_SUBAGENTS_TEMP_ROOT?.trim();
	const tempRoot =
		configuredTempRoot === undefined || configuredTempRoot.length === 0
			? path.join(temporaryDirectory, `pi-subagents-${tempScope(environment)}`)
			: path.resolve(configuredTempRoot);
	return {
		runRoots: options.runRoots ?? [path.join(tempRoot, "async-subagent-runs")],
		sessionRoots: options.sessionRoots ?? [path.join(home, ".pi", "agent", "sessions")],
		storePath: options.storePath ?? path.join(home, ".pi", "agent", "tuval", "lineage.json"),
		...(options.protocolSessions === undefined ? {} : {protocolSessions: options.protocolSessions}),
	} satisfies RefreshLineageOptions;
});

export const LineageIndexLive = (
	options: LineageIndexOptions = {},
): Layer.Layer<LineageIndex, never, FileSystem.FileSystem | Path.Path | PiDiscovery> =>
	Layer.effect(
		LineageIndex,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const discovery = yield* PiDiscovery;
			const resolved = yield* defaultLineageOptions(options);
			return {
				project: Effect.fn("LineageIndex.project")(function* () {
					const protocolSessions = options.protocolSessions ?? (yield* discovery.sessionMetadata());
					return yield* refreshLineage({...resolved, protocolSessions}).pipe(
						Effect.provideService(FileSystem.FileSystem, fs),
						Effect.provideService(Path.Path, path),
						Effect.mapError((error) => new LineageIndexError({message: messageOf(error)})),
					);
				}),
			};
		}),
	);
