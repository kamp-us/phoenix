import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {parentPort, workerData} from "node:worker_threads";
import {
	buildSessionContext,
	type FileEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type {ThinkingLevel, TranscriptItem} from "@earendil-works/pi-protocol";
import {planTranscriptWindow, transcriptOfMessages} from "./coding-agent-transcript.js";

interface SessionFileWorkerData {
	readonly path: string;
	readonly sessionId: string;
	readonly device?: number;
	readonly inode?: number;
}

interface ManagerWorkerData extends SessionFileWorkerData {
	readonly mode: "manager";
}

interface PageWorkerData extends SessionFileWorkerData {
	readonly mode: "page";
	readonly anchorId: string;
}

type LoaderWorkerData = ManagerWorkerData | PageWorkerData;

const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const data = workerData as LoaderWorkerData;

const fail = (error: unknown): void => {
	parentPort?.postMessage({
		type: "error",
		message: error instanceof Error ? error.message : String(error),
	});
};

const headerOf = (entries: ReadonlyArray<FileEntry>): SessionHeader => {
	const header = entries.at(0);
	if (
		header?.type !== "session" ||
		typeof header.id !== "string" ||
		typeof header.cwd !== "string" ||
		typeof header.timestamp !== "string"
	) {
		throw new Error("Retained session has no valid header");
	}
	return header;
};

const sessionNameOf = (entries: ReadonlyArray<FileEntry>): string | undefined => {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "session_info") continue;
		return typeof entry.name === "string" && entry.name.trim().length > 0
			? entry.name.trim()
			: undefined;
	}
	return undefined;
};

const load = async (): Promise<void> => {
	const file = await open(data.path, constants.O_RDONLY | constants.O_NOFOLLOW);
	let content: string;
	try {
		const info = await file.stat();
		if (
			(data.device !== undefined && info.dev !== data.device) ||
			(data.inode !== undefined && info.ino !== data.inode)
		) {
			throw new Error("Retained session file changed after indexing");
		}
		content = await file.readFile("utf8");
	} finally {
		await file.close();
	}
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries);
	const header = headerOf(entries);
	const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const context = buildSessionContext(sessionEntries);
	const transcript = transcriptOfMessages(data.sessionId, context.messages);

	if (data.mode === "page") {
		const before = transcript.findIndex(({id}) => id === data.anchorId);
		if (before <= 0) {
			parentPort?.postMessage({type: "stale"});
			return;
		}
		const page = planTranscriptWindow(transcript, before);
		parentPort?.postMessage({
			type: "page",
			transcript: page.transcript,
			start: page.sourceStart,
		});
		return;
	}

	const thinkingLevel = THINKING_LEVELS.includes(context.thinkingLevel as ThinkingLevel)
		? (context.thinkingLevel as ThinkingLevel)
		: "off";
	const recent = planTranscriptWindow(transcript);
	parentPort?.postMessage({
		type: "history",
		history: {
			cwd: header.cwd,
			...(sessionNameOf(entries) === undefined ? {} : {name: sessionNameOf(entries)}),
			model:
				context.model === null
					? undefined
					: {provider: context.model.provider, id: context.model.modelId},
			thinkingLevel,
			transcript: recent.transcript satisfies ReadonlyArray<TranscriptItem>,
			hasMore: recent.sourceStart > 0,
		},
	});
	setImmediate(() => parentPort?.postMessage({type: "entries", entries}));
};

void load().catch(fail);
