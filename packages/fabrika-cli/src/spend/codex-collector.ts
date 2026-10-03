import {Effect, FileSystem, Path, Result, Stream} from "effect";
import {
	CodexSessionReader,
	type CodexWork,
	codexCommon,
	codexRecords,
	isAccountingRow,
	type NativeSession,
} from "./codex-records.ts";
import {recordUsage} from "./usage-ledger.ts";
import type {UsageRecord} from "./usage-record.ts";

export interface CodexCollection {
	readonly sessions: string;
	readonly ledger: string;
	readonly rootThread: string;
	readonly work: CodexWork;
	readonly rootTurn?: string;
	readonly transcripts?: ReadonlyArray<string>;
	readonly expected?: ReadonlyArray<string>;
}
export interface CodexInventory {
	readonly sessions: ReadonlyArray<NativeSession>;
	readonly notices: ReadonlyArray<string>;
}
export const readCodexInventory = Effect.fn("spend.readCodexInventory")(function* (
	root: string,
	transcripts: ReadonlyArray<string> = [],
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const notices: string[] = [];
	const files = new Set(transcripts);
	const pending = [root];
	const archived = path.join(path.dirname(root), "archived_sessions");
	if (yield* fs.exists(archived)) pending.push(archived);
	const visited = new Set<string>();
	while (pending.length) {
		const dir = pending.pop();
		if (dir === undefined) break;
		const real = yield* Effect.result(fs.realPath(dir));
		if (Result.isFailure(real)) {
			notices.push(`Codex session inventory unreadable: ${dir}`);
			continue;
		}
		if (visited.has(real.success)) continue;
		visited.add(real.success);
		const entries = yield* Effect.result(fs.readDirectory(dir));
		if (Result.isFailure(entries)) {
			notices.push(`Codex session inventory unreadable: ${dir}`);
			continue;
		}
		for (const entry of entries.success) {
			const file = path.join(dir, entry);
			const stat = yield* Effect.result(fs.stat(file));
			if (Result.isFailure(stat)) {
				notices.push(`Codex session path unreadable: ${file}`);
				continue;
			}
			if (stat.success.type === "Directory") pending.push(file);
			else if (stat.success.type === "File" && file.endsWith(".jsonl")) files.add(file);
		}
	}
	const sessions: NativeSession[] = [];
	for (const file of [...files].sort()) {
		const reader = new CodexSessionReader(isAccountingRow);
		// Flushed at the end so a truncated trailing sequence decodes as readFileString would.
		const decoder = new TextDecoder();
		const read = yield* Effect.result(
			fs
				.stream(file)
				.pipe(
					Stream.runForEach((bytes) =>
						Effect.sync(() => reader.feed(decoder.decode(bytes, {stream: true}))),
					),
				),
		);
		if (Result.isSuccess(read)) reader.feed(decoder.decode());
		const session = Result.isSuccess(read) ? reader.finish() : null;
		if (session === null) notices.push(`Codex session unreadable or unsupported: ${file}`);
		else sessions.push(session);
	}
	return {sessions, notices} satisfies CodexInventory;
});
export const collectCodex = Effect.fn("spend.collectCodex")(function* (options: CodexCollection) {
	return yield* collectCodexFrom(
		yield* readCodexInventory(options.sessions, options.transcripts),
		options,
	);
});
/** Records one root's usage from an inventory already read, so several roots share one read. */
export const collectCodexFrom = Effect.fn("spend.collectCodexFrom")(function* (
	inventory: CodexInventory,
	options: Omit<CodexCollection, "sessions" | "transcripts">,
) {
	const {sessions} = inventory;
	const notices = [...inventory.notices];
	const included = new Set([options.rootThread, ...(options.expected ?? [])]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const session of sessions)
			if (
				session.parent !== null &&
				included.has(session.parent) &&
				!included.has(session.thread)
			) {
				included.add(session.thread);
				changed = true;
			}
	}
	const records: UsageRecord[] = [];
	for (const thread of [...included].sort()) {
		const matching = sessions.filter((session) => session.thread === thread);
		const first = matching[0];
		const common = codexCommon(
			thread,
			first?.parent ?? null,
			options.rootThread,
			first?.version ?? "unknown",
			options.work,
		);
		const state = !first
			? ("unreadable" as const)
			: !["0.153.4", "0.154.0"].includes(first.version)
				? ("unsupported" as const)
				: ("expected" as const);
		records.push({
			...common,
			kind: "participant",
			recordId: JSON.stringify([thread, state]),
			participant: thread,
			state,
		});
		if (!first) notices.push(`Missing native session ${thread}; retry collection when available.`);
		for (const session of matching) {
			const parsed = codexRecords(session, options.rootThread, options.work, options.rootTurn);
			records.push(...parsed.records);
			notices.push(...parsed.notices);
			if (parsed.notices.length)
				records.push({
					...common,
					kind: "participant",
					recordId: JSON.stringify([thread, "usage-missing", options.rootTurn ?? null]),
					participant: thread,
					state: "usage-missing",
				});
		}
	}
	const participants = [...included].sort();
	records.push({
		...codexCommon(options.rootThread, null, options.rootThread, "collector-1", options.work),
		kind: "coverage",
		recordId: JSON.stringify([options.rootTurn ?? null, participants, notices]),
		state: "partial",
		discovery: "unknown",
		participants,
	});
	let recorded = 0;
	for (const record of records) {
		const result = yield* recordUsage(options.ledger, record);
		if (result.status === "failed") notices.push(result.notice);
		else if (result.status === "recorded") recorded++;
	}
	return {recorded, notices: [...new Set(notices)], participants, coverage: "partial" as const};
});
