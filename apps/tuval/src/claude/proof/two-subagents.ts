/**
 * The captured two-worker turn the subagent proof replays, and the handle that paces it.
 *
 * `two-subagent-turn.json` is a real `query()` run whose one prompt spawned two `Explore` workers
 * that overlapped (`../history/fixtures/PROVENANCE.md`). Replaying it through the scripted `AgentSdk`
 * seam is what makes the proof a claim about the *real* Claude layer: `ClaudeAiAgent` does the whole
 * mapping — the slot opens, the nested rows fold into it, the parent's `tool_result` finishes it —
 * and nothing here hands the core an `AgentEvent` of its own.
 *
 * The handle is paced rather than played whole, because three of the five claims are about a moment:
 * both workers on the list *while they run*, one of them finishing *under an open view*, and main
 * restored after that. A run that delivered all 59 frames at once would only ever show the end.
 *
 * It hangs off `globalThis` because two importers have to reach one object: the test imports this
 * module by path, and `boot` imports `./subagent-desk.ts` beside it as a `file://` URL
 * (`../../config.ts`). Two module instances would leave the test pacing a query the desk never
 * opened, and the failure would read as a layer that never started.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {type ScriptedSdk, scriptedSdk} from "../agent/fixtures/scripted-query.ts";
import {loadFixture} from "../history/fixtures/load.ts";

/** The id the capture's own `init` frame names, so the layer opens the session the capture is of. */
export const CAPTURE_SESSION_ID = "00000000-0000-4000-8000-000000000001";

export const captureFrames = (): ReadonlyArray<SDKMessage> =>
	loadFixture("two-subagent-turn") as ReadonlyArray<SDKMessage>;

const HANDLE = Symbol.for("tuval/claude/proof/two-subagents");

interface Handle {
	readonly sdk: ScriptedSdk;
	delivered: number;
}

export const captureHandle = (): Handle => {
	const held = (globalThis as Record<symbol, unknown>)[HANDLE];
	if (held !== undefined) return held as Handle;
	const made: Handle = {sdk: scriptedSdk({opening: []}), delivered: 0};
	(globalThis as Record<symbol, unknown>)[HANDLE] = made;
	return made;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * A frame's content blocks. Read off the value rather than off `SDKMessage`'s union, because only
 * some members declare `message` at all and this walks every frame the capture holds.
 */
const blocksOf = (frame: SDKMessage): ReadonlyArray<Record<string, unknown>> => {
	const held = frame as Record<string, unknown>;
	const message = isRecord(held.message) ? held.message : undefined;
	const content = message === undefined ? undefined : message.content;
	return Array.isArray(content) ? content.filter(isRecord) : [];
};

/**
 * The two spawning calls, in the order the capture made them. Read off the frames rather than
 * written down: a re-capture moves the ids, and a proof carrying its own copy of them would assert
 * against the old run.
 */
export const spawnCallIds = (frames: ReadonlyArray<SDKMessage>): ReadonlyArray<string> =>
	frames.flatMap((frame) =>
		blocksOf(frame).flatMap((block) =>
			block.type === "tool_use" &&
			isRecord(block.input) &&
			typeof block.input.subagent_type === "string" &&
			typeof block.id === "string"
				? [block.id]
				: [],
		),
	);

/**
 * Where the parent's own `tool_result` for one spawning call arrives — the frame that ends that
 * worker. `parent_tool_use_id: null` is what makes it the parent's frame and not a nested one.
 */
export const finishFrameOf = (frames: ReadonlyArray<SDKMessage>, callId: string): number =>
	frames.findIndex(
		(frame) =>
			(frame as Record<string, unknown>).parent_tool_use_id === null &&
			blocksOf(frame).some((block) => block.type === "tool_result" && block.tool_use_id === callId),
	);
