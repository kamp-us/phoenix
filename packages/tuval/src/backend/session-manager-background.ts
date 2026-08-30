import {dirname} from "node:path";
import {Worker} from "node:worker_threads";
import {type FileEntry, SessionManager} from "@earendil-works/pi-coding-agent";
import type {ThinkingLevel, TranscriptItem} from "@earendil-works/pi-protocol";

export interface BackgroundHistory {
	readonly cwd: string;
	readonly name?: string;
	readonly model?: {readonly provider: string; readonly id: string};
	readonly thinkingLevel: ThinkingLevel;
	readonly transcript: ReadonlyArray<TranscriptItem>;
	readonly hasMore: boolean;
}

export interface BackgroundManagerLoad {
	readonly result: Promise<SessionManager>;
	readonly cancel: () => void;
}

const workerModule = (): URL =>
	import.meta.url.endsWith(".ts")
		? new URL("../../dist/backend/session-manager-loader-worker.js", import.meta.url)
		: new URL("./session-manager-loader-worker.js", import.meta.url);

const managerFromEntries = (
	path: string,
	history: BackgroundHistory,
	entries: ReadonlyArray<FileEntry>,
): SessionManager => {
	return Reflect.construct(SessionManager, [
		history.cwd,
		dirname(path),
		path,
		true,
		undefined,
		entries,
	]);
};

export const openSessionManagerInBackground = (
	path: string,
	sessionId: string,
	identity: {readonly device: number; readonly inode: number},
	onHistory: (history: BackgroundHistory) => void,
): BackgroundManagerLoad => {
	const worker = new Worker(workerModule(), {
		workerData: {mode: "manager", path, sessionId, ...identity},
	});
	let history: BackgroundHistory | undefined;
	let settled = false;
	let resolveResult: (manager: SessionManager) => void = () => undefined;
	let rejectResult: (error: Error) => void = () => undefined;
	const result = new Promise<SessionManager>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	const reject = (error: Error): void => {
		if (settled) return;
		settled = true;
		rejectResult(error);
		void worker.terminate();
	};
	worker.on("message", (message: unknown) => {
		if (typeof message !== "object" || message === null || !("type" in message)) return;
		const typed = message as {
			readonly type: string;
			readonly history?: BackgroundHistory;
			readonly entries?: ReadonlyArray<FileEntry>;
			readonly message?: string;
		};
		if (typed.type === "history" && typed.history !== undefined) {
			history = typed.history;
			onHistory(typed.history);
			return;
		}
		if (typed.type === "entries" && typed.entries !== undefined && history !== undefined) {
			try {
				const manager = managerFromEntries(path, history, typed.entries);
				settled = true;
				resolveResult(manager);
				void worker.terminate();
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
			return;
		}
		if (typed.type === "error")
			reject(new Error(typed.message ?? "Session background load failed"));
	});
	worker.once("error", reject);
	worker.once("exit", (code) => {
		if (!settled && code !== 0) reject(new Error(`Session background loader exited with ${code}`));
	});
	return {
		result,
		cancel: () => {
			if (settled) return;
			settled = true;
			rejectResult(new Error("Session background load was cancelled"));
			void worker.terminate();
		},
	};
};

export const loadTranscriptPageInBackground = (
	path: string,
	sessionId: string,
	anchorId: string,
	identity?: {readonly device: number; readonly inode: number},
): Promise<{readonly transcript: ReadonlyArray<TranscriptItem>; readonly start: number} | null> =>
	new Promise((resolve, reject) => {
		const worker = new Worker(workerModule(), {
			workerData: {mode: "page", path, sessionId, anchorId, ...identity},
		});
		let settled = false;
		const finish = (
			outcome: {readonly transcript: ReadonlyArray<TranscriptItem>; readonly start: number} | null,
		): void => {
			if (settled) return;
			settled = true;
			resolve(outcome);
			void worker.terminate();
		};
		worker.on("message", (message: unknown) => {
			if (typeof message !== "object" || message === null || !("type" in message)) return;
			const typed = message as {
				readonly type: string;
				readonly transcript?: ReadonlyArray<TranscriptItem>;
				readonly start?: number;
				readonly message?: string;
			};
			if (typed.type === "stale") finish(null);
			else if (
				typed.type === "page" &&
				typed.transcript !== undefined &&
				typed.start !== undefined
			) {
				finish({transcript: typed.transcript, start: typed.start});
			} else if (typed.type === "error") {
				settled = true;
				reject(new Error(typed.message ?? "Transcript page load failed"));
				void worker.terminate();
			}
		});
		worker.once("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		worker.once("exit", (code) => {
			if (settled || code === 0) return;
			settled = true;
			reject(new Error(`Transcript page loader exited with ${code}`));
		});
	});
