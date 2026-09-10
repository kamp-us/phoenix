/**
 * Paging back after a subagent spawn, over the real `ClaudeAiAgent` and the real fold (#8814).
 *
 * The founder's desk answered "Could not load earlier messages … (unknown-cursor): cursor-not-found"
 * here, and the seam is only visible with all three parts joined: the layer maps a worker's frames
 * to items tagged `parentId` and its task notices to `system` items, the core folds those into the
 * live tail, and the window anchors its page on the oldest row it holds. Neither class exists in the
 * stored session — the CLI writes a worker's frames to a `subagents/agent-*.jsonl` sidecar — so a
 * cursor minted from one is refused by the same layer that emitted it. Both halves are asserted in
 * one run: the raw anchor still refuses, and the cursor `olderPageRequest` mints off it is served.
 *
 * The captured turn is `../history/fixtures/subagent-turn.json`, and what is scripted is the SDK
 * seam and nothing else.
 */

import type {SDKMessage, SessionMessage} from "@anthropic-ai/claude-agent-sdk";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Option, Stream} from "effect";
import {foldItem} from "../../ai-agent/core/fold.ts";
import type {SubagentSlot, TranscriptPayload} from "../../ai-agent/ports/index.ts";
import {chatRows, olderPageRequest, subagentHeads} from "../../shell/chat/rows.ts";
import {CWD, messages, on, rows, SESSION_ID, START_EVENTS} from "../agent/fixtures/harness.ts";

const PROMPT = "spawn a worker";
const TURN: ReadonlyArray<SDKMessage> = messages("subagent-turn");

/**
 * The session file as the CLI leaves it after this turn: the standing exchange, the prompt that
 * opened this one, and the turn's own frames. A worker's frames are deliberately absent — that is
 * the fact under the bug, not a shortcut in the fixture.
 */
const storedAfterTurn = (): ReadonlyArray<SessionMessage> => [
	...rows(),
	{
		type: "user",
		uuid: "stored-spawn-prompt",
		session_id: SESSION_ID,
		message: {role: "user", content: PROMPT},
		parent_tool_use_id: null,
		parent_agent_id: null,
	},
	...TURN.flatMap((frame) =>
		(frame.type === "assistant" || frame.type === "user") && frame.parent_tool_use_id === null
			? [{...frame, session_id: SESSION_ID, parent_agent_id: null} as SessionMessage]
			: [],
	),
];

const reasonOf = (exit: Exit.Exit<unknown, unknown>): string | undefined =>
	Exit.isFailure(exit)
		? (Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as {reason?: string} | undefined)
				?.reason
		: undefined;

describe("paging back after a subagent spawn", () => {
	it.effect("answers with a page rather than refusing the cursor the window holds", () =>
		on({opening: [...TURN], rows: storedAfterTurn()}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				yield* agent.prompt(PROMPT);
				const events = yield* Stream.runCollect(
					Stream.takeUntil(
						agent.events,
						(event) => event.kind === "phase" && event.phase === "ready",
					),
				);

				let transcript: TranscriptPayload = {
					items: [],
					omitted: {items: 0, bytes: 0, reason: "none"},
				};
				const slots: Record<string, SubagentSlot> = {};
				for (const event of events) {
					// Narrow on purpose, so the tail ends inside the turn and there is stored history
					// older than the row the window will anchor on.
					if (event.kind === "item") transcript = foldItem(transcript, event.item, {itemLimit: 6});
					if (event.kind === "subagent") slots[event.slot.id] = event.slot;
				}
				assert.isAbove(Object.keys(slots).length, 0, "the turn spawned no worker");
				assert.isAbove(
					transcript.items.filter((item) => item.parentId !== undefined).length,
					0,
					"the tail carries no nested rows",
				);

				const listed = chatRows({
					older: [],
					tail: transcript.items,
					omitted: transcript.omitted.items,
					loading: false,
					atOldest: false,
					subagents: subagentHeads(slots, true),
				});
				const request = olderPageRequest(listed);
				assert.isNotNull(request, "the window minted no page request");
				if (request === null) return;

				// The banner's own path: the oldest row the window holds is a task notice this session
				// never stored, so asking for it by id is still `unknown-cursor`.
				const raw = yield* Effect.exit(agent.page(request.anchor, 20));
				assert.equal(reasonOf(raw), "unknown-cursor");
				assert.notEqual(request.before, request.anchor);

				const page = yield* agent.page(request.before, 20);
				assert.isAbove(page.items.length, 0);
			}),
		),
	);
});
