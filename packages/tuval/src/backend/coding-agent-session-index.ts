import {stat} from "node:fs/promises";
import {basename} from "node:path";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import type {SessionMetadata} from "@earendil-works/pi-protocol";
import {sessionIdFromFilename} from "./pi-home.js";
import {indexSessionFiles} from "./session-file-index.js";

export type IndexedSessionMetadata = SessionMetadata & {readonly path: string};

const metadataForPath = async (path: string): Promise<IndexedSessionMetadata | undefined> => {
	try {
		const manager = SessionManager.open(path);
		const header = manager.getHeader();
		if (header === null) return undefined;
		const id =
			sessionIdFromFilename(path) ?? (basename(path) === "session.jsonl" ? header.id : undefined);
		if (id === undefined || id.length === 0) return undefined;
		const info = await stat(path);
		const headerTime = Date.parse(header.timestamp);
		const parentSessionId =
			header.parentSession === undefined ? undefined : sessionIdFromFilename(header.parentSession);
		const sessionName = manager.getSessionName();
		return {
			id,
			createdAt: Number.isFinite(headerTime)
				? Math.floor(headerTime)
				: Math.floor(info.birthtimeMs),
			updatedAt: Math.floor(info.mtimeMs),
			cwd: header.cwd,
			...(sessionName === undefined ? {} : {sessionName}),
			...(parentSessionId === undefined ? {} : {parentSessionId}),
			path,
		};
	} catch {
		return undefined;
	}
};

const preferredMetadata = (
	listed: ReadonlyArray<IndexedSessionMetadata>,
): Array<IndexedSessionMetadata> => {
	const byId = new Map<string, IndexedSessionMetadata>();
	for (const session of listed) {
		const existing = byId.get(session.id);
		if (
			existing === undefined ||
			(session.updatedAt ?? 0) > (existing.updatedAt ?? 0) ||
			((session.updatedAt ?? 0) === (existing.updatedAt ?? 0) &&
				session.path.localeCompare(existing.path) < 0)
		) {
			byId.set(session.id, session);
		}
	}
	return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
};

export const makeCodingAgentSessionIndex = (roots: ReadonlyArray<string>) => {
	const list = async (): Promise<Array<IndexedSessionMetadata>> => {
		const indexed = await Promise.all(roots.map((root) => indexSessionFiles(root)));
		const sessions: Array<IndexedSessionMetadata> = [];
		for (const path of indexed.flatMap(({files}) => files)) {
			const metadata = await metadataForPath(path);
			if (metadata !== undefined) sessions.push(metadata);
		}
		return preferredMetadata(sessions);
	};

	const find = async (sessionId: string): Promise<IndexedSessionMetadata | undefined> => {
		const indexed = await Promise.all(roots.map((root) => indexSessionFiles(root)));
		const candidates: Array<IndexedSessionMetadata> = [];
		for (const path of indexed.flatMap(({files}) => files)) {
			const filenameId = sessionIdFromFilename(path);
			if (filenameId !== sessionId && basename(path) !== "session.jsonl") continue;
			const metadata = await metadataForPath(path);
			if (metadata?.id === sessionId) candidates.push(metadata);
		}
		return preferredMetadata(candidates)[0];
	};

	return {list, find};
};
