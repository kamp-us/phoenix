/**
 * A Claude window that prompts, reconnects and pages holds one row per prompt — the rule #7979 had
 * to settle, and the seam it is settled at.
 *
 * Both halves are real. The tail is the core's own: a `prompt` Msg through the machine, taken
 * through `restore`, which is what a reconnect leaves a window looking at. The page comes off a
 * live `claude-session` row over `ClaudeAiAgent` and the captured `session-messages` rows, driven
 * by the same `page` Msg a window dispatches — and the CLI's stored transcript does carry the
 * operator's prompt rows, so the two halves genuinely name one turn under two ids.
 *
 * The rule chosen is neither of the two the ticket sketched. Re-keying the stored row onto the
 * send's idempotency key cannot survive the reconnect it has to survive: the key is Tuval's, it is
 * never written to the CLI's transcript, and the layer that held the send is rebuilt on resume
 * (`../../ai-agent/handlers/session.ts`). Suppressing the stored user rows outright would hand the
 * operator the same defect back on scroll-back, since past the core's bounded tail the store is the
 * only place their own words exist. So the join is `withoutLocalEchoes`
 * (`../../ai-agent/history/local-turns.ts`) — on text, bounded by count, which is the join the core
 * itself uses for a layer's echo (`../../ai-agent/core/fold.ts`) — and the `aiAgent.page` handler
 * applies it, so both routes a page takes carry one copy and no window has to know.
 */

import {applyCellChecked} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionState,
	aiAgentSessionMachine,
	initialState,
	isAiAgentSessionState,
	promptItemId,
	restore,
} from "../../ai-agent/core/index.ts";
import {Mode, type TranscriptItem} from "../../ai-agent/ports/index.ts";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {memoryStores} from "../../durability/stores.ts";
import {NodeId} from "../../ports/graph.ts";
import {PortNotWired, ProcessPorts} from "../../ports/index.ts";
import {Processes} from "../../process/Processes.ts";
import type {ProcessHandle} from "../../process/process.ts";
import {Registry} from "../../registry/Registry.ts";
import {rows, TOOL_SESSION_ID} from "../agent/fixtures/harness.ts";
import {scriptedSdk} from "../agent/fixtures/scripted-query.ts";
import {ClaudeAiAgent} from "../agent/index.ts";
import {CLAUDE_MODES} from "../config.ts";
import {claudeSession} from "../program.ts";
import {KernelBridge} from "../tools/index.ts";

const CWD = "/work";
/** The operator's turn in the captured store, verbatim — the row `page` reads back. */
const PROMPT = "Run the bash command: echo hello-tuval";
const KEY = "k1";
const AT = 1_760_000_000_000;

const machine = aiAgentSessionMachine({cwd: CWD});

const apply = (
	state: AiAgentSessionState,
	msg: AiAgentSessionMsg,
): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(machine, state, msg);

/**
 * The tail a reconnected window is looking at: a session that opened, was prompted, and came back
 * off its checkpoint. `restore` is what a rehydrating `init` applies, so the turn under test has
 * been through the round trip rather than been written by hand.
 */
const reconnectedTail = (): ReadonlyArray<TranscriptItem> => {
	const [opened] = apply(
		{...initialState(CWD), phase: "idle"},
		{type: "start", cwd: CWD, resume: null},
	);
	const [ready] = apply(opened, {type: "started", sessionId: TOOL_SESSION_ID});
	const [prompted] = apply(ready, {type: "prompt", text: PROMPT, key: KEY, timestamp: AT});
	return restore(prompted).transcript.items;
};

/** A `ProcessPorts` wired to nothing, which the publisher swallows as it does in production. */
const noPorts = ProcessPorts.of({
	emit: (port) => Effect.fail(new PortNotWired({node: NodeId.make("test"), port})),
});

/** The `claude-session` row itself, over the real layer with the captured store under it. */
const row = () =>
	claudeSession({
		cwd: CWD,
		layer: ClaudeAiAgent.layer({
			permissionMode: Mode.make("default"),
			modes: CLAUDE_MODES.map((mode) => Mode.make(mode)),
			allowedTools: [],
			sdk: scriptedSdk({opening: [], rows: rows()}).sdk,
			newSessionId: () => TOOL_SESSION_ID,
		}).pipe(Layer.provide(KernelBridge.scripted({}))),
	});

const eventually = (check: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 400 && !check(); attempt += 1) yield* Effect.sleep("5 millis");
	});

const sessionOf = (handle: ProcessHandle): AiAgentSessionState => {
	const state = handle.getState();
	assert.isTrue(isAiAgentSessionState(state), "the process holds no ai-agent-session state");
	return state as AiAgentSessionState;
};

/** Spawn the row, let it open, send one turn, then ask for the page a scroll-back would ask for. */
const promptedThenPaged = Effect.fnUntraced(function* () {
	const declared = row();
	return yield* Effect.gen(function* () {
		const processes = yield* Processes;
		const handle = yield* processes.spawn(declared.id, {
			services: Context.make(ProcessPorts, noPorts),
		});
		yield* eventually(() => sessionOf(handle).phase === "ready");
		yield* handle.dispatch({type: "prompt", text: PROMPT, key: KEY, timestamp: AT});
		yield* eventually(() => sessionOf(handle).transcript.items.length > 0);
		yield* handle.dispatch({type: "page", before: null, limit: 50});
		yield* eventually(() => sessionOf(handle).lastPage !== null);
		return sessionOf(handle);
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Processes.layer.pipe(
				Layer.provideMerge(Checkpoints.layer(memoryStores())),
				Layer.provideMerge(Registry.layer([declared])),
			),
		),
	);
});

describe("the turn a Claude window prompted, after it reconnects and pages", () => {
	it("is one row in the reconnected tail, under the send's own key", () => {
		const tail = reconnectedTail();
		assert.deepStrictEqual(
			tail.map((item) => item.id),
			[promptItemId(KEY)],
			"the reconnected tail does not hold the operator's turn under the send's key",
		);
		assert.strictEqual(
			tail[0]?.kind === "user" ? tail[0].local : false,
			true,
			"the restored turn lost the mark that says no layer has confirmed it",
		);
	});

	it.live("leaves the store's copy of that turn out of the page it is asked for", () =>
		Effect.gen(function* () {
			const state = yield* promptedThenPaged();
			const page = state.lastPage?.items ?? [];

			assert.deepStrictEqual(
				state.transcript.items.map((item) => item.id),
				[promptItemId(KEY)],
				"the live tail does not hold the operator's turn under the send's key",
			);
			assert.isEmpty(
				page.filter((item) => item.kind === "user" && item.text === PROMPT),
				"the page carries the store's copy of a turn the tail already holds",
			);
			assert.lengthOf(
				[...page, ...state.transcript.items].filter(
					(item) => item.kind === "user" && item.text === PROMPT,
				),
				1,
				"one prompt reaches the window as more than one row",
			);
		}),
	);

	it.live("keeps every other stored row, so the page is not thinned to close the duplicate", () =>
		Effect.gen(function* () {
			const state = yield* promptedThenPaged();
			const page = state.lastPage?.items ?? [];
			assert.isNotEmpty(page, "the whole page went with the turn that was dropped from it");
			assert.deepStrictEqual(
				page.map((item) => item.kind),
				["tool", "assistant"],
				"the page lost a row that was never the operator's turn",
			);
		}),
	);
});
