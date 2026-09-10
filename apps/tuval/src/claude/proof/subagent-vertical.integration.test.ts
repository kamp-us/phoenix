/**
 * @vitest-environment jsdom
 *
 * The running-subagent list on the real Claude row, end to end (#8408).
 *
 * One run drives the whole arc: a Claude session opened from the real picker, prompted, and fed the
 * captured frames of a real turn that spawned two overlapping workers
 * (`../history/fixtures/two-subagent-turn.json`). The substitution is the SDK seam and nothing else
 * — `ClaudeAiAgent` does the mapping, the core folds the slots, the transport carries them and the
 * shipped `ChatWindow` draws them — so what this proves is the vertical, not a stand-in for it
 * (`./subagent-desk.ts` says why `./desk.ts`'s scripted *layer* could not).
 *
 * Five claims, in the order an operator meets them:
 *
 * 1. the list is there with both workers on it while they run;
 * 2. no row of either worker reaches the agent's own window;
 * 3. picking one swaps that worker's transcript in, with the list still above it;
 * 4. coming back restores main;
 * 5. a worker that finishes while its view is open leaves the view up, saying finished.
 *
 * The state claims read the transport; the window claims read the DOM, because "what is on screen"
 * is what the flag was built to change and no process state can answer it. Both halves are the same
 * run: the rendered window is bound to the same live process the state assertions read.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {act, fireEvent, render} from "@testing-library/react";
import {Effect, type FileSystem, Queue, Schema, type Scope, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import type {ReactElement} from "react";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {boot, projectDir} from "../../boot.ts";
import {ProcessId} from "../../process/process.ts";
import {type ChatView, initialChatView} from "../../shell/chat/index.ts";
import {
	activeWorkspace,
	type ShellMsg,
	type ShellState,
	windowIds,
} from "../../shell/core/index.ts";
import {serveDesk} from "../../shell/host/index.ts";
import {defaultPrefixTable} from "../../shell/keys/index.ts";
import {windows} from "../../shell/layout/index.ts";
import {
	mountPicker,
	type PickerEntries,
	type PickerView,
	pickerKey,
	readEntries,
} from "../../shell/picker/index.ts";
import {shellNode} from "../../shell/program.ts";
import {attach} from "../../shell/transport/client.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import type {ProcessView, WindowHost} from "../../shell/window/index.ts";
import {WindowId} from "../../shell/window/index.ts";
import {CLAUDE_SESSION_PROGRAM} from "../renderer-ref.ts";
import {claudeChatWindow} from "../window/index.ts";
import {PROJECT_ROOT_VAR} from "./names.ts";
import {
	CAPTURE_SESSION_ID,
	captureFrames,
	captureHandle,
	finishFrameOf,
	spawnCallIds,
} from "./two-subagents.ts";

installDomShims();

/**
 * jsdom lays nothing out, so without a box the virtualizer clamps every offset to zero and renders
 * one row — the same shim `../../shell/chat/subagent-view.unit.test.tsx` carries, and for the same
 * reason. On the prototype and before the first render, because a box stubbed after mount is stubbed
 * after the opening layout effect has already resolved against a max scroll of 0.
 */
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
	configurable: true,
	get(this: HTMLElement): number {
		return this.classList.contains("tuval-chat-transcript") ? 100_000 : 0;
	},
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
	configurable: true,
	get(this: HTMLElement): number {
		return this.classList.contains("tuval-chat-transcript") ? 600 : 0;
	},
});

/**
 * The port jsdom's document is served on, which is the `Origin` its `WebSocket` puts on the upgrade.
 *
 * The desk admits only the loopback origins of the ports it knows about, so a page-realm socket is
 * refused until its port is admitted — the same fence a real browser meets, and the same seam the
 * launch uses once Vite has listened (`admitLoopbackPort`, #7560). Reading it off `location` rather
 * than writing 3000 down: the number is Vitest's environment option, not this proof's.
 */
const pageOrigin = (): number => {
	const port = Number.parseInt(globalThis.location.port, 10);
	return Number.isNaN(port) ? 80 : port;
};

const TIMEOUT = 180_000;
const PROMPT = "read both files through two workers";
const PROMPT_KEY = "k1";

// `import.meta.dirname` rather than `fileURLToPath(new URL(…))`: under jsdom the global `URL` is
// whatwg-url's, and `node:url` refuses an instance that is not its own ("The URL must be of scheme
// file", however plainly the href says `file:`).
const configModule = join(import.meta.dirname, "subagent-desk.ts");
const shellProcessId = ProcessId.make(shellNode);

