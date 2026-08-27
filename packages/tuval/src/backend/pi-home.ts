import {open, readdir, stat} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import type {SessionMetadata} from "@earendil-works/pi-protocol";
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

const readFirstLine = async (path: string): Promise<string> => {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const {bytesRead} = await handle.read(buffer, 0, buffer.byteLength, 0);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const newline = text.indexOf("\n");
		return newline === -1 ? text : text.slice(0, newline);
	} finally {
		await handle.close();
	}
};

const sessionFilesIn = async (root: string): Promise<ReadonlyArray<string>> => {
	const entries = await readdir(root, {withFileTypes: true});
	const files: Array<string> = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(path);
			continue;
		}
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		try {
			const children = await readdir(path, {withFileTypes: true});
			for (const child of children) {
				if (child.isFile() && child.name.endsWith(".jsonl")) {
					files.push(join(path, child.name));
				}
			}
		} catch {
			files.push(path);
		}
	}
	return files;
};

const problem = (source: string, error: unknown): DiscoveryProblem => ({
	source,
	message: error instanceof Error ? error.message : String(error),
});

const readSession = async (path: string): Promise<DiscoveredSession> => {
	const filenameId = sessionIdFromFilename(path);
	if (filenameId === undefined || filenameId.length === 0) {
		throw new Error("session filename does not end in _<session-id>.jsonl");
	}
	const line = await readFirstLine(path);
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error("session header is not valid JSON");
	}
	if (!isHeader(parsed)) {
		throw new Error("session header is missing type, id, or cwd");
	}
	const fileStat = await stat(path);
	const headerTime = parsed.timestamp === undefined ? Number.NaN : Date.parse(parsed.timestamp);
	const createdAt = Number.isFinite(headerTime) ? headerTime : fileStat.birthtimeMs;
	const parentSessionId =
		parsed.parentSessionId ??
		(parsed.parentSession === undefined ? undefined : sessionIdFromFilename(parsed.parentSession));
	return {
		identity: sessionIdentity(filenameId),
		piSessionId: filenameId,
		createdAt: Math.floor(createdAt),
		updatedAt: Math.floor(fileStat.mtimeMs),
		cwd: parsed.cwd,
		...(parentSessionId === undefined ? {} : {parentSessionId}),
		sourceFile: path,
	};
};

export const defaultSessionRoots = (
	environment: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<string> => {
	const direct = environment.PI_CODING_AGENT_SESSION_DIR;
	if (direct !== undefined && direct.length > 0) return [direct];
	const agent = environment.PI_CODING_AGENT_DIR;
	return [
		join(
			agent !== undefined && agent.length > 0 ? agent : join(homedir(), ".pi", "agent"),
			"sessions",
		),
	];
};

export const scanPiHomes = async (roots: ReadonlyArray<string>): Promise<PiHomeScan> => {
	const sessions: Array<DiscoveredSession> = [];
	const problems: Array<DiscoveryProblem> = [];
	for (const root of roots) {
		let files: ReadonlyArray<string>;
		try {
			files = await sessionFilesIn(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			problems.push(problem(root, error));
			continue;
		}
		for (const file of files) {
			try {
				sessions.push(await readSession(file));
			} catch (error) {
				problems.push(problem(file, error));
			}
		}
	}
	const byIdentity = new Map(sessions.map((session) => [session.identity, session]));
	return {
		sessions: [...byIdentity.values()].sort((left, right) =>
			left.identity.localeCompare(right.identity),
		),
		problems,
	};
};

export const toSessionMetadata = (session: DiscoveredSession): SessionMetadata => ({
	id: session.piSessionId,
	createdAt: session.createdAt,
	updatedAt: session.updatedAt,
	cwd: session.cwd,
	...(session.parentSessionId === undefined ? {} : {parentSessionId: session.parentSessionId}),
});
