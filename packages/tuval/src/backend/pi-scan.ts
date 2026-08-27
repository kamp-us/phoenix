import {createHash} from "node:crypto";
import {readdir} from "node:fs/promises";
import {homedir} from "node:os";
import {basename, delimiter, join, resolve} from "node:path";
import {type SessionInfo, SessionManager} from "@earendil-works/pi-coding-agent";
import type {DiscoveredSession, DiscoverySource, PiSessionIdentity} from "../shared/wire.ts";

export interface PiSourceScan {
	readonly source: DiscoverySource;
	readonly sessions: ReadonlyArray<DiscoveredSession>;
	readonly issues: ReadonlyArray<string>;
}

export const sourceIdentity = (agentDir: string): string =>
	`pi-${createHash("sha256").update(resolve(agentDir)).digest("hex").slice(0, 16)}`;

export const sessionIdentity = (agentDir: string, nativeId: string): PiSessionIdentity => {
	const sourceId = sourceIdentity(agentDir);
	return {
		id: `${sourceId}:${nativeId}`,
		nativeId,
		sourceId,
	};
};

const sessionDirectories = async (sessionsRoot: string): Promise<ReadonlyArray<string>> => {
	const entries = await readdir(sessionsRoot, {withFileTypes: true});
	const directories = entries
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
		.map((entry) => join(sessionsRoot, entry.name));
	return [sessionsRoot, ...directories];
};

const jsonlFiles = async (directory: string): Promise<ReadonlyArray<string>> =>
	(await readdir(directory, {withFileTypes: true}))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => resolve(directory, entry.name));

const validSession = (session: SessionInfo): boolean =>
	typeof session.id === "string" &&
	session.id.length > 0 &&
	Number.isFinite(session.created.getTime()) &&
	Number.isFinite(session.modified.getTime());

export const scanAgentDir = async (agentDir: string): Promise<PiSourceScan> => {
	const normalizedAgentDir = resolve(agentDir);
	const sessionsRoot = join(normalizedAgentDir, "sessions");
	const id = sourceIdentity(normalizedAgentDir);
	let directories: ReadonlyArray<string>;
	try {
		directories = await sessionDirectories(sessionsRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				source: {id, label: normalizedAgentDir, sessionCount: 0, skippedEntries: 0},
				sessions: [],
				issues: [],
			};
		}
		return {
			source: {id, label: normalizedAgentDir, sessionCount: 0, skippedEntries: 0},
			sessions: [],
			issues: [`${basename(normalizedAgentDir)}: sessions directory could not be read`],
		};
	}

	const candidates: Array<string> = [];
	const listed: Array<SessionInfo> = [];
	const issues: Array<string> = [];
	for (const directory of directories) {
		try {
			candidates.push(...(await jsonlFiles(directory)));
			listed.push(...(await SessionManager.listAll(directory)));
		} catch {
			issues.push(`${basename(directory)}: session source could not be enumerated`);
		}
	}

	const sessions = listed.filter(validSession);
	const validPaths = new Set(sessions.map((session) => resolve(session.path)));
	const skippedEntries = candidates.filter((path) => !validPaths.has(path)).length;
	if (skippedEntries > 0) {
		issues.push(
			`${basename(normalizedAgentDir)}: skipped ${skippedEntries} malformed session entr${skippedEntries === 1 ? "y" : "ies"}`,
		);
	}
	const discovered = sessions.map((session) => ({
		identity: sessionIdentity(normalizedAgentDir, session.id),
		createdAt: session.created.getTime(),
		updatedAt: session.modified.getTime(),
		cwd: session.cwd,
		...(session.name === undefined ? {} : {name: session.name}),
	}));

	return {
		source: {
			id,
			label: normalizedAgentDir,
			sessionCount: discovered.length,
			skippedEntries,
		},
		sessions: discovered,
		issues,
	};
};

export const configuredAgentDirs = (
	env: NodeJS.ProcessEnv = process.env,
	userHome = homedir(),
): ReadonlyArray<string> => {
	if (env.TUVAL_PI_HOMES) {
		return env.TUVAL_PI_HOMES.split(delimiter)
			.filter(Boolean)
			.map((piHome) => join(piHome, "agent"));
	}
	if (env.PI_CODING_AGENT_DIR) return [env.PI_CODING_AGENT_DIR];
	return [join(userHome, ".pi", "agent")];
};