const tempDirs: string[] = [];

const freshProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-subagent-vertical-")));
	tempDirs.push(dir);
	mkdirSync(projectDir(dir));
	process.env[PROJECT_ROOT_VAR] = dir;
	return dir;
};

const bootDesk = Effect.fn("subagentVertical.bootDesk")(function* (project: string) {
	const booted = yield* boot({global: configModule, project});
	const server = yield* serveDesk({kernel: booted.kernel, port: 0, table: defaultPrefixTable});
	const entries = yield* readEntries.pipe(Effect.provideContext(booted.kernel));
	return {booted, server, entries};
});

const watch = Effect.fn("subagentVertical.watch")(function* <A>(stream: Stream.Stream<A>) {
	const seen = yield* Queue.unbounded<A>();
	yield* Effect.forkScoped(
		Stream.runForEach(stream, (value) => Effect.asVoid(Queue.offer(seen, value))),
	);
	return seen;
});

/** The next published value satisfying `predicate`; the last one that did arrive names the failure. */
const where = <A>(seen: Queue.Queue<A>, what: string, predicate: (value: A) => boolean) => {
	let last: A | null = null;
	return Effect.gen(function* () {
		while (true) {
			const value = yield* Queue.take(seen);
			last = value;
			if (predicate(value)) return value;
		}
	}).pipe(
		Effect.timeout("60 seconds"),
		Effect.catchTag("TimeoutError", () =>
			Effect.die(new Error(`nothing where ${what}; last seen: ${JSON.stringify(last)}`)),
		),
	);
};

const liveWhere = <S>(
	seen: Queue.Queue<ProcessView<S>>,
	what: string,
	predicate: (state: S) => boolean,
): Effect.Effect<S> =>
	where(seen, what, (view) => view._tag === "Live" && predicate(view.state)).pipe(
		Effect.map((view) => (view as {readonly state: S}).state),
	);

const workspaceOf = (state: ShellState) => {
	const workspace = activeWorkspace(state);
	assert.isDefined(workspace, "the desk has an active workspace");
	return workspace;
};

const boundProcess = (state: ShellState, windowId: string): string | null => {
	for (const window of windows(workspaceOf(state).layout.root)) {
		if (window.id === windowId) return window.processId;
	}
	return null;
};

interface Desk {
	readonly send: (msg: ShellMsg) => Effect.Effect<void>;
	readonly seen: Queue.Queue<ProcessView<ShellState>>;
}

const attachDesk = Effect.fn("subagentVertical.attachDesk")(function* (url: string) {
	const page = yield* attach(url).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal));
	const shell = yield* page.attachProcess<ShellState, ShellMsg>(shellProcessId);
	const seen = yield* watch(shell.readProcess);
	const desk: Desk = {send: (msg) => Effect.asVoid(shell.dispatch(msg)), seen};
	return {page, desk};
});

/** The picker's own answer to a key, as the browser surface dispatches it. */
const pickerPress = (
	windowId: string,
	entries: PickerEntries,
	view: PickerView,
	spelling: string,
): ShellMsg | null => {
	const answer = pickerKey(windowId as never, entries, view, spelling);
	switch (answer._tag) {
		case "Moved":
		case "Cleared":
		case "Filtering":
			return {type: "window.setView", windowId: windowId as never, view: answer.view};
		case "Chose":
			return answer.intent._tag === "OpenProgram"
				? {type: "window.open", windowId: windowId as never, programId: answer.intent.programId}
				: {type: "window.attach", windowId: windowId as never, processId: answer.intent.processId};
		case "Ignored":
			return null;
	}
};

const openFromThePicker = Effect.fn("subagentVertical.openFromThePicker")(function* (
	desk: Desk,
	entries: PickerEntries,
	windowId: string,
	programId: string,
) {
	const at = entries.programs.findIndex((entry) => entry.programId === programId);
	assert.isAtLeast(at, 0, `the picker offers the ${programId} program`);
	let view = mountPicker();
	for (let step = 0; step < at; step += 1) {
		const moved = pickerPress(windowId, entries, view, "j");
		assert.isNotNull(moved, "the picker moved its highlight");
		view = {...view, cursor: step + 1, refusal: null};
		yield* desk.send(moved as ShellMsg);
	}
	const chosen = pickerPress(windowId, entries, view, "<enter>");
	assert.isNotNull(chosen, "the picker chose the highlighted row");
	yield* desk.send(chosen as ShellMsg);
	const opened = yield* liveWhere(
		desk.seen,
		`the window bound to a ${programId} process`,
		(state) => boundProcess(state, windowId) !== null,
	);
	return boundProcess(opened, windowId) as string;
});

