import {homedir, tmpdir, userInfo} from "node:os";
import {
	Context,
	Crypto,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Result,
	Schema,
	Semaphore,
} from "effect";
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
	validateLineageStore,
} from "../shared/lineage.js";
import {PiDiscovery, type PiSessionMetadataOutcome} from "./pi-discovery.js";
import {defaultSessionRoots, sessionIdFromFilename} from "./pi-home.js";

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
	parentRunId: Schema.optionalKey(Schema.String),
	parentWorkflowRunId: Schema.optionalKey(Schema.String),
	sessionId: Schema.optionalKey(Schema.String),
	sessionFile: Schema.optionalKey(Schema.String),
	startedAt: Schema.optionalKey(Schema.Number),
	steps: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	results: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	children: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	workflow: Schema.optionalKey(Schema.Unknown),
});

interface SessionArtifact {
	readonly header: SessionHeader;
	readonly sessionId: string;
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

interface RunObservation {
	readonly runId: string;
	readonly child: SessionIdentity;
	readonly observedAt: number;
	readonly parent?: SessionIdentity;
	readonly source: string;
}

type AuthoritativeParentReference =
	| {readonly _tag: "ParentRun"; readonly value: string}
	| {readonly _tag: "ParentSession"; readonly value: string}
	| {readonly _tag: "Parentless"};

const authoritativeParentReference = (candidate: RunCandidate): AuthoritativeParentReference =>
	candidate.parentRunId !== undefined
		? {_tag: "ParentRun", value: candidate.parentRunId}
		: candidate.parentSessionRef !== undefined
			? {_tag: "ParentSession", value: candidate.parentSessionRef}
			: {_tag: "Parentless"};

const sameAuthoritativeParent = (
	left: AuthoritativeParentReference,
	right: AuthoritativeParentReference,
): boolean => {
	if (left._tag === "Parentless") return right._tag === "Parentless";
	return right._tag === left._tag && right.value === left.value;
};

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
	readonly protocolMetadata?: PiSessionMetadataOutcome;
}

export interface LineageIndexOptions {
	readonly runRoots?: ReadonlyArray<string>;
	readonly sessionRoots?: ReadonlyArray<string>;
	readonly storePath?: string;
	readonly protocolMetadata?: PiSessionMetadataOutcome;
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
	lifecycleSessionFiles: ReadonlySet<string>,
) {
	const path = yield* Path.Path;
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
	const filenameSessionId = sessionIdFromFilename(sourceFile);
	const lifecycleOwned = lifecycleSessionFiles.has(path.resolve(sourceFile));
	const sessionId =
		filenameSessionId ??
		(path.basename(sourceFile) === "session.jsonl" && lifecycleOwned ? header.id : undefined);
	if (sessionId === undefined || sessionId.length === 0) {
		return yield* new LineageSourceParseError({
			message:
				path.basename(sourceFile) === "session.jsonl"
					? "generic session.jsonl has no matching lifecycle observation"
					: "session filename does not end in _<session-id>.jsonl",
		});
	}
	const info = yield* fs.stat(sourceFile);
	const updatedAt = Option.getOrElse(info.mtime, () => new Date(0)).getTime();
	return Option.some({header, sessionId, sourceFile, updatedAt} satisfies SessionArtifact);
});

