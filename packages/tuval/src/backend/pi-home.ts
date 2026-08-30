import {homedir} from "node:os";
import type {SessionMetadata} from "@earendil-works/pi-protocol";
import {Effect, FileSystem, Option, Path, Result, Schema} from "effect";
import type {DiscoveredSession, DiscoveryProblem} from "../shared/discovery.js";
import {sessionIdentity} from "../shared/discovery.js";
import {indexSessionFiles} from "./session-file-index.js";

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

export const sessionIdFromFilename = (sourcePath: string): string | undefined => {
	const filename = sourcePath.split(/[\\/]/).at(-1);
	if (filename === undefined) return undefined;
	const match = /_([^\\/]+)\.jsonl$/.exec(filename);
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

const sessionFilesIn = Effect.fn("PiHome.sessionFilesIn")((root: string) =>
	Effect.tryPromise({
		try: () => indexSessionFiles(root),
		catch: (error) => new PiHomeReadError({message: messageOf(error)}),
	}),
);

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
	const firstLine = yield* readFirstLine(sessionPath);
	const parsed = yield* Effect.try({
		try: () => JSON.parse(firstLine) as unknown,
		catch: () => new PiHomeReadError({message: "session header is not valid JSON"}),
	});
	if (!isHeader(parsed)) {
		return yield* new PiHomeReadError({message: "session header is missing type, id, or cwd"});
	}
	const filename = sessionPath.split(/[\\/]/).at(-1);
	const sessionId = filenameId ?? (filename === "session.jsonl" ? parsed.id : undefined);
	if (sessionId === undefined || sessionId.length === 0) {
		return yield* new PiHomeReadError({
			message: "session filename does not end in _<session-id>.jsonl",
		});
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
		identity: sessionIdentity(sessionId),
		piSessionId: sessionId,
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
		const indexed = yield* Effect.result(sessionFilesIn(root));
		if (Result.isFailure(indexed)) {
			problems.push(problem(root, indexed.failure));
			continue;
		}
		problems.push(...indexed.success.problems);
		for (const file of indexed.success.files) {
			const session = yield* Effect.result(readSession(file));
			if (Result.isFailure(session)) problems.push(problem(file, session.failure));
			else sessions.push(session.success);
		}
	}
	const byIdentity = new Map<DiscoveredSession["identity"], DiscoveredSession>();
	for (const session of sessions) {
		const existing = byIdentity.get(session.identity);
		if (
			existing === undefined ||
			session.updatedAt > existing.updatedAt ||
			(session.updatedAt === existing.updatedAt &&
				session.sourceFile.localeCompare(existing.sourceFile) < 0)
		) {
			byIdentity.set(session.identity, session);
		}
	}
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