const runningSlots = (state: AiAgentSessionState): ReadonlyArray<string> =>
	Object.values(state.subagents)
		.filter((slot) => slot.status === "running")
		.map((slot) => slot.id as string);

/** Hand the layer's query the next frames of the capture, so the run advances to one moment. */
const deliver = (frames: ReadonlyArray<SDKMessage>, upTo: number): void => {
	const handle = captureHandle();
	const query = handle.sdk.opened[0];
	assert.isDefined(query, "the layer never opened a query; nothing can be replayed into it");
	for (let at = handle.delivered; at < upTo; at += 1) {
		query.say(frames[at] as SDKMessage);
	}
	handle.delivered = upTo;
};

/**
 * The opening line of every reply in one worker's slot — the discriminator two of the claims read.
 *
 * The worker's *replies* rather than its whole slot, because a worker's inbound turn is also the
 * spawning call's `prompt` input, which the agent's own tool row legitimately carries. One line
 * rather than a whole reply, because a reply renders as markdown: the fences and blank lines the
 * slot holds are not in the DOM the operator reads.
 */
const repliesOf = (state: AiAgentSessionState, id: string): ReadonlyArray<string> =>
	(state.subagents[id]?.items ?? []).flatMap((item) => {
		if (item.kind !== "assistant") return [];
		const line = item.text.split("\n").find((one) => one.trim().length > 0);
		return line === undefined ? [] : [line.trim()];
	});

interface Screen {
	readonly rows: () => ReadonlyArray<HTMLElement>;
	readonly text: () => string;
	/** The subagent whose transcript the swapped-in view is showing, or `null` on main. */
	readonly showing: () => string | null;
	readonly list: () => HTMLElement | null;
	/** Every line of the list, including the way back and the "more" row. */
	readonly picks: () => ReadonlyArray<HTMLButtonElement>;
	/** The worker lines alone: a line with a type field on it is a row and nothing else is. */
	readonly workers: () => ReadonlyArray<HTMLButtonElement>;
	readonly more: () => HTMLElement | null;
	/** Every spawning call offering to reveal the rows under it. On the agent window there are none. */
	readonly folds: () => ReadonlyArray<HTMLElement>;
	readonly current: () => string | null;
	readonly end: () => HTMLElement | null;
}

const screenOf = (root: ParentNode): Screen => ({
	rows: () => Array.from(root.querySelectorAll<HTMLElement>(".tuval-chat-row")),
	showing: () => root.querySelector<HTMLElement>(".tuval-chat-transcript")?.dataset.view ?? null,
	text: () => root.querySelector<HTMLElement>(".tuval-chat-spacer")?.textContent ?? "",
	list: () => root.querySelector<HTMLElement>(".tuval-chat-subagents"),
	picks: () => Array.from(root.querySelectorAll<HTMLButtonElement>(".tuval-chat-subagent-pick")),
	workers: () =>
		Array.from(
			root.querySelectorAll<HTMLButtonElement>(
				'.tuval-chat-subagent-pick:has([data-field="type"])',
			),
		),
	more: () => root.querySelector<HTMLElement>(".tuval-chat-subagent-more"),
	folds: () => Array.from(root.querySelectorAll<HTMLElement>(".tuval-chat-tool-fold")),
	current: () =>
		root.querySelector<HTMLElement>('.tuval-chat-subagent-pick[aria-current="true"]')
			?.textContent ?? null,
	end: () => root.querySelector<HTMLElement>(".tuval-chat-subagent-end"),
});

/** A rendered claim that never arrived, or a React act that threw — both are this proof failing. */
class WindowNeverShowed extends Schema.TaggedError<WindowNeverShowed>()(
	"tuval/subagent-vertical-proof/WindowNeverShowed",
	{detail: Schema.String},
) {
	override get message(): string {
		return this.detail;
	}
}

const acted = (detail: string, body: () => Promise<void>): Effect.Effect<void> =>
	Effect.tryPromise({
		try: body,
		catch: (cause) => new WindowNeverShowed({detail: `${detail}: ${String(cause)}`}),
	}).pipe(Effect.orDie);

/**
 * Let React catch up with the transport. The window's state arrives on a stream the renderer reads
 * on its own fiber, so there is no promise to await — the settle is a bounded poll on what is drawn,
 * and its failure names the claim that never landed.
 */