const scanSessions = Effect.fn("Lineage.scanSessions")(function* (
	roots: ReadonlyArray<string>,
	lifecycleSessionFiles: ReadonlySet<string>,
) {
	const scanned = yield* scanFiles(roots, (name) => name.endsWith(".jsonl"), "retention-loss");
	const artifacts: Array<SessionArtifact> = [];
	const problems: Array<LineageProblem> = [...scanned.problems];
	for (const sourceFile of scanned.files) {
		const artifact = yield* Effect.result(readSessionArtifact(sourceFile, lifecycleSessionFiles));
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
		id: sessionIdentity(artifact.sessionId),
		piSessionId: artifact.sessionId,
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

const firstSessionFile = (entry: RawRunEntry): string | undefined => entry.sessionFile;

const hasRunEntryContent = (entry: RawRunEntry): boolean =>
	entry.id !== undefined ||
	entry.runId !== undefined ||
	entry.parentRunId !== undefined ||
	entry.parentWorkflowRunId !== undefined ||
	entry.sessionFile !== undefined ||
	(entry.children?.length ?? 0) > 0 ||
	(entry.steps?.length ?? 0) > 0 ||
	(entry.results?.length ?? 0) > 0;

const emptyIdentityField = (
	fields: ReadonlyArray<readonly [string, string | undefined]>,
): string | undefined =>
	fields.find(([, value]) => value !== undefined && value.trim().length === 0)?.[0];

const malformedRunProblem = (source: string, message: string): LineageProblem => ({
	code: "malformed-run",
	source,
	message,
});

const collectEntryCandidates = (
	values: ReadonlyArray<unknown>,
	input: {
		readonly source: string;
		readonly location: string;
		readonly wrapperRunId?: string;
		readonly parentSessionRef?: string;
		readonly inheritedParentRunId?: string;
		readonly fallbackStartedAt: number;
		readonly statusSessionEntries: ReadonlySet<unknown>;
	},
	candidates: Array<RunCandidate>,
	problems: Array<LineageProblem>,
): void => {
	for (const [index, value] of values.entries()) {
		const location = `${input.location}[${index}]`;
		const source = `${input.source}#${location}`;
		const decoded = Schema.decodeUnknownResult(RawRunEntry)(value);
		if (Result.isFailure(decoded)) {
			problems.push(
				malformedRunProblem(source, `run entry is invalid: ${messageOf(decoded.failure)}`),
			);
			continue;
		}
		const entry = decoded.success;
		if (!hasRunEntryContent(entry)) {
			problems.push(malformedRunProblem(source, "run entry is empty"));
			continue;
		}
		const emptyField = emptyIdentityField([
			["id", entry.id],
			["runId", entry.runId],
			["parentRunId", entry.parentRunId],
			["parentWorkflowRunId", entry.parentWorkflowRunId],
			["sessionFile", entry.sessionFile],
		]);
		const runId = entry.runId ?? entry.id;
		const sessionRef = firstSessionFile(entry);
		const nestedValues = [
			["steps", entry.steps ?? []],
			["children", entry.children ?? []],
			["results", entry.results ?? []],
		] as const;
		const hasNested = nestedValues.some(([, nested]) => nested.length > 0);
		let usable = true;
		if (emptyField !== undefined) {
			problems.push(malformedRunProblem(source, `run entry has an empty ${emptyField}`));
			usable = false;
		}
		if (runId === undefined && sessionRef !== undefined && !input.statusSessionEntries.has(value)) {
			problems.push(malformedRunProblem(source, "run entry has a session file without a run id"));
			usable = false;
		}
		if (runId !== undefined && sessionRef === undefined && !hasNested) {
			problems.push(malformedRunProblem(source, "run entry has a run id without a session file"));
			usable = false;
		}
		const explicitParentRunId = entry.parentRunId ?? input.inheritedParentRunId;
		const wrapperParent = entry.parentWorkflowRunId ?? input.wrapperRunId;
		if (usable && runId !== undefined && sessionRef !== undefined) {
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
		const inheritedParentRunId = usable ? (runId ?? explicitParentRunId) : explicitParentRunId;
		for (const [name, nested] of nestedValues) {
			collectEntryCandidates(
				nested,
				{
					...input,
					location: `${location}.${name}`,
					...(inheritedParentRunId === undefined ? {} : {inheritedParentRunId}),
				},
				candidates,
				problems,
			);
		}
	}
};

const statusSessionFile = (
	status: (typeof RawRunStatus)["Type"],
): Result.Result<
	{readonly sessionFile: string | undefined; readonly claimedEntries: ReadonlySet<unknown>},
	LineageSourceParseError
> => {
	const matches: Array<readonly [unknown, string]> = [];
	for (const value of status.steps ?? []) {
		const decoded = Schema.decodeUnknownResult(RawRunEntry)(value);
		if (Result.isFailure(decoded)) continue;
		const entry = decoded.success;
		if (entry.runId === undefined && entry.id === undefined && entry.sessionFile !== undefined) {
			matches.push([value, entry.sessionFile]);
		}
	}
	const claimedEntries = new Set(matches.map(([value]) => value));
	if (status.sessionFile !== undefined) {
		return Result.succeed({sessionFile: status.sessionFile, claimedEntries});
	}
	const files = [...new Set(matches.map(([, file]) => file))];
	return Result.succeed({
		sessionFile: files.length === 1 ? files[0] : undefined,
		claimedEntries,
	});
};

const readRunCandidates = Effect.fn("Lineage.readRunCandidates")(function* (source: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(source);
	const parsed = yield* parseJson(text);
	const status = yield* Schema.decodeUnknownEffect(RawRunStatus)(parsed).pipe(
		Effect.mapError((error) => new LineageSourceParseError({message: messageOf(error)})),
	);
	const candidates: Array<RunCandidate> = [];
	const problems: Array<LineageProblem> = [];
	const emptyField = emptyIdentityField([
		["id", status.id],
		["runId", status.runId],
		["parentRunId", status.parentRunId],
		["parentWorkflowRunId", status.parentWorkflowRunId],
		["sessionId", status.sessionId],
		["sessionFile", status.sessionFile],
	]);
	const topLevelUsable = emptyField === undefined;
	if (emptyField !== undefined) {
		problems.push(malformedRunProblem(`${source}#status`, `run status has an empty ${emptyField}`));
	}
	const wrapperRunId = topLevelUsable ? (status.runId ?? status.id) : undefined;
	const parentSessionRef = topLevelUsable ? status.sessionId : undefined;
	const nestedValues = [
		["steps", status.steps ?? []],
		["results", status.results ?? []],
		["children", status.children ?? []],
	] as const;
	const statusSession = statusSessionFile(status);
	if (Result.isFailure(statusSession)) return yield* statusSession.failure;
	if (statusSession.success.sessionFile?.trim().length === 0) {
		problems.push(
			malformedRunProblem(`${source}#status`, "run status has an empty step sessionFile"),
		);
	}
	if (
		topLevelUsable &&
		wrapperRunId !== undefined &&
		statusSession.success.sessionFile !== undefined &&
		statusSession.success.sessionFile.trim().length > 0
	) {
		candidates.push({
			runId: wrapperRunId,
			...(status.parentRunId === undefined ? {} : {parentRunId: status.parentRunId}),
			...(status.parentRunId !== undefined || status.parentWorkflowRunId === undefined
				? {}
				: {parentRunId: status.parentWorkflowRunId}),
			...(parentSessionRef === undefined ? {} : {parentSessionRef}),
			sessionRef: statusSession.success.sessionFile,
			observedAt: status.startedAt ?? 0,
			source,
		});
	}
	const base = {
		source,
		location: "status",
		...(wrapperRunId === undefined ? {} : {wrapperRunId}),
		...(parentSessionRef === undefined ? {} : {parentSessionRef}),
		fallbackStartedAt: status.startedAt ?? 0,
		statusSessionEntries: statusSession.success.claimedEntries,
	};
	for (const [name, values] of nestedValues) {
		collectEntryCandidates(values, {...base, location: `status.${name}`}, candidates, problems);
	}
	if (candidates.length === 0 && problems.length === 0) {
		problems.push(
			malformedRunProblem(`${source}#status`, "run status contains no complete identity"),
		);
	}
	return {candidates, problems};
});

const scanRuns = Effect.fn("Lineage.scanRuns")(function* (roots: ReadonlyArray<string>) {
	const scanned = yield* scanFiles(roots, (name) => name === "status.json", "retention-loss");
	const candidates: Array<RunCandidate> = [];
	const problems: Array<LineageProblem> = [...scanned.problems];
	for (const source of scanned.files) {
		const run = yield* Effect.result(readRunCandidates(source));
		if (Result.isFailure(run)) {
			problems.push(malformedRunProblem(source, messageOf(run.failure)));
		} else {
			candidates.push(...run.success.candidates);
			problems.push(...run.success.problems);
		}
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
	{
		readonly base: LineageStoreDocumentType;
		readonly records: LineageRecords;
		readonly problems: ReadonlyArray<LineageProblem>;
	},
	LineageConflictError
> => {
	const artifactsById = new Map(sessionArtifacts.map((artifact) => [artifact.sessionId, artifact]));
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
		const child = sessionIdentity(artifact.sessionId);
		const protocolParentId = protocolParents.get(artifact.sessionId);
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
					message: `Fork parent for ${artifact.sessionId} is not retained`,
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
		if (child === undefined) continue;
		if (parent === undefined) {
			problems.push({
				code: "retention-loss",
				source: `protocol:${childId}`,
				message: `Fork parent for ${childId} is not retained`,
			});
			continue;
		}
		edges.push({id: `fork:${child}`, kind: "fork", parent, child, source: "protocol"});
	}

	const currentByRun = new Map<string, RunObservation>();
	for (const edge of current.edges) {
		if (edge.kind !== "spawn") continue;
		currentByRun.set(edge.runId, {
			runId: edge.runId,
			child: edge.child,
			parent: edge.parent,
			observedAt: edge.observedAt,
			source: "retained lineage store",
		});
	}
	for (const observation of current.continuity) {
		currentByRun.set(observation.runId, {
			runId: observation.runId,
			child: observation.session,
			...(observation.parent === undefined ? {} : {parent: observation.parent}),
			observedAt: observation.observedAt,
			source: "retained lineage store",
		});
	}

	const parentReferences = new Map<string, AuthoritativeParentReference>();
	for (const candidate of candidates) {
		const reference = authoritativeParentReference(candidate);
		const existing = parentReferences.get(candidate.runId);
		if (existing !== undefined && !sameAuthoritativeParent(existing, reference)) {
			return Result.fail(
				new LineageConflictError({
					recordId: `spawn:${candidate.runId}`,
					message: `Run ${candidate.runId} has conflicting authoritative parent references`,
				}),
			);
		}
		parentReferences.set(candidate.runId, reference);
	}

	const runSessions = new Map<string, SessionIdentity>();
	for (const candidate of candidates) {
		const child = resolveSession(candidate.sessionRef, byFile, knownNodes, path);
		if (child === undefined) {
			if (currentByRun.has(candidate.runId)) {
				return Result.fail(
					new LineageConflictError({
						recordId: `spawn:${candidate.runId}`,
						message: `Persisted run ${candidate.runId} was rewritten to an unresolved session`,
					}),
				);
			}
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

	const candidateByRun = new Map<string, RunObservation>();
	for (const candidate of candidates) {
		const child = runSessions.get(candidate.runId);
		if (child === undefined) continue;
		let parent: SessionIdentity | undefined;
		if (candidate.parentRunId !== undefined) {
			parent = runSessions.get(candidate.parentRunId);
			if (parent === undefined) {
				if (currentByRun.has(candidate.runId)) {
					return Result.fail(
						new LineageConflictError({
							recordId: `spawn:${candidate.runId}`,
							message: `Persisted run ${candidate.runId} was rewritten with unresolved authoritative parent ${candidate.parentRunId}`,
						}),
					);
				}
				problems.push({
					code: "retention-loss",
					source: candidate.source,
					message: `Authoritative parent run ${candidate.parentRunId} for ${candidate.runId} is not retained`,
				});
				continue;
			}
		} else if (candidate.parentSessionRef !== undefined) {
			parent = resolveSession(candidate.parentSessionRef, byFile, knownNodes, path);
			if (parent === undefined) {
				if (currentByRun.has(candidate.runId)) {
					return Result.fail(
						new LineageConflictError({
							recordId: `spawn:${candidate.runId}`,
							message: `Persisted run ${candidate.runId} was rewritten with unresolved authoritative parent ${candidate.parentSessionRef}`,
						}),
					);
				}
				problems.push({
					code: "retention-loss",
					source: candidate.source,
					message: `Authoritative parent session ${candidate.parentSessionRef} for ${candidate.runId} is not retained`,
				});
				continue;
			}
		}
		const observation: RunObservation = {
			runId: candidate.runId,
			child,
			observedAt: candidate.observedAt,
			...(parent === undefined ? {} : {parent}),
			source: candidate.source,
		};
		const existing = candidateByRun.get(candidate.runId);
		if (
			existing !== undefined &&
			(existing.child !== observation.child ||
				existing.parent !== observation.parent ||
				existing.observedAt !== observation.observedAt)
		) {
			return Result.fail(
				new LineageConflictError({
					recordId: `spawn:${candidate.runId}`,
					message: `Run ${candidate.runId} has conflicting observations`,
				}),
			);
		}
		candidateByRun.set(candidate.runId, observation);
	}

	for (const [runId, observation] of candidateByRun) {
		const persisted = currentByRun.get(runId);
		if (
			persisted !== undefined &&
			(persisted.child !== observation.child ||
				persisted.observedAt !== observation.observedAt ||
				persisted.parent !== observation.parent)
		) {
			return Result.fail(
				new LineageConflictError({
					recordId: `spawn:${runId}`,
					message: `Persisted run ${runId} conflicts with its source observation`,
				}),
			);
		}
	}

	const touchedSessions = new Set([...candidateByRun.values()].map((value) => value.child));
	const observationsBySession = new Map<SessionIdentity, Array<RunObservation>>();
	for (const observation of [...currentByRun.values(), ...candidateByRun.values()]) {
		if (!touchedSessions.has(observation.child)) continue;
		const bucket = observationsBySession.get(observation.child) ?? [];
		if (!bucket.some((value) => value.runId === observation.runId)) bucket.push(observation);
		observationsBySession.set(observation.child, bucket);
	}
	const continuity: Array<ContinuityObservation> = [];
	for (const [child, observations] of observationsBySession) {
		const ordered = observations.sort(
			(left, right) => left.observedAt - right.observedAt || left.runId.localeCompare(right.runId),
		);
		const originIndex = ordered.findIndex(
			(observation) =>
				observation.parent !== undefined &&
				observation.parent !== child &&
				nodesByIdentity.has(observation.parent),
		);
		if (originIndex === -1) {
			for (const observation of ordered.filter((value) => value.parent === undefined)) {
				if (!problems.some((problem) => problem.source === observation.source)) {
					problems.push({
						code: "retention-loss",
						source: observation.source,
						message: `Spawn parent for run ${observation.runId} is not retained`,
					});
				}
			}
			continue;
		}
		const origin = ordered[originIndex] as RunObservation;
		for (const observation of ordered.slice(0, originIndex)) {
			if (!problems.some((problem) => problem.source === observation.source)) {
				problems.push({
					code: "retention-loss",
					source: observation.source,
					message: `Spawn parent for pre-origin run ${observation.runId} is not retained`,
				});
			}
		}
		edges.push({
			id: `spawn:${origin.runId}`,
			kind: "spawn",
			parent: origin.parent as SessionIdentity,
			child,
			runId: origin.runId,
			observedAt: origin.observedAt,
		});
		for (const observation of ordered.slice(originIndex + 1)) {
			continuity.push({
				id: `resume:${observation.runId}`,
				runId: observation.runId,
				session: child,
				...(observation.parent === undefined ? {} : {parent: observation.parent}),
				observedAt: observation.observedAt,
			});
		}
	}
	const base = {
		...current,
		edges: current.edges.filter(
			(edge) => edge.kind !== "spawn" || !touchedSessions.has(edge.child),
		),
		continuity: current.continuity.filter(
			(observation) => !touchedSessions.has(observation.session),
		),
	};

	return Result.succeed({
		base,
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
	const decoded = yield* Schema.decodeUnknownEffect(LineageStoreDocument)(parsed).pipe(
		Effect.mapError(
			(error) => new LineageStoreReadError({path: storePath, message: messageOf(error)}),
		),
	);
	const validated = validateLineageStore(decoded);
	if (Result.isFailure(validated)) return yield* validated.failure;
	return validated.success;
});

const writeLineageStore = Effect.fn("LineageStore.write")(function* (
	storePath: string,
	document: LineageStoreDocumentType,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const encoded = yield* Schema.encodeEffect(LineageStoreDocument)(document);
	const text = `${JSON.stringify(encoded, null, 2)}\n`;
	yield* fs.makeDirectory(path.dirname(storePath), {recursive: true});
	const temporaryPath = `${storePath}.${yield* crypto.randomUUIDv4}.tmp`;
	yield* fs.writeFileString(temporaryPath, text);
	yield* fs
		.rename(temporaryPath, storePath)
		.pipe(Effect.ensuring(fs.remove(temporaryPath).pipe(Effect.ignore)));
});

const storeLocks = new Map<string, Semaphore.Semaphore>();
const storeLock = (storePath: string): Semaphore.Semaphore => {
	const existing = storeLocks.get(storePath);
	if (existing !== undefined) return existing;
	const created = Semaphore.makeUnsafe(1);
	storeLocks.set(storePath, created);
	return created;
};

const refreshLineageUnlocked = Effect.fn("Lineage.refreshUnlocked")(function* (
	options: RefreshLineageOptions,
) {
	const path = yield* Path.Path;
	const current = yield* loadLineageStore(options.storePath);
	const runs = yield* scanRuns(options.runRoots);
	const lifecycleSessionFiles = new Set(
		runs.candidates.map((candidate) => path.resolve(candidate.sessionRef)),
	);
	const sessions = yield* scanSessions(options.sessionRoots, lifecycleSessionFiles);
	const protocolMetadata = options.protocolMetadata ?? {_tag: "not-configured" as const};
	const protocolSessions = yield* decodeProtocolSessions(
		protocolMetadata._tag === "available" ? protocolMetadata.sessions : [],
	);
	const protocolProblems: ReadonlyArray<LineageProblem> =
		protocolMetadata._tag === "failed"
			? [
					{
						code: "protocol-unavailable",
						source: "pi-protocol",
						message: protocolMetadata.message,
					},
				]
			: [];
	const normalized = lineageRecords(
		current,
		sessions.artifacts,
		protocolSessions,
		runs.candidates,
		path,
	);
	if (Result.isFailure(normalized)) return yield* normalized.failure;
	const merged = upsertLineageRecords(normalized.success.base, normalized.success.records);
	if (Result.isFailure(merged)) return yield* merged.failure;
	const validated = validateLineageStore(merged.success);
	if (Result.isFailure(validated)) return yield* validated.failure;
	yield* writeLineageStore(options.storePath, validated.success);
	return {
		graph: validated.success,
		problems: [
			...sessions.problems,
			...runs.problems,
			...protocolProblems,
			...normalized.success.problems,
		].sort(
			(left, right) =>
				left.source.localeCompare(right.source) || left.code.localeCompare(right.code),
		),
	} satisfies LineageProjection;
});

export const refreshLineage = Effect.fn("Lineage.refresh")(function* (
	options: RefreshLineageOptions,
) {
	const path = yield* Path.Path;
	return yield* storeLock(path.resolve(options.storePath)).withPermit(
		refreshLineageUnlocked(options),
	);
});

const sanitizeTempScopeSegment = (value: string): string => {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
};

export const resolvePiSubagentsTempScopeId = (options?: {
	readonly env?: NodeJS.ProcessEnv;
	readonly getuid?: (() => number) | undefined;
	readonly userInfo?: (() => {readonly username?: string | null}) | undefined;
	readonly homedir?: (() => string) | undefined;
}): string => {
	const environment = options?.env ?? process.env;
	const getuid =
		options !== undefined && Object.hasOwn(options, "getuid")
			? options.getuid
			: process.getuid?.bind(process);
	if (typeof getuid === "function") return `uid-${getuid()}`;

	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = environment[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}

	const readUserInfo =
		options !== undefined && Object.hasOwn(options, "userInfo") ? options.userInfo : userInfo;
	const resolvedUser = Result.try({try: () => readUserInfo?.(), catch: () => undefined});
	if (Result.isSuccess(resolvedUser)) {
		const username = resolvedUser.success?.username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	}

	const configuredHome = environment.USERPROFILE ?? environment.HOME;
	if (configuredHome) return `home-${sanitizeTempScopeSegment(configuredHome)}`;

	const readHomedir =
		options !== undefined && Object.hasOwn(options, "homedir") ? options.homedir : homedir;
	const resolvedHome = Result.try({try: () => readHomedir?.(), catch: () => undefined});
	if (Result.isSuccess(resolvedHome) && resolvedHome.success) {
		return `home-${sanitizeTempScopeSegment(resolvedHome.success)}`;
	}
	return "shared";
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
			? path.join(
					temporaryDirectory,
					`pi-subagents-${resolvePiSubagentsTempScopeId({env: environment})}`,
				)
			: path.resolve(configuredTempRoot);
	return {
		runRoots: options.runRoots ?? [
			path.join(tempRoot, "async-subagent-runs"),
			path.join(tempRoot, "nested-subagent-runs"),
		],
		sessionRoots: options.sessionRoots ?? (yield* defaultSessionRoots(environment, home)),
		storePath: options.storePath ?? path.join(home, ".pi", "agent", "tuval", "lineage.json"),
		...(options.protocolMetadata === undefined ? {} : {protocolMetadata: options.protocolMetadata}),
	} satisfies RefreshLineageOptions;
});

export const LineageIndexLive = (
	options: LineageIndexOptions = {},
): Layer.Layer<
	LineageIndex,
	never,
	Crypto.Crypto | FileSystem.FileSystem | Path.Path | PiDiscovery
> =>
	Layer.effect(
		LineageIndex,
		Effect.gen(function* () {
			const crypto = yield* Crypto.Crypto;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const discovery = yield* PiDiscovery;
			const resolved = yield* defaultLineageOptions(options);
			return {
				project: Effect.fn("LineageIndex.project")(function* () {
					const protocolMetadata = options.protocolMetadata ?? (yield* discovery.sessionMetadata());
					return yield* refreshLineage({...resolved, protocolMetadata}).pipe(
						Effect.provideService(Crypto.Crypto, crypto),
						Effect.provideService(FileSystem.FileSystem, fs),
						Effect.provideService(Path.Path, path),
						Effect.mapError((error) => new LineageIndexError({message: messageOf(error)})),
					);
				}),
			};
		}),
	);
