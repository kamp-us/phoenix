import {Effect} from "effect";
import {newestFirst, sessionSummary} from "../ai-agent/service/index.ts";
import {historyItem} from "./history.ts";
import {decode, Models, ReadThread, type Thread, Threads} from "./protocol.ts";
import {type CodexConnection, protocolError} from "./transport.ts";

export const readModels = Effect.fn("Codex.models")(function* (connection: CodexConnection) {
	const rows: Array<(typeof Models.Type.data)[number]> = [];
	let cursor: string | null = null;
	const seen = new Set<string>();
	do {
		const page: typeof Models.Type = yield* connection
			.request("model/list", {cursor, limit: 100})
			.pipe(Effect.flatMap((value) => decode(Models, value)));
		rows.push(...page.data.filter((model) => !model.hidden));
		cursor = page.nextCursor;
		if (cursor !== null) {
			if (seen.has(cursor)) return yield* protocolError("Codex repeated a model cursor");
			seen.add(cursor);
		}
	} while (cursor !== null);
	return rows;
});

export const readSessions = Effect.fn("Codex.sessions")(function* (connection: CodexConnection) {
	const rows: Array<Thread> = [];
	for (const archived of [false, true]) {
		let cursor: string | null = null;
		const seen = new Set<string>();
		do {
			const page: typeof Threads.Type = yield* connection
				.request("thread/list", {
					cursor,
					limit: 100,
					archived,
					sortKey: "updated_at",
					modelProviders: [],
					sourceKinds: [
						"cli",
						"vscode",
						"exec",
						"appServer",
						"subAgent",
						"subAgentReview",
						"subAgentCompact",
						"subAgentThreadSpawn",
						"subAgentOther",
						"unknown",
					],
				})
				.pipe(Effect.flatMap((value) => decode(Threads, value)));
			rows.push(...page.data);
			cursor = page.nextCursor;
			if (cursor !== null) {
				if (seen.has(cursor)) return yield* protocolError("Codex repeated a session cursor");
				seen.add(cursor);
			}
		} while (cursor !== null);
	}
	return newestFirst(
		rows.map((row) =>
			sessionSummary({
				sessionId: row.id,
				backend: "codex",
				lastModified: row.updatedAt * 1000,
				firstPrompt: row.preview,
				folder: row.cwd,
				branch: row.gitInfo?.branch,
			}),
		),
	);
});

export const readThread = Effect.fn("Codex.readThread")(function* (
	connection: CodexConnection,
	id: string,
) {
	const {thread} = yield* connection
		.request("thread/read", {threadId: id, includeTurns: true})
		.pipe(Effect.flatMap((value) => decode(ReadThread, value)));
	if (thread.id !== id) return yield* protocolError("Codex returned a different thread");
	return thread;
});

// A stored paginated history Codex has not projected yet answers thread/read with zero turns and
// exhausted paging cursors, so nothing in the read-only protocol separates it from a session that
// really is empty. Only the legacy loader's empty answer is evidence of emptiness; the thread preview
// is evidence neither way. See reports/2026-09-09-codex-history-8464.md.
const certifiesEmptiness = (thread: Thread) => thread.historyMode === "legacy";

export const readHistory = Effect.fn("Codex.history")(function* (
	connection: CodexConnection,
	id: string,
) {
	const thread = yield* readThread(connection, id);
	if (thread.turns.length === 0 && !certifiesEmptiness(thread))
		return yield* protocolError(
			`Codex returned no turns for session ${id} under history mode ${
				thread.historyMode ?? "none reported"
			}; this read cannot tell an empty session from history the store has not projected`,
		);
	return yield* Effect.try({
		try: () =>
			thread.turns.flatMap((turn) =>
				turn.items.map((item) => historyItem(item, (turn.startedAt ?? thread.createdAt) * 1000)),
			),
		catch: protocolError,
	});
});
