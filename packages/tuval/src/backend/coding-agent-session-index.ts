import type {Stats} from "node:fs";
import {open} from "node:fs/promises";
import {basename} from "node:path";
import type {SessionMetadata} from "@earendil-works/pi-protocol";
import {sessionIdFromFilename} from "./pi-home.js";
import {indexSessionFiles} from "./session-file-index.js";

export type IndexedSessionMetadata = SessionMetadata & {
	readonly path: string;
	readonly device: number;
	readonly inode: number;
};

const MAX_HEADER_BYTES = 1_048_576;
const HEADER_CHUNK_BYTES = 4_096;

interface IndexedHeader {
	readonly type: "session";
	readonly id: string;
	readonly timestamp: string;
	readonly cwd: string;
	readonly parentSession?: string;
}

const indexedHeader = (value: unknown): value is IndexedHeader => {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.type === "session" &&
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		typeof candidate.timestamp === "string" &&
		typeof candidate.cwd === "string" &&
		(candidate.parentSession === undefined || typeof candidate.parentSession === "string")
	);
};

const parseHeaderLine = (line: string): IndexedHeader | null | undefined => {
	if (line.trim().length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(line);
		return indexedHeader(parsed) ? parsed : null;
	} catch {
		return undefined;
	}
};

const readHeader = async (
	path: string,
): Promise<{readonly header: IndexedHeader; readonly info: Stats} | undefined> => {
	const file = await open(path, "r");
	try {
		const info = await file.stat();
		let scanned = 0;
		let pending = "";
		const buffer = Buffer.allocUnsafe(HEADER_CHUNK_BYTES);
		while (scanned < MAX_HEADER_BYTES) {
			const length = Math.min(buffer.length, MAX_HEADER_BYTES - scanned);
			const {bytesRead} = await file.read(buffer, 0, length, scanned);
			if (bytesRead === 0) {
				const header = parseHeaderLine(pending);
				return header === undefined || header === null ? undefined : {header, info};
			}
			scanned += bytesRead;
			pending += buffer.subarray(0, bytesRead).toString("utf8");
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				const header = parseHeaderLine(pending.slice(0, newline));
				if (header === null) return undefined;
				if (header !== undefined) return {header, info};
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
		}
		return undefined;
	} finally {
		await file.close();
	}
};

const metadataForPath = async (path: string): Promise<IndexedSessionMetadata | undefined> => {
	try {
		const indexed = await readHeader(path);
		if (indexed === undefined) return undefined;
		const {header, info} = indexed;
		const id =
			sessionIdFromFilename(path) ?? (basename(path) === "session.jsonl" ? header.id : undefined);
		if (id === undefined || id.length === 0) return undefined;
		const headerTime = Date.parse(header.timestamp);
		const parentSessionId =
			header.parentSession === undefined ? undefined : sessionIdFromFilename(header.parentSession);
		return {
			id,
			createdAt: Number.isFinite(headerTime)
				? Math.floor(headerTime)
				: Math.floor(info.birthtimeMs),
			updatedAt: Math.floor(info.mtimeMs),
			cwd: header.cwd,
			...(parentSessionId === undefined ? {} : {parentSessionId}),
			path,
			device: info.dev,
			inode: info.ino,
		};
	} catch {
		return undefined;
	}
};

const mapBounded = async <A, B>(
	values: ReadonlyArray<A>,
	project: (value: A) => Promise<B>,
): Promise<Array<B>> => {
	const results = new Array<B>(values.length);
	let cursor = 0;
	const workers = Array.from({length: Math.min(16, values.length)}, async () => {
		while (cursor < values.length) {
			const index = cursor;
			cursor += 1;
			const value = values[index];
			if (value !== undefined) results[index] = await project(value);
		}
	});
	await Promise.all(workers);
	return results;
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
		const sessions = await mapBounded(
			indexed.flatMap(({files}) => files),
			metadataForPath,
		);
		return preferredMetadata(
			sessions.filter((session): session is IndexedSessionMetadata => session !== undefined),
		);
	};

	const find = async (sessionId: string): Promise<IndexedSessionMetadata | undefined> => {
		const indexed = await Promise.all(roots.map((root) => indexSessionFiles(root)));
		const paths = indexed
			.flatMap(({files}) => files)
			.filter((path) => {
				const filenameId = sessionIdFromFilename(path);
				return filenameId === sessionId || basename(path) === "session.jsonl";
			});
		const candidates = await mapBounded(paths, metadataForPath);
		return preferredMetadata(
			candidates.filter(
				(metadata): metadata is IndexedSessionMetadata => metadata?.id === sessionId,
			),
		)[0];
	};

	return {list, find};
};
