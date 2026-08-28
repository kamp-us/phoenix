import {homedir} from "node:os";
import type {SessionMetadata} from "@earendil-works/pi-protocol";
import {Effect, FileSystem, Option, Path, Result, Schema} from "effect";
import type {DiscoveredSession, DiscoveryProblem} from "../shared/discovery.js";
import {sessionIdentity} from "../shared/discovery.js";

interface SessionHeader {
	readonly type: "session";
	readonly id: string;
	readonly timestamp?: string;
	readonly cwd: string;
	readonly parentSession?: string;
	readonly parentSessionId?: string;
}

export interface PiHomeScan {
	readonly sessions: ReadonlyArray<DiscoveredSession>;
	readonly problems: ReadonlyArray<DiscoveryProblem>;
}

class PiHomeReadError extends Schema.TaggedErrorClass<PiHomeReadError>()("tuval/PiHomeReadError", {
	message: Schema.String,
}) {}

const sessionIdFromFilename = (path: string): string | undefined => {
	const match = /_([^/]+)\.jsonl$/.exec(path);
	return match?.[1];
};

const isHeader = (value: unknown): value is SessionHeader => {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.type === "session" &&
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		typeof candidate.cwd === "string" &&
		(candidate.timestamp === undefined || typeof candidate.timestamp === "string") &&
		(candidate.parentSession === undefined || typeof candidate.parentSession === "string") &&
		(candidate.parentSessionId === undefined || typeof candidate.parentSessionId === "string")
	);
};

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const problem = (source: string, error: unknown): DiscoveryProblem => ({
	source,
	message: messageOf(error),
});

const sessionFilesIn = Effect.fn("PiHome.sessionFilesIn")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const entries = yield* fs.readDirectory(root);
	const files: Array<string> = [];
	for (const name of entries) {
		const entryPath = path.join(root, name);
		if (yield* Effect.isSuccess(fs.readLink(entryPath))) continue;
		const info = yield* Effect.result(fs.stat(entryPath));
		if (Result.isSuccess(info) && info.success.type === "File" && name.endsWith(".jsonl")) {
			files.push(entryPath);
			continue;
		}
		if (Result.isSuccess(info) && info.success.type !== "Directory") continue;
		const children = yield* Effect.result(fs.readDirectory(entryPath));
		if (Result.isFailure(children)) {
			files.push(entryPath);
			continue;
		}
		for (const child of children.success) {
			if (!child.endsWith(".jsonl")) continue;
			const childPath = path.join(entryPath, child);
			if (yield* Effect.isSuccess(fs.readLink(childPath))) continue;
			const childInfo = yield* Effect.result(fs.stat(childPath));
			if (Result.isFailure(childInfo) || childInfo.success.type === "File") files.push(childPath);
		}
	}
	return files;
});

const readFirstLine = Effect.fn("PiHome.readFirstLine")(function* (sessionPath: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const file = yield* fs.open(sessionPath, {flag: "r"});
			const bytes = Option.getOrElse(yield* file.readAlloc(64 * 1024), () => new Uint8Array());
			const text = new TextDecoder().decode(bytes);
			const newline = text.indexOf("\n");
			return newline === -1 ? text : text.slice(0, newline);
		}),
	);
});

const readSession = Effect.fn("PiHome.readSession")(function* (sessionPath: string) {
	const fs = yield* FileSystem.FileSystem;
	const filenameId = sessionIdFromFilename(sessionPath);
	if (filenameId === undefined || filenameId.length === 0) {
		return yield* new PiHomeReadError({
			message: "session filename does not end in _<session-id>.jsonl",
		});
	}
	const firstLine = yield* readFirstLine(sessionPath);
	const parsed = yield* Effect.try({
		try: () => JSON.parse(firstLine) as unknown,
		catch: () => new PiHomeReadError({message: "session header is not valid JSON"}),
	});
	if (!isHeader(parsed)) {
		return yield* new PiHomeReadError({message: "session header is missing type, id, or cwd"});
	}
	const fileInfo = yield* fs.stat(sessionPath);
	const headerTime = parsed.timestamp === undefined ? Number.NaN : Date.parse(parsed.timestamp);
	const birthtime = Option.getOrElse(fileInfo.birthtime, () => new Date(0)).getTime();
	const mtime = Option.getOrElse(fileInfo.mtime, () => new Date(0)).getTime();
	const createdAt = Number.isFinite(headerTime) ? headerTime : birthtime;
	const parentSessionId =
		parsed.parentSessionId ??
		(parsed.parentSession === undefined ? undefined : sessionIdFromFilename(parsed.parentSession));
	return {
		identity: sessionIdentity(filenameId),
		piSessionId: filenameId,
		createdAt: Math.floor(createdAt),
		updatedAt: Math.floor(mtime),
		cwd: parsed.cwd,
		...(parentSessionId === undefined ? {} : {parentSessionId}),
		sourceFile: sessionPath,
	} satisfies DiscoveredSession;
});

export const defaultSessionRoots = Effect.fn("PiHome.defaultSessionRoots")(function* (
	environment: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
) {
	const path = yield* Path.Path;
	const direct = environment.PI_CODING_AGENT_SESSION_DIR;
	if (direct !== undefined && direct.length > 0) return [direct];
	const agent = environment.PI_CODING_AGENT_DIR;
	return [
		path.join(
			agent !== undefined && agent.length > 0 ? agent : path.join(home, ".pi", "agent"),
			"sessions",
		),
	];
});

export const scanPiHomes = Effect.fn("PiHome.scan")(function* (roots: ReadonlyArray<string>) {
	const sessions: Array<DiscoveredSession> = [];
	const problems: Array<DiscoveryProblem> = [];
	for (const root of roots) {
		const files = yield* Effect.result(sessionFilesIn(root));
		if (Result.isFailure(files)) {
			if (files.failure.reason._tag !== "NotFound") problems.push(problem(root, files.failure));
			continue;
		}
		for (const file of files.success) {
			const session = yield* Effect.result(readSession(file));
			if (Result.isFailure(session)) problems.push(problem(file, session.failure));
			else sessions.push(session.success);
		}
	}
	const byIdentity = new Map(sessions.map((session) => [session.identity, session]));
	return {
		sessions: [...byIdentity.values()].sort((left, right) =>
			left.identity.localeCompare(right.identity),
		),
		problems,
	} satisfies PiHomeScan;
});

export const toSessionMetadata = (session: DiscoveredSession): SessionMetadata => ({
	id: session.piSessionId,
	createdAt: session.createdAt,
	updatedAt: session.updatedAt,
	cwd: session.cwd,
	...(session.parentSessionId === undefined ? {} : {parentSessionId: session.parentSessionId}),
});
