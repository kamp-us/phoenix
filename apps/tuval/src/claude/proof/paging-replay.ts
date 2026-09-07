import assert from "node:assert/strict";
import type {SessionMessage} from "@anthropic-ai/claude-agent-sdk";
import {Effect, Stream} from "effect";
import {pageCursor} from "../../ai-agent/history/cursor.ts";
import {ItemId, type TranscriptItem} from "../../ai-agent/ports/index.ts";
import {CWD, messages, on, rows, SESSION_ID, START_EVENTS} from "../agent/fixtures/harness.ts";
import {toHistoryItems} from "../history/items.ts";

/** Real ClaudeAiAgent, captured SDK events, scripted store/bridge; no CLI or provider call. */
export const pagingReplay = () => {
	const startedAt = new Date().toISOString();
	const started = performance.now();
	const opening = messages("streaming-turn");
	const firstDelta = opening.findIndex(
		(frame) =>
			frame.type === "stream_event" &&
			frame.event.type === "content_block_delta" &&
			frame.event.delta.type === "text_delta",
	);
	assert.ok(firstDelta >= 0);
	const stored: SessionMessage[] = [
		...rows(),
		{
			type: "user",
			uuid: "stored-stream-prompt",
			session_id: SESSION_ID,
			message: {role: "user", content: "stream a reply"},
			parent_tool_use_id: null,
			parent_agent_id: null,
		},
	];
	return on(
		{opening: opening.slice(0, firstDelta + 1), rows: stored, deferOpening: true},
		(agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				yield* agent.prompt("stream a reply");
				const events = yield* Stream.runCollect(
					Stream.takeUntil(
						agent.events,
						(event) =>
							event.kind === "item" &&
							event.item.kind === "assistant" &&
							event.item.partial === true,
					),
				);
				const partial = events
					.flatMap((event) =>
						event.kind === "item" && event.item.kind === "assistant" ? [event.item] : [],
					)
					.at(-1);
				assert.ok(partial?.partial);
				const local: TranscriptItem = {
					kind: "user",
					id: ItemId.make("local:stream-send"),
					text: "stream a reply",
					timestamp: 0,
					local: true,
				};
				const readsBefore = scripted.reads.length;
				const unavailable = [local.id, partial.id].map((before) =>
					pageCursor([local, partial], before),
				);
				for (const cursor of unavailable) {
					if (cursor.kind === "page") yield* agent.page(cursor.before, 10);
					assert.deepEqual(cursor, {kind: "unavailable"});
				}
				assert.equal(scripted.reads.length, readsBefore);
				assert.equal(toHistoryItems(stored, {at: 0}).cursorAliases.has(partial.id), false);
				const partialMs = performance.now() - started;
				for (const frame of opening.slice(firstDelta + 1)) {
					if (frame.type === "assistant") stored.push({...frame, parent_agent_id: null});
					scripted.opened[0]?.say(frame);
				}
				const completedEvents = yield* Stream.runCollect(
					Stream.takeUntil(
						agent.events,
						(event) => event.kind === "phase" && event.phase === "ready",
					),
				);
				const completed = completedEvents
					.flatMap((event) =>
						event.kind === "item" && event.item.kind === "assistant" ? [event.item] : [],
					)
					.at(-1);
				assert.ok(completed);
				assert.equal(completed.partial, undefined);
				assert.equal(
					stored.some((row) => row.uuid === completed.id),
					false,
				);
				const aliases = toHistoryItems(stored, {at: 0}).cursorAliases;
				assert.ok(aliases.has(completed.id));
				const cursor = pageCursor([local, completed], local.id);
				assert.equal(cursor.kind, "page");
				if (cursor.kind !== "page") return yield* Effect.die("completed cursor unavailable");
				const page = yield* agent.page(cursor.before, 10);
				assert.deepEqual(
					page.items.map((item) => item.kind),
					["user", "tool", "assistant"],
				);
				assert.equal(page.items[0]?.id, rows()[0]?.uuid);
				return {
					startedAt,
					partialMs,
					completedMs: performance.now() - started,
					unavailable,
					partialReads: 0,
					completedReads: scripted.reads.length - readsBefore,
					storedCursor: aliases.get(completed.id),
					cursor,
					local,
					partial,
					completed,
					page,
				};
			}),
	).pipe(Effect.timeout("10 seconds"));
};

export type PagingReplay = Effect.Success<ReturnType<typeof pagingReplay>>;