const settle = (what: string, until: () => boolean): Effect.Effect<void> =>
	acted(`waiting for ${what}`, async () => {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			await act(async () => {
				await new Promise((resume) => setTimeout(resume, 25));
			});
			if (until()) return;
		}
		throw new WindowNeverShowed({detail: `the window never showed ${what}`});
	});

const click = (button: HTMLButtonElement): Effect.Effect<void> =>
	acted("clicking a list row", async () => {
		await act(async () => {
			button.click();
		});
	});

const pressEscape = (list: HTMLElement): Effect.Effect<void> =>
	acted("pressing Escape on the list", async () => {
		await act(async () => {
			fireEvent.keyDown(list, {key: "Escape"});
		});
	});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

describe("the running-subagent list on a real Claude row", () => {
	it.live(
		"lists both workers while they run, keeps their rows out of the agent window, swaps one in and back, and holds an open view when its worker finishes",
		() =>
			run(
				Effect.gen(function* () {
					const frames = captureFrames();
					const spawns = spawnCallIds(frames);
					assert.lengthOf(spawns, 2, "the capture does not spawn exactly two workers");
					const [first, second] = spawns as readonly [string, string];
					const firstEnds = finishFrameOf(frames, first);
					const secondEnds = finishFrameOf(frames, second);
					assert.isAtLeast(firstEnds, 0, "the capture never finishes the first worker");
					assert.isAtLeast(secondEnds, 0, "the capture never finishes the second worker");
					assert.isBelow(
						firstEnds,
						secondEnds,
						"the two workers finish on one frame; nothing can finish under an open view",
					);

					const project = freshProject();
					const app = yield* bootDesk(project);
					app.server.admitLoopbackPort(pageOrigin());
					const {page, desk} = yield* attachDesk(app.server.launchUrl);

					const fresh = yield* liveWhere(desk.seen, "the first snapshot", () => true);
					const only = windowIds(workspaceOf(fresh))[0] as string;
					assert.isDefined(only);

					const agentId = yield* openFromThePicker(desk, app.entries, only, CLAUDE_SESSION_PROGRAM);
					const process = yield* page.attachProcess<AiAgentSessionState, AiAgentSessionMsg>(
						ProcessId.make(agentId),
					);
					const session = yield* watch(process.readProcess);
					const ready = yield* liveWhere(
						session,
						"the session to open",
						(state) => state.phase === "ready" && state.sessionId !== null,
					);
					assert.strictEqual(
						ready.sessionId,
						CAPTURE_SESSION_ID,
						"the layer opened a session other than the one the capture is of",
					);

					// The window is bound to this live process and writes its view slot through the real
					// shell, which is the path a swap takes on the desk.
					let slot: ChatView = initialChatView;
					const host: WindowHost<AiAgentSessionState, AiAgentSessionMsg, ChatView> = {
						windowId: WindowId.make(only),
						processId: ProcessId.make(agentId),
						readProcess: process.readProcess,
						dispatch: process.dispatch,
						view: () => slot,
						setView: (next) =>
							Effect.flatMap(
								Effect.sync(() => {
									slot = next;
								}),
								() =>
									desk.send({
										type: "window.setView",
										windowId: only as never,
										view: next,
									}),
							),
					};
					const rendered = render(
						claudeChatWindow({subagentList: true, scrollCommitMs: 0}).render(host) as ReactElement,
					);
					const screen = screenOf(rendered.container);

					yield* Effect.addFinalizer(() => Effect.sync(() => rendered.unmount()));

					yield* Effect.asVoid(
						process.dispatch({
							type: "prompt",
							text: PROMPT,
							key: PROMPT_KEY,
							timestamp: Date.now(),
						}),
					);

					// Claim 1: both workers on the list while they run. The frames stop one short of the
					// first worker's own `tool_result`, which is the moment both are still writing.
					deliver(frames, firstEnds);
					// Both slots open *and* the first one already writing: the assertion below needs a
					// line only the worker's slot can hold, and the first state with two slots in it is
					// the one where neither has written yet.
					const both = yield* liveWhere(
						session,
						"both workers to be running with the first one writing",
						(state) => runningSlots(state).length === 2 && repliesOf(state, first).length > 0,
					);
					assert.deepStrictEqual(
						runningSlots(both).toSorted(),
						[first, second].toSorted(),
						"the two slots are not the two spawning calls the capture made",
					);
					yield* settle("two rows on the list", () => screen.workers().length === 2);
					assert.isNotNull(screen.list(), "the list is not on screen while two workers run");
					assert.isNull(
						screen.more(),
						"the list collapsed a worker into the “more” row with only two running",
					);
					assert.deepStrictEqual(
						screen
							.workers()
							.map((row) => row.querySelector('[data-field="type"]')?.textContent ?? ""),
						["Explore", "Explore"],
						"the two rows do not name the worker type the capture spawned",
					);

					// Claim 2: no row of either worker in the agent's own window. Counted by kind rather
					// than matched by text, because the spawning `Agent` call's own tool result carries
					// the worker's summary and that row is the agent's, not the worker's.
					const spoken = repliesOf(both, first);
					assert.isNotEmpty(spoken, "the first worker has written nothing yet to look for");
					const kindsIn = (state: AiAgentSessionState, kind: string): number =>
						state.transcript.items.filter((item) => item.kind === kind).length;
					assert.isAtLeast(
						kindsIn(both, "user"),
						3,
						"the tail holds no worker turns, so dropping them from the window proves nothing",
					);
					assert.isAtLeast(kindsIn(both, "assistant"), 1, "the tail holds no worker reply");
					const drawn = (of: string): number =>
						screen.rows().filter((row) => row.dataset.kind === of).length;
					assert.strictEqual(
						drawn("user"),
						1,
						"a worker's own turn reached the agent window; only the operator's prompt belongs there",
					);
					assert.strictEqual(
						drawn("assistant"),
						0,
						"a worker's own reply reached the agent window",
					);
					// Dropped, not folded: a spawning call offering to reveal its rows is a window that
					// still holds them, one click away (#8405's containment).
					assert.lengthOf(
						screen.folds(),
						0,
						"a spawning call still offers to unfold the worker's rows into the agent window",
					);
					assert.isNull(screen.showing(), "the window opened on a subagent rather than on main");
					const mainText = screen.text();

					// Claim 3: picking the first worker swaps its transcript in, list still above.
					yield* click(screen.picks()[0] as HTMLButtonElement);
					yield* settle("the first worker's transcript", () => screen.showing() === first);
					const insideText = screen.text();
					for (const line of spoken) {
						assert.include(
							insideText,
							line,
							"the swapped-in view is missing a row the worker wrote",
						);
					}
					assert.isNotNull(
						screen.list(),
						"the list left the screen inside a subagent's view; there is no way back",
					);
					assert.include(
						screen.current() ?? "",
						"Explore",
						"the list does not mark the worker whose transcript is showing",
					);

					// Claim 4: back to main, on the transcript it was left on.
					yield* pressEscape(screen.list() as HTMLElement);
					yield* settle("main again", () => screen.showing() === null);
					assert.strictEqual(
						screen.text(),
						mainText,
						"coming back from a worker did not restore the agent's own transcript",
					);

					// Claim 5: the first worker finishes while its view is open. The view stays up and
					// says so; the second worker is still running, so the list is still a list.
					yield* click(screen.picks()[0] as HTMLButtonElement);
					yield* settle("the worker's view again", () => screen.showing() === first);
					deliver(frames, firstEnds + 1);
					const finished = yield* liveWhere(
						session,
						"the first worker to finish",
						(state) => state.subagents[first]?.status === "finished",
					);
					assert.deepStrictEqual(
						runningSlots(finished),
						[second],
						"finishing one worker moved the other",
					);
					yield* settle(
						"the finished mark under the open view",
						() => screen.end()?.dataset.status === "finished",
					);
					assert.strictEqual(
						screen.showing(),
						first,
						"the view closed itself when its worker finished",
					);
					for (const line of spoken) {
						assert.include(
							screen.text(),
							line,
							"the finished worker's rows went out from under the operator reading them",
						);
					}
					assert.include(
						screen.end()?.textContent ?? "",
						"finished",
						"the open view does not say its worker has stopped",
					);
					assert.isNotNull(screen.list(), "the way back left with the worker that finished");

					// The slot the window wrote is the slot the shell holds: the swap went through the
					// real view-slot path and not through a value this test kept to itself.
					const held = yield* liveWhere(
						desk.seen,
						"the shell to hold this window's view slot",
						(state) =>
							(state.views as Record<string, {viewing?: {id?: string}} | undefined>)[only]?.viewing
								?.id === first,
					);
					assert.isDefined(held);
				}),
			),
		TIMEOUT,
	);
});

process.on("exit", () => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
