/**
 * Paging back after a subagent spawn, over the real `ClaudeAiAgent` and the real fold (#8814).
 *
 * The founder's desk answered "Could not load earlier messages … (unknown-cursor): cursor-not-found"
 * here, and the seam is only visible with all three parts joined: the layer maps a worker's frames
 * to items tagged `parentId` and its task notices to `system` items, the core folds those into the
 * live tail, and the window anchors its page on the oldest row it holds. Neither class exists in the
 * stored session — the CLI writes a worker's frames to a `subagents/agent-*.jsonl` sidecar — so a
 * cursor minted from one is refused by the same layer that emitted it.
 *
 * **Which window shape reaches that refusal changed with #9514, so the two halves are two cases.**
 * The planner now keeps walking older until the window holds a row `anchorsCursor` accepts, and a
 * worker's rows and the session's notices no longer spend the conversation's own bound at all — so
 * at a roomy bound this same turn plans a window reaching back *past* the spawn to the turn's own
 * opening row, which the session did store. That is the fix working, and it is the first case.
 *
 * A cursor can still be stranded, and the shape that strands it is the one where the window's
 * anchor is *newer* than its oldest rendered row: the bound stops the walk one group short of the
 * conversation row behind the spawn, which leaves a live-only notice at the oldest edge with a
 * stored turn behind it. That is the banner's path, and it is the second case.
 *
 * The captured turn is `../history/fixtures/subagent-turn.json`, and what is scripted is the SDK
 * seam and nothing else.
 */

import type {SDKMessage, SessionMessage} from "@anthropic-ai/claude-agent-sdk";
import {assert, describe, it} from "@effect/vitest";
import {
	isNoticeItem,
	type SubagentSlot,
	type TranscriptPayload,
} from "@kampus/tuval/ai-agent/ports";
import {foldItem} from "@kampus/tuval/kernel/ai-agent/core/fold";
import type {AgentEvent} from "@kampus/tuval/kernel/ai-agent/events";
import type {TuvalAiAgentApi} from "@kampus/tuval/kernel/ai-agent/service/index";
import {Cause, Effect, Exit, Option, Stream} from "effect";
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

/** Run the spawn turn to `ready` and hand back every event it raised. */
const spawnTurn = (agent: TuvalAiAgentApi): Effect.Effect<ReadonlyArray<AgentEvent>, unknown> =>
	Effect.gen(function* () {
		yield* agent.start({cwd: CWD});
		yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
		yield* agent.prompt(PROMPT);
		const events = yield* Stream.runCollect(
			Stream.takeUntil(agent.events, (event) => event.kind === "phase" && event.phase === "ready"),
		);
		return [...events];
	});

/** The turn folded at one item bound, rendered, and the page request the shell mints off it. */
const windowAt = (events: ReadonlyArray<AgentEvent>, itemLimit: number) => {
	let transcript: TranscriptPayload = {items: [], omitted: {items: 0, bytes: 0, reason: "none"}};
	const slots: Record<string, SubagentSlot> = {};
	for (const event of events) {
		if (event.kind === "item") transcript = foldItem(transcript, event.item, {itemLimit});
		if (event.kind === "subagent") slots[event.slot.id] = event.slot;
	}
	const listed = chatRows({
		older: [],
		tail: transcript.items,
		omitted: transcript.omitted.items,
		loading: false,
		atOldest: false,
		subagents: subagentHeads(slots, true),
	});
	return {transcript, slots, request: olderPageRequest(listed)};
};

describe("paging back after a subagent spawn", () => {
	it.effect("anchors past the worker's rows on a turn the session stored", () =>
		on({opening: [...TURN], rows: storedAfterTurn()}, (agent) =>
			Effect.gen(function* () {
				// Six own items is more than this turn's conversation spends, so the walk runs out of
				// history rather than budget and the whole turn — the worker's rows included — rides.
				const {transcript, slots, request} = windowAt(yield* spawnTurn(agent), 6);
				assert.isAbove(Object.keys(slots).length, 0, "the turn spawned no worker");
				assert.isAbove(
					transcript.items.filter((item) => item.parentId !== undefined).length,
					0,
					"the tail carries no nested rows",
				);
				assert.isNotNull(request, "the window minted no page request");
				if (request === null) return;

				// Before #9514 the worker's rows and the turn's notices spent this bound, so the window
				// stopped on them and the cursor it minted was refused. They ride free of it now, so the
				// oldest row the window holds is the turn's own opening row: it anchors the cursor
				// itself, and the layer resolves it against the stored session.
				assert.equal(request.before, request.anchor);
				const page = yield* agent.page(request.anchor, 20);
				assert.isAbove(page.items.length, 0);
			}),
		),
	);

	it.effect("answers with a page rather than refusing the cursor the window holds", () =>
		on({opening: [...TURN], rows: storedAfterTurn()}, (agent) =>
			Effect.gen(function* () {
				// Two own items: the turn's closing reply, and then one group short of the opening row
				// behind the spawn. The walk stops there rather than crossing the bound for it, because
				// that reply already anchors the window — which leaves a notice at the oldest edge.
				const {transcript, slots, request} = windowAt(yield* spawnTurn(agent), 2);
				assert.isAbove(Object.keys(slots).length, 0, "the turn spawned no worker");
				assert.isNotNull(request, "the window minted no page request");
				if (request === null) return;
				const oldest = transcript.items[0];
				assert.isDefined(oldest, "the window is empty");
				if (oldest === undefined) return;
				assert.isTrue(isNoticeItem(oldest), "the window's oldest row is not a session notice");

				// The banner's own path: the oldest row the window holds is a notice this session never
				// stored, so asking for it by id is still `unknown-cursor`.
				const raw = yield* Effect.exit(agent.page(request.anchor, 20));
				assert.equal(reasonOf(raw), "unknown-cursor");
				assert.notEqual(request.before, request.anchor);

				const page = yield* agent.page(request.before, 20);
				assert.isAbove(page.items.length, 0);
			}),
		),
	);
});
